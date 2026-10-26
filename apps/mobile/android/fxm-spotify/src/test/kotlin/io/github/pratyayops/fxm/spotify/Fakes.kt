package io.github.pratyayops.fxm.spotify

import io.github.pratyayops.fxm.http.FxmHttp
import io.github.pratyayops.fxm.http.InMemoryApprovedHosts
import io.github.pratyayops.fxm.http.RequestPolicy
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.SocketFactory
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertNotNull

/** The browser agent the tests' policy gives requests. */
const val BROWSER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/141.0.0.0 Mobile Safari/537.36"

/** A made-up login cookie, never a real one. */
const val COOKIE = "AQ-made-up-login-for-the-tests_0123456789"

/**
 * An offline Spotify: one HTTPS [MockWebServer] that answers for Spotify's host names, with a
 * certificate from a test authority only [client]s trust. Hosts keep their real names and the
 * default port, so FXM's real [RequestPolicy] applies unchanged, as in fxm-http's tests.
 */
class FakeSpotify : Closeable {
  private val authority = HeldCertificate.Builder().certificateAuthority(0).build()
  private val certificate =
    HeldCertificate.Builder()
      .signedBy(authority)
      .apply {
        for (name in listOf("open.spotify.com", "api-partner.spotify.com")) {
          addSubjectAlternativeName(name)
        }
      }
      .build()

  val server =
    MockWebServer().apply {
      useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory())
      protocols = listOf(Protocol.HTTP_1_1)
      start()
    }

  /** A client built like fxm-http's shared one, without a cookie jar, reaching [server]. */
  val client: OkHttpClient = run {
    val trust = HandshakeCertificates.Builder().addTrustedCertificate(authority.certificate).build()
    FxmHttp.newClient(RequestPolicy(InMemoryApprovedHosts(), { BROWSER_AGENT })) {
      dns(Dns { host -> listOf(InetAddress.getByAddress(host, byteArrayOf(127, 0, 0, 1))) })
      socketFactory(LoopbackSocketFactory(server.port))
      sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
    }
  }

  /** The next request the server received. */
  fun take(): RecordedRequest =
    server.takeRequest(10, TimeUnit.SECONDS).also { assertNotNull("no request arrived", it) }!!

  override fun close() = server.close()

  /** Connects every socket to [serverPort], whatever address and port it was meant for. */
  private class LoopbackSocketFactory(private val serverPort: Int) : SocketFactory() {
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
}

/**
 * A [SessionCipher] with an AES-GCM key in memory, standing in for the Android Keystore, which a
 * test can make fail as the keystore does: each queued failure is thrown once, by the next call.
 */
class MemoryCipher : SessionCipher {
  var key: SecretKey? = newKey()
  var forgotten = 0

  /** What the next [seal] calls throw, one each. */
  val sealFailures = ArrayDeque<Exception>()

  /** What the next [open] calls throw, one each. */
  val openFailures = ArrayDeque<Exception>()

  /** What [forget] throws, every time, while set. */
  var forgetFailure: Exception? = null

  override fun seal(plain: ByteArray, aad: ByteArray): Sealed {
    sealFailures.removeFirstOrNull()?.let { throw it }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key ?: newKey().also { key = it })
    cipher.updateAAD(aad)
    val data = cipher.doFinal(plain)
    return Sealed(cipher.iv, data)
  }

  override fun open(sealed: Sealed, aad: ByteArray): ByteArray {
    openFailures.removeFirstOrNull()?.let { throw it }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      key ?: throw SessionKeyGone("no key"),
      GCMParameterSpec(128, sealed.iv),
    )
    cipher.updateAAD(aad)
    return cipher.doFinal(sealed.data)
  }

  override fun forget() {
    forgetFailure?.let { throw it }
    key = null
    forgotten += 1
  }

  companion object {
    fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
  }
}

/** A [SessionFile] in memory, whose deleting a test can make fail. */
class MemoryFile(var text: String? = null) : SessionFile {
  /** What [delete] throws, every time, while set: the text stays. */
  var deleteFailure: IOException? = null

  override fun read(): String? = text

  override fun write(text: String) {
    this.text = text
  }

  override fun delete() {
    deleteFailure?.let { throw it }
    text = null
  }
}
