// Generated from @fxm/platform by apps/mobile/scripts/native-tables.ts. Do not edit: after
// changing packages/platform/src/hosts.ts or android-http.ts, run
// `scripts/run.sh pnpm vitest run apps/mobile/scripts -u` and commit the result.
package io.github.pratyayops.fxm.http

/** FXM's host table: `HOST_RULES` in packages/platform/src/hosts.ts. */
val HOST_RULES: List<HostRule> =
  listOf(
    HostRule("musicbrainz.org", HostClass.OPEN, "MusicBrainz"),
    HostRule("coverartarchive.org", HostClass.OPEN, "Cover Art Archive"),
    HostRule("api.listenbrainz.org", HostClass.OPEN, "ListenBrainz"),
    HostRule("labs.api.listenbrainz.org", HostClass.OPEN, "ListenBrainz Labs"),
    HostRule("ws.audioscrobbler.com", HostClass.OPEN, "the Last.fm API"),
    HostRule("lrclib.net", HostClass.OPEN, "LRCLIB"),
    HostRule("archive.org", HostClass.OPEN, "Internet Archive"),
    HostRule("*.archive.org", HostClass.OPEN, "Internet Archive"),
    HostRule("api.jamendo.com", HostClass.OPEN, "Jamendo"),
    HostRule("*.jamendo.com", HostClass.OPEN, "Jamendo"),
    HostRule("itunes.apple.com", HostClass.OPEN, "iTunes Search"),
    HostRule("sponsor.ajay.app", HostClass.OPEN, "SponsorBlock"),
    HostRule("i.ytimg.com", HostClass.OPEN, "YouTube thumbnails"),
    HostRule("*.ggpht.com", HostClass.OPEN, "YouTube images"),
    HostRule("i.scdn.co", HostClass.OPEN, "Spotify images"),
    HostRule("www.youtube.com", HostClass.INNERTUBE, "YouTube"),
    HostRule("music.youtube.com", HostClass.INNERTUBE, "YouTube Music"),
    HostRule("youtubei.googleapis.com", HostClass.INNERTUBE, "YouTube"),
    HostRule("*.googlevideo.com", HostClass.GOOGLEVIDEO, "YouTube media"),
    HostRule("open.spotify.com", HostClass.SPOTIFY, "Spotify"),
    HostRule("clienttoken.spotify.com", HostClass.SPOTIFY, "Spotify"),
    HostRule("api-partner.spotify.com", HostClass.SPOTIFY, "Spotify"),
    HostRule("spclient.wg.spotify.com", HostClass.SPOTIFY, "Spotify"),
    HostRule(
      "www.last.fm",
      HostClass.LASTFM_WEB,
      "Last.fm stations",
      pathPrefix = "/player/station/",
    ),
  )

/**
 * The codes the FxmHttp plugin rejects with: `FXM_HTTP_ERROR_CODES` in
 * packages/platform/src/android-http.ts, which documents each.
 */
enum class BridgeErrorCode {
  BAD_REQUEST,
  HOST_NOT_ALLOWED,
  HOST_NOT_APPROVED,
  HEADER_NOT_ALLOWED,
  METHOD_NOT_ALLOWED,
  REDIRECT,
  NETWORK,
  TIMEOUT,
  ABORTED,
  UNKNOWN_ID,
  BUSY,
  NO_ACTIVITY,
}

/** The FxmHttp bridge's constants, from packages/platform/src/android-http.ts. */
object BridgeProtocol {
  /** The plugin's name on the Capacitor bridge. */
  const val PLUGIN_NAME = "FxmHttp"

  /** Bytes per read when JavaScript asks for no particular amount. */
  const val READ_BYTES = 262144

  /** The most one read returns. */
  const val MAX_READ_BYTES = 1048576
}
