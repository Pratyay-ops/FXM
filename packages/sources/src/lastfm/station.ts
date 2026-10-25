/**
 * Last.fm's keyless station JSON: the playlists behind the play buttons on Last.fm's own pages.
 * Each item names a song and, usually, a YouTube video of it. See `CLEAN-ROOM.md` for where each
 * fact comes from.
 *
 * The station hosts send no CORS headers, so only the Full tier reaches them: the web app with
 * FXM Connect (whose Last.fm rule adds them), the desktop app and the Android app.
 *
 * @module
 */

import { FxmError, type NetworkCapabilities, type ProviderContext } from '@fxm/core'
import { RequestGate } from '../shared/gate'
import { field, getText, parseJson, rateLimited, retryAfterMs } from '../shared/http'

/** Where Last.fm's pages and stations live. */
export const LASTFM_WEB_ORIGIN = 'https://www.last.fm'

/**
 * Every station URL starts with this, e.g. for the platform's `transport.canReach`, which says
 * whether FXM Connect (or a native app) opens the route to the stations.
 */
export const LASTFM_STATION_PREFIX = `${LASTFM_WEB_ORIGIN}/player/station/`

/** The service's name in error messages. */
const SERVICE = 'Last.fm'

/**
 * A station, as Last.fm's artist pages offer them (checked 2026-10-26):
 *
 * - `artist`: the artist's own popular tracks (`/player/station/music/<artist>`)
 * - `similar`: tracks by the artist and similar artists (`/player/station/music/<artist>/+similar`),
 *   a new mix on every request
 */
export interface LastfmStation {
  /** Which station. */
  type: 'artist' | 'similar'
  /** The artist's name, as Last.fm spells it or close to it. */
  artist: string
}

/**
 * One song of a station. The station's own `duration` is left out: in the recorded stations it
 * is often not the song's length (see `CLEAN-ROOM.md`), and a wrong duration does more harm to
 * matching than none.
 */
export interface LastfmStationTrack {
  /** The song's title on Last.fm. */
  title: string
  /** Its artists' names, main artist first. */
  artists: string[]
  /**
   * A YouTube video of the song, as Last.fm links it. Not classified: it may be the song's audio,
   * its official video or someone's upload.
   */
  youtubeId?: string
  /** The song's page on Last.fm, which Last.fm asks apps that use its data to link to. */
  url: string
}

/**
 * Whether the platform can reach the station JSON, from its capabilities: only the Full tier
 * can, which is `youtube: 'full'` (FXM Connect, whose Last.fm rule adds the CORS headers, the
 * desktop app and the Android app). The Free and Lite tiers cannot read the answers.
 */
export function lastfmStationsReachable(capabilities: NetworkCapabilities): boolean {
  return capabilities.youtube === 'full'
}

/** Replaces lone surrogates, which `encodeURIComponent` refuses, with U+FFFD. */
function wellFormed(text: string): string {
  return text.replace(/\p{Surrogate}/gu, '�')
}

/**
 * A name as Last.fm writes it in a URL path segment: percent-encoded UTF-8, with `+` for each
 * space and `%27` for an apostrophe, e.g. `Don%27t+Look+Back+in+Anger`. A name of dots only is
 * encoded too, so that it can't read as `.` or `..`, which URLs resolve away.
 */
export function lastfmPathSegment(name: string): string {
  const segment = encodeURIComponent(wellFormed(name.trim()))
    .replace(/%20/gu, '+')
    .replace(/'/gu, '%27')
  return /^\.+$/u.test(segment) ? segment.replace(/\./gu, '%2E') : segment
}

/** The URL of a station. */
export function lastfmStationUrl(station: LastfmStation, origin = LASTFM_WEB_ORIGIN): string {
  const artist = lastfmPathSegment(station.artist)
  const suffix = station.type === 'similar' ? '/+similar' : ''
  return `${origin}/player/station/music/${artist}${suffix}`
}

/** The most UTF-16 code units FXM keeps of a title or name from Last.fm. */
const MAX_NAME_LENGTH = 300

/** A YouTube video ID: 11 characters of URL-safe base64. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/u

/** A name from Last.fm, tidied, or `undefined` when it is not a string or is blank. */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const folded = wellFormed(value).replace(/\s+/gu, ' ').trim()
  if (folded === '') return undefined
  return folded.length <= MAX_NAME_LENGTH ? folded : folded.slice(0, MAX_NAME_LENGTH).trimEnd()
}

