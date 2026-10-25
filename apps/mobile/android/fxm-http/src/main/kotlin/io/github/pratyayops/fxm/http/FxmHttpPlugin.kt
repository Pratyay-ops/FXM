package io.github.pratyayops.fxm.http

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

/**
 * `FxmHttp`: the web app's network access on Android, the native side of
 * packages/platform/src/android-http.ts. Requests go through [FxmHttp]'s shared OkHttp client
 * with FXM's network rules; bodies stream in base64 chunks that JavaScript pulls with [read].
 * Capacitor runs plugin methods on one thread, so nothing here blocks it: OkHttp's dispatcher and
 * a worker pool do the waiting. [getContext] is the activity; [FxmHttp] keeps only the
 * application context.
 */
@CapacitorPlugin(name = BridgeProtocol.PLUGIN_NAME)
class FxmHttpPlugin : Plugin() {
  private lateinit var exchanges: Exchanges
  private lateinit var approvedHosts: ApprovedHosts
  private lateinit var approvals: HostApprovals
  private var reaper: ScheduledExecutorService? = null

  override fun load() {
    config.getString("userAgent")?.takeIf { it.isNotBlank() }?.let {
      FxmHttp.userAgentOverride = it
    }
    FxmHttp.rememberWebViewUserAgent(context)
    exchanges = Exchanges(FxmHttp.client(context), WORKERS)
    approvedHosts = FxmHttp.approvedHosts(context)
    approvals = HostApprovals(approvedHosts, DialogHostApprover { activity })
    reaper =
      Executors.newSingleThreadScheduledExecutor(threads("fxm-http-reaper")).also {
        it.scheduleWithFixedDelay({ exchanges.reap() }, REAP_SECONDS, REAP_SECONDS, TimeUnit.SECONDS)
      }
  }

  override fun handleOnDestroy() {
    reaper?.shutdownNow()
    exchanges.abortAll()
  }

  /** Starts a request; resolves with its head once the response headers are in. */
  @PluginMethod
  fun request(call: PluginCall) {
    val (id, request) =
      try {
        BridgeMessages.request(call.data)
      } catch (e: FxmHttpException) {
        return reject(call, BridgeError(e.code, e.message ?: e.code.name))
      }
    exchanges.start(
      id,
      request,
      object : Reply<ResponseHead> {
        override fun success(value: ResponseHead) = call.resolve(js(BridgeMessages.head(id, value)))

        override fun failure(error: BridgeError) = reject(call, error)
      },
    )
  }

  /** Resolves with the next chunk of a response body. */
  @PluginMethod
  fun read(call: PluginCall) {
    val id = idOf(call) ?: return
    exchanges.read(
      id,
      BridgeMessages.maxBytes(call.data),
      object : Reply<Chunk> {
        override fun success(value: Chunk) = call.resolve(js(BridgeMessages.chunk(value)))

        override fun failure(error: BridgeError) = reject(call, error)
      },
    )
  }

  /** Cancels a request or drops its response. */
  @PluginMethod
  fun abort(call: PluginCall) {
    val id = idOf(call) ?: return
    exchanges.abort(id)
    call.resolve()
  }

  /** Asks the user to approve hosts in a system dialog; resolves with those approved. */
  @PluginMethod
  fun approveHosts(call: PluginCall) {
    val hosts = hostsOf(call) ?: return
    approvals.approve(
      hosts,
      { approved -> call.resolve(js(BridgeMessages.hostList("approved", approved))) },
      { error -> reject(call, error) },
    )
  }

  /** Resolves with the hosts the user approved. */
  @PluginMethod
  fun approvedHosts(call: PluginCall) {
    call.resolve(js(BridgeMessages.hostList("hosts", approvedHosts.list())))
  }

  /** Withdraws approvals; resolves with the hosts still approved. */
  @PluginMethod
  fun revokeHosts(call: PluginCall) {
    val hosts = hostsOf(call) ?: return
    approvedHosts.remove(hosts)
    call.resolve(js(BridgeMessages.hostList("hosts", approvedHosts.list())))
  }

  private fun idOf(call: PluginCall): String? =
    try {
      BridgeMessages.id(call.data)
    } catch (e: FxmHttpException) {
      reject(call, BridgeError(e.code, e.message ?: e.code.name))
      null
    }

  private fun hostsOf(call: PluginCall): List<String>? =
    try {
      BridgeMessages.hosts(call.data)
    } catch (e: FxmHttpException) {
      reject(call, BridgeError(e.code, e.message ?: e.code.name))
      null
    }

  /** Rejects with the error's code, and the refused host as `data.host` when it names one. */
  private fun reject(call: PluginCall, error: BridgeError) {
    val data = error.host?.let { JSObject().put("host", it) }
    call.reject(error.message, error.code.name, null, data)
  }

  private fun js(json: JSONObject): JSObject = JSObject.fromJSONObject(json)

  companion object {
    private const val REAP_SECONDS = 15L

    /** Runs response pumps and waiting reads: one thread each, kept for a minute when idle. */
    private val WORKERS: ExecutorService = Executors.newCachedThreadPool(threads("fxm-http"))

    private fun threads(name: String): ThreadFactory {
      val count = AtomicInteger()
      return ThreadFactory { runnable ->
        Thread(runnable, "$name-${count.incrementAndGet()}").apply { isDaemon = true }
      }
    }
  }
}
