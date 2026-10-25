package io.github.pratyayops.fxm.http

import okhttp3.HttpUrl

/**
 * How a host on FXM's host table is reached, as `HostClass` in packages/platform/src/hosts.ts.
 * Native code reaches every class directly; the class decides which `Origin` a request may carry
 * and whether it needs a browser `User-Agent`.
 */
enum class HostClass(val id: String) {
  /** CORS-friendly APIs and images (MusicBrainz, LRCLIB, Internet Archive, …). */
  OPEN("open"),

  /** YouTube's API hosts: InnerTube calls and other YouTube pages. */
  INNERTUBE("innertube"),

  /** YouTube's media servers. */
  GOOGLEVIDEO("googlevideo"),

  /** Spotify's web-player hosts. */
  SPOTIFY("spotify"),

  /** Last.fm's keyless station JSON. */
  LASTFM_WEB("lastfm-web"),
}

/** One row of FXM's host table ([HOST_RULES], generated from packages/platform/src/hosts.ts). */
data class HostRule(
  /** An exact host name, or `*.` and a domain: every sub-domain at any depth, not the domain. */
  val host: String,
  val hostClass: HostClass,
  /** What the host serves, for messages. */
  val service: String,
  /** When set, only paths starting with it belong to the rule. */
  val pathPrefix: String? = null,
)

/** Looks URLs up in FXM's host table, with the same rules as packages/platform/src/hosts.ts. */
object Hosts {
  /** Whether [hostname] matches a [HostRule.host] pattern. */
  fun matches(hostname: String, pattern: String): Boolean {
    if (!pattern.startsWith("*.")) return hostname == pattern
    val suffix = pattern.substring(1)
    return hostname.length > suffix.length && hostname.endsWith(suffix)
  }

  /** Whether FXM may send to [url] at all: HTTPS, the default port and no credentials. */
  fun isPlainHttps(url: HttpUrl): Boolean =
    url.scheme == "https" && url.port == 443 && url.username.isEmpty() && url.password.isEmpty()

  /** The rule [url] falls under, or `null` when it is not on FXM's host table. */
  fun ruleFor(url: HttpUrl, rules: List<HostRule> = HOST_RULES): HostRule? {
    if (!isPlainHttps(url)) return null
    val rule = rules.firstOrNull { matches(url.host, it.host) } ?: return null
    val prefix = rule.pathPrefix
    return if (prefix != null && !url.encodedPath.startsWith(prefix)) null else rule
  }

  /**
   * The `host` or `host:port` form of [url] that user-approved hosts are stored in, as `URL.host`
   * gives it in JavaScript: lower case, the port only when it is not 443.
   */
  fun hostPort(url: HttpUrl): String {
    val host = if (url.host.contains(':')) "[${url.host}]" else url.host
    return if (url.port == 443) host else "$host:${url.port}"
  }
}
