package io.github.pratyayops.fxm.downloads

import android.net.Uri
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient
import java.io.ByteArrayInputStream

/**
 * The app WebView's client (stage 6.4): Capacitor's own ([BridgeWebViewClient]), except that a
 * request for a device file that [DeviceFiles] doesn't allow gets a 404 before Capacitor's local
 * server can open it. MainActivity installs it once the bridge exists ([install]). Service
 * workers' requests, which skip the WebView's client, get the same rule.
 */
class DeviceFileFilter private constructor(bridge: Bridge, private val files: DeviceFiles) : BridgeWebViewClient(bridge) {
  override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
    if (request != null && !files.webViewAllows(requestOf(request.url))) notFound() else super.shouldInterceptRequest(view, request)

  companion object {
    /**
     * Makes [bridge]'s WebView, and the service workers Capacitor answers for, refuse every
     * device file but FXM's downloads and MediaStore's songs.
     */
    @JvmStatic
    fun install(bridge: Bridge) {
      val files = DeviceFiles.of(bridge.context)
      bridge.setWebViewClient(DeviceFileFilter(bridge, files))
      // Capacitor answers service workers from its local server too, unless told not to.
      if (bridge.config.isResolveServiceWorkerRequests) {
        ServiceWorkerController.getInstance().setServiceWorkerClient(
          object : ServiceWorkerClient() {
            override fun shouldInterceptRequest(request: WebResourceRequest?): WebResourceResponse? {
              if (request == null) return null
              return if (files.webViewAllows(requestOf(request.url))) bridge.localServer.shouldInterceptRequest(request) else notFound()
            }
          },
        )
      }
    }

    private fun requestOf(uri: Uri) = WebViewRequest(uri.toString(), uri.scheme, uri.host, uri.port, uri.path)

    private fun notFound() =
      WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
  }
}
