package io.github.pratyayops.fxm.http

import android.content.Context
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The hosts outside FXM's host table that the user approved, such as an Invidious instance they
 * typed in Settings. Entries are `host` or `host:port` (see [UserHosts.normalize]). Only the
 * system dialog of [HostApprovals] adds entries, so JavaScript cannot widen the list on its own.
 */
interface ApprovedHosts {
  /** Whether [hostPort] (from [Hosts.hostPort]) is approved. */
  operator fun contains(hostPort: String): Boolean

  /** Every approved entry. */
  fun list(): Set<String>

  /** Approves normalized entries. */
  fun add(entries: Collection<String>)

  /** Withdraws normalized entries. */
  fun remove(entries: Collection<String>)
}

/** Parses what users type as a host, the same way the web transports compare it. */
object UserHosts {
  /**
   * The stored form of a user-entered host: `host` or `host:port`, lower case, the port only when
   * it is not 443, international names in their ASCII form. `null` for anything else, such as a
   * URL with a scheme, path or credentials.
   */
  fun normalize(entry: String): String? {
    val trimmed = entry.trim()
    if (trimmed.isEmpty() || trimmed.any { it in "/?#@\\ " }) return null
    val url = "https://$trimmed/".toHttpUrlOrNull() ?: return null
    return Hosts.hostPort(url)
  }
}

/** Approved hosts in memory, for tests and as the cache of [PreferencesApprovedHosts]. */
open class InMemoryApprovedHosts(initial: Collection<String> = emptyList()) : ApprovedHosts {
  private val entries = LinkedHashSet(initial)

  @Synchronized override fun contains(hostPort: String): Boolean = hostPort in entries

  @Synchronized override fun list(): Set<String> = LinkedHashSet(entries)

  @Synchronized override fun add(entries: Collection<String>) {
    this.entries.addAll(entries)
    saved(list())
  }

  @Synchronized override fun remove(entries: Collection<String>) {
    this.entries.removeAll(entries.toSet())
    saved(list())
  }

  /** Called with the new list after every change. */
  protected open fun saved(entries: Set<String>) {}
}

/**
 * Approved hosts in the app's private preferences, which the backup rules keep off the device's
 * backups and transfers.
 */
class PreferencesApprovedHosts private constructor(
  private val preferences: android.content.SharedPreferences,
) : InMemoryApprovedHosts(preferences.getStringSet(KEY, emptySet()).orEmpty()) {
  override fun saved(entries: Set<String>) {
    preferences.edit().putStringSet(KEY, entries).apply()
  }

  companion object {
    private const val FILE = "fxm-http"
    private const val KEY = "approved-hosts"

    /** The store for [context]'s app. */
    fun open(context: Context): PreferencesApprovedHosts =
      PreferencesApprovedHosts(
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
      )
  }
}
