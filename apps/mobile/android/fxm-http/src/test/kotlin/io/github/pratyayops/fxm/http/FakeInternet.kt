package io.github.pratyayops.fxm.http

import java.io.Closeable
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertNotNull
import org.junit.Assert.fail

/** The browser agent tests give the policy. */
const val BROWSER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36"

/**
 * An offline stand-in for the internet: one HTTPS [MockWebServer] that answers for every host
 * name, with a certificate from a test authority that only [client]s trust. Every host resolves
 * to the loopback address and every connection reaches the server's port, so URLs keep their
 * real hosts and the default port, and FXM's real [RequestPolicy] applies unchanged.
 */
class FakeInternet : Closeable {
  private val authority = HeldCertificate.Builder().certificateAuthority(0).build()
  private val certificate =
    HeldCertificate.Builder()
      .signedBy(authority)
      .apply { for (name in NAMES) addSubjectAlternativeName(name) }
      .build()

  val server =
    MockWebServer().apply {
      useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory())
      protocols = listOf(Protocol.HTTP_1_1)
      start()
    }

  /** Hosts the user approved, for the policy of [client]. */
  val approved = InMemoryApprovedHosts()

  /** FXM's policy over [approved], with [BROWSER_AGENT]. */
  val policy = RequestPolicy(approved, { BROWSER_AGENT })

  /** A client built like the shared one ([FxmHttp.newClient]), connected to the fake internet. */
  fun client(configure: OkHttpClient.Builder.() -> Unit = {}): OkHttpClient {
    val trust = HandshakeCertificates.Builder().addTrustedCertificate(authority.certificate).build()
    return FxmHttp.newClient(policy) {
      dns(Dns { hostname -> listOf(InetAddress.getByAddress(hostname, byteArrayOf(127, 0, 0, 1))) })
      socketFactory(LoopbackSocketFactory(server.port))
      sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
      configure()
    }
  }

  /** The next request the server received. */
  fun take(): RecordedRequest =
    server.takeRequest(10, TimeUnit.SECONDS).also { assertNotNull("no request arrived", it) }!!

  override fun close() = server.close()

  /** Connects every socket to the server, whatever address and port it was meant for. */
  private class LoopbackSocketFactory(private val serverPort: Int) : SocketFactory() {
    // Not `port`: inside a Socket, that name is the socket's own (still unconnected) port.
    override fun createSocket(): Socket =
      object : Socket() {
        override fun connect(endpoint: SocketAddress, timeout: Int) =
          super.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), serverPort), timeout)
      }

    override fun createSocket(host: String, port: Int): Socket = unsupported()

    override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket =
      unsupported()

    override fun createSocket(host: InetAddress, port: Int): Socket = unsupported()

    override fun createSocket(
      address: InetAddress,
      port: Int,
      local: InetAddress,
      localPort: Int,
    ): Socket = unsupported()

    private fun unsupported(): Nothing = throw UnsupportedOperationException("OkHttp connects itself")
  }

  companion object {
    /** The names the server's certificate covers. */
    val NAMES =
      listOf(
        "music.youtube.com",
        "www.youtube.com",
        "youtubei.googleapis.com",
        "*.googlevideo.com",
        "open.spotify.com",
        "api-partner.spotify.com",
        "spclient.wg.spotify.com",
        "lrclib.net",
        "musicbrainz.org",
        "www.last.fm",
        "*.example.org",
        "example.org",
      )
  }
}

/** A [Reply] a test waits on. */
class Recorded<T> : Reply<T> {
  private val outcome = CompletableFuture<Result<T>>()

  override fun success(value: T) {
    outcome.complete(Result.success(value))
  }

  override fun failure(error: BridgeError) {
    outcome.complete(Result.failure(BridgeFailure(error)))
  }

  /** The value, failing the test on an error. */
  fun value(): T =
    outcome.get(15, TimeUnit.SECONDS).getOrElse { fail("expected success, got $it"); throw it }

  /** The error, failing the test on success. */
  fun error(): BridgeError {
    val result = outcome.get(15, TimeUnit.SECONDS)
    val failure = result.exceptionOrNull() as? BridgeFailure
    if (failure == null) fail("expected an error, got ${result.getOrNull()}")
    return failure!!.error
  }

  /** Whether an outcome arrived within [millis]. */
  fun isDone(millis: Long = 0): Boolean =
    runCatching { outcome.get(millis, TimeUnit.MILLISECONDS) }.isSuccess

  class BridgeFailure(val error: BridgeError) : Exception(error.toString())
}
