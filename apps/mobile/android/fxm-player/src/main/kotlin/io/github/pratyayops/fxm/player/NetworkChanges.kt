package io.github.pratyayops.fxm.player

/**
 * Decides which of Android's default-network callbacks change the network as far as stream URLs
 * care: YouTube binds each URL to the IP address that resolved it. A different default network,
 * losing it, or new addresses on it count; the first network reported after registering, and
 * repeats, do not. Networks and addresses are opaque strings here ([NetworkWatcher] passes
 * Android's network handle and the link's addresses).
 */
class NetworkChanges {
  private var current: String? = null
  private var lost = false
  private var addresses: Set<String> = emptySet()

  /** A network became the default. Returns whether that is a change. */
  fun onAvailable(network: String): Boolean {
    val changed = current != null && (network != current || lost)
    if (network != current) addresses = emptySet()
    current = network
    lost = false
    return changed
  }

  /** A network was lost. Returns whether it was the default. */
  fun onLost(network: String): Boolean {
    if (network != current || lost) return false
    lost = true
    return true
  }

  /** The default network's addresses are [addresses] now. Returns whether they changed. */
  fun onAddresses(network: String, addresses: Set<String>): Boolean {
    if (network != current || lost) return false
    val changed = this.addresses.isNotEmpty() && addresses != this.addresses
    this.addresses = addresses
    return changed
  }
}