/** The first YouTube video ID among an item's play links. */
function youtubeIdOf(item: unknown): string | undefined {
  const links = field(item, 'playlinks') ?? field(item, '_playlinks')
  if (!Array.isArray(links)) return undefined
  for (const link of links) {
    const id = field(link, 'id')
    if (field(link, 'affiliate') === 'youtube' && typeof id === 'string' && YOUTUBE_ID.test(id)) {
      return id
    }
  }
  return undefined
}

/** An item's Last.fm page: its own path when it is one, else built from the names. */
function pageOf(item: unknown, title: string, artist: string, origin: string): string {
  const path = field(item, 'url')
  if (typeof path === 'string' && /^\/music\/[^/?#\s][^?#\s]*$/u.test(path))
    return `${origin}${path}`
  return `${origin}/music/${lastfmPathSegment(artist)}/_/${lastfmPathSegment(title)}`
}

/**
 * Reads a station's JSON: `{ playlist: [...] }`, one entry per song. Entries without a title or
 * an artist are skipped, and a song listed twice is kept once. Throws a `Parse` `FxmError` when
 * the answer has no playlist.
 */
export function parseLastfmStation(
  body: unknown,
  origin = LASTFM_WEB_ORIGIN,
): LastfmStationTrack[] {
  const playlist = field(body, 'playlist')
  if (!Array.isArray(playlist)) {
    throw new FxmError('Parse', 'Last.fm sent a station FXM does not understand')
  }
  const tracks: LastfmStationTrack[] = []
  const seen = new Set<string>()
  for (const item of playlist) {
    const title = nameOf(field(item, 'name')) ?? nameOf(field(item, '_name'))
    const credits = field(item, 'artists')
    const artists = (Array.isArray(credits) ? credits : [])
      .map((artist) => nameOf(field(artist, 'name')) ?? nameOf(field(artist, '_name')))
      .filter((name) => name !== undefined)
    const [main] = artists
    if (title === undefined || main === undefined) continue
    const key = `${main.toLowerCase()}\u0000${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const track: LastfmStationTrack = { title, artists, url: pageOf(item, title, main, origin) }
    const youtubeId = youtubeIdOf(item)
    if (youtubeId !== undefined) track.youtubeId = youtubeId
    tracks.push(track)
  }
  return tracks
}

/** Options for {@link LastfmStationPacing}. All have defaults. */
export interface LastfmStationPacingOptions {
  /**
   * Pause this many milliseconds between one station request and the next. Last.fm answers
   * clients it suspects with a JavaScript challenge, so FXM keeps to a human pace. Default 2,000.
   */
  minIntervalMs?: number
  /**
   * The longest a call waits for its turn, counted from when it was made, before failing with
   * `RateLimited`. Default 10,000.
   */
  maxWaitMs?: number
  /**
   * After Last.fm answers with its challenge page, stop asking for this many milliseconds:
   * calls fail at once with `BotCheck`. Default 15 minutes.
   */
  challengeBackoffMs?: number
}

/**
 * How FXM paces its station requests, and the pause after Last.fm answers with its challenge
 * page. Last.fm judges the device's IP address, not one reader, so every reader shares
 * {@link lastfmStationPacing} unless it is given its own (tests do).
 */
export class LastfmStationPacing {
  /** One request at a time, `minIntervalMs` apart. */
  readonly gate: RequestGate
  /** How long a challenge stops the requests, in milliseconds. */
  readonly challengeBackoffMs: number
  /** When the current challenge pause ends, in epoch milliseconds. */
  private challengedUntil = 0

  constructor(options: LastfmStationPacingOptions = {}) {
    this.gate = new RequestGate({
      service: SERVICE,
      minIntervalMs: options.minIntervalMs ?? 2_000,
      maxWaitMs: options.maxWaitMs ?? 10_000,
    })
    this.challengeBackoffMs = options.challengeBackoffMs ?? 15 * 60_000
  }

  /** How long the challenge pause still lasts, in milliseconds: 0 when there is none. */
  challengeRemainingMs(): number {
    return Math.max(0, this.challengedUntil - Date.now())
  }

  /** Starts the challenge pause, after Last.fm answered with its challenge page. */
  challenged(): void {
    this.challengedUntil = Date.now() + this.challengeBackoffMs
  }
}

/** The pacing every station reader of the app shares by default. */
export const lastfmStationPacing = new LastfmStationPacing()

/** Options for {@link createLastfmStations}. All have defaults. */
export interface LastfmStationsOptions {
  /** Where Last.fm lives. Default {@link LASTFM_WEB_ORIGIN}. */
  origin?: string
  /** Abort a request, body included, after this many milliseconds. Default 10,000. */
  timeoutMs?: number
  /**
   * Whether the platform can reach the stations now: the one check every station call and the
   * recommendation collector make. Default {@link lastfmStationsReachable} on
   * `ctx.capabilities`. With stage 1.2's platform, pass the transport's own answer, which also
   * knows whether FXM Connect has its `lastfm` feature:
   * `(ctx) => platform.transport.canReach(LASTFM_STATION_PREFIX)`.
   */
  reachable?: (ctx: ProviderContext) => boolean
  /** The pacing and challenge state to share. Default {@link lastfmStationPacing}. */
  pacing?: LastfmStationPacing
}

/** Reads Last.fm stations. */
export interface LastfmStations {
  /** Whether the platform can reach the stations now (see {@link LastfmStationsOptions.reachable}). */
  isReachable(ctx: ProviderContext): boolean
  /**
   * The songs of a station, in Last.fm's order. A `similar` station is a new mix each time.
   *
   * Rejects with an `FxmError`: `Unsupported`, without a request, when {@link isReachable} says
   * no; `BotCheck` when Last.fm answers with its challenge page (calls then fail at once for the
   * pacing's `challengeBackoffMs`, and `retryAfterMs` says how long is left); `RateLimited` when
   * it asks FXM to slow down or the call would wait too long for its turn; `Network`;
   * `Unavailable` for other HTTP errors and `Parse` for answers it cannot read. An artist
   * Last.fm does not know gives an empty list.
   */
  station(station: LastfmStation, ctx: ProviderContext): Promise<LastfmStationTrack[]>
}

/** The most bytes FXM reads of a station: a station of 30 songs is about 60 KB. */
const MAX_STATION_BYTES = 2_000_000

/** The error for a challenge page, now or within the pause after one. */
function botCheck(retryAfterMs: number): FxmError {
  return new FxmError(
    'BotCheck',
    'Last.fm answered with its browser challenge instead of the station',
    { retryAfterMs },
  )
}

/** Creates a {@link LastfmStations} reader. */
export function createLastfmStations(options: LastfmStationsOptions = {}): LastfmStations {
  const origin = (options.origin ?? LASTFM_WEB_ORIGIN).replace(/\/+$/u, '')
  const timeoutMs = options.timeoutMs ?? 10_000
  const reachable =
    options.reachable ?? ((ctx: ProviderContext) => lastfmStationsReachable(ctx.capabilities))
  const pacing = options.pacing ?? lastfmStationPacing

  /** Fails while a challenge pause is on. */
  function checkChallenge(): void {
    const waitMs = pacing.challengeRemainingMs()
    if (waitMs > 0) throw botCheck(waitMs)
  }

  return {
    isReachable: (ctx) => reachable(ctx),

    async station(station, ctx) {
      if (!reachable(ctx)) {
        throw new FxmError(
          'Unsupported',
          'Last.fm stations need FXM Connect, the desktop app or the Android app',
        )
      }
      if (station.artist.trim() === '') return []
      checkChallenge()
      return pacing.gate.run(
        async (ready) => {
          // A call that waited its turn behind one that met the challenge asks nothing.
          checkChallenge()
          await ready()
          const response = await getText(ctx, lastfmStationUrl(station, origin), {
            service: SERVICE,
            timeoutMs,
            maxBytes: MAX_STATION_BYTES,
          })
          const { status, contentType } = response
          const html = contentType === 'text/html' || /^\s*</u.test(response.text)
          if (status === 403 || (status === 200 && html)) {
            pacing.challenged()
            throw botCheck(pacing.challengeBackoffMs)
          }
          if (status === 200) return parseLastfmStation(parseJson(response, SERVICE), origin)
          if (status === 404) return []
          if (status === 429) {
            const delayMs = retryAfterMs(response.headers.get('retry-after'), 60_000)
            throw rateLimited(SERVICE, pacing.gate.backOff(delayMs, true))
          }
          if (status >= 500) {
            pacing.gate.backOff(retryAfterMs(response.headers.get('retry-after'), 5_000), false)
          }
          throw new FxmError(
            'Unavailable',
            `Last.fm answered a station request with HTTP ${status}`,
          )
        },
        { signal: ctx.signal },
      )
    },
  }
}
