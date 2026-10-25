package io.github.pratyayops.fxm.player

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler

/**
 * Follows the device's default network with Android's network callbacks, which keep arriving
 * while the screen is off, and reports the changes [NetworkChanges] counts on [handler]'s thread.
 */
class NetworkWatcher(
  context: Context,
  private val handler: Handler,
  private val listener: Listener,
) {
  interface Listener {
    /** The default network changed; [cellular] says whether it is mobile data. */
    fun onNetworkChanged(cellular: Boolean)

    /** The default network is mobile data now, or no longer. */
    fun onCellularChanged(cellular: Boolean)
  }

  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val changes = NetworkChanges()
  private var cellular = false
  private var registered = false

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        val key = network.toString()
        handler.post { if (changes.onAvailable(key)) listener.onNetworkChanged(cellular) }
      }

      override fun onLost(network: Network) {
        val key = network.toString()
        handler.post { if (changes.onLost(key)) listener.onNetworkChanged(false) }
      }

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        val mobile = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
        handler.post {
          if (mobile != cellular) {
            cellular = mobile
            listener.onCellularChanged(mobile)
          }
        }
      }

      override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
        val key = network.toString()
        val addresses = linkProperties.linkAddresses.mapNotNull { it.address.hostAddress }.toSet()
        handler.post { if (changes.onAddresses(key, addresses)) listener.onNetworkChanged(cellular) }
      }
    }

  fun start() {
    if (registered || connectivity == null) return
    registered = runCatching { connectivity.registerDefaultNetworkCallback(callback) }.isSuccess
  }

  fun stop() {
    if (!registered) return
    runCatching { connectivity?.unregisterNetworkCallback(callback) }
    registered = false
  }
}
