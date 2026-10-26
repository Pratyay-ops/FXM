/**
 * The `FxmPlayer` Capacitor plugin: the Android app's native player (stage 6.3), a Media3
 * `MediaSessionService` in a `mediaPlayback` foreground service. Its native side is
 * `apps/mobile/android/fxm-player` (`FxmPlayerPlugin.kt`, `PlayerMessages.kt`), which documents
 * the same messages. The wire types carry the `FxmPlayer` prefix, like `FxmHttp` in
 * `@fxm/platform`, so they don't clash with the engine's own `Native*` names.
 *
 * @module
 */

/** The plugin's name on the Capacitor bridge (`Capacitor.Plugins.FxmPlayer`). */
export const FXM_PLAYER_PLUGIN = 'FxmPlayer'

/** The most entries one message may queue after the current one. */
export const FXM_PLAYER_MAX_UPCOMING = 50

/** The longest {@link FxmPlayerEntry.data} the plugin takes, in characters. */
export const FXM_PLAYER_MAX_ENTRY_DATA = 16_384

/**
 * Every code the plugin rejects with (the `code` of the bridge's error):
 *
 * - `BAD_REQUEST`: a malformed message, e.g. an entry without an HTTPS URL or a title, or a
 *   header OkHttp refuses
 * - `UNAVAILABLE`: the player service could not be started or bound
 * - `INTERNAL`: the player failed
 */
export const FXM_PLAYER_ERROR_CODES = ['BAD_REQUEST', 'UNAVAILABLE', 'INTERNAL'] as const

/** One of {@link FXM_PLAYER_ERROR_CODES}. */
export type FxmPlayerErrorCode = (typeof FXM_PLAYER_ERROR_CODES)[number]

/** The bridge error's `code`, when it is one of {@link FXM_PLAYER_ERROR_CODES}. */
export function fxmPlayerErrorCode(error: unknown): FxmPlayerErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return (FXM_PLAYER_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as FxmPlayerErrorCode)
    : undefined
}

/**
 * Where an entry's audio comes from: a resolved stream, fetched with plain `GET`s through the
 * app's OkHttp client and FXM's network rules.
 */
export interface FxmPlayerSource {
  /**
   * What kind of source it is. Only `http` (the default): an HTTPS URL. Reserved so that offline
   * copies (`file`, app storage or a `content://` URI, stage 6.4) can join without a breaking
   * change; the plugin refuses kinds it does not know.
   */
  readonly kind?: 'http'
  /** The absolute HTTPS URL of the whole file. */
  readonly url: string
  /**
   * Headers the URL needs (`StreamOption.requestHeaders`); the player sets them on every request
   * for it. At most 32, with token names and printable ASCII values. Byte ranges, encodings,
   * cookies and framing headers are the player's own and are dropped.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** When the URL stops working, in epoch milliseconds; absent when it does not expire. */
  readonly expiresAt?: number
  /** Whether the URL only works from the IP address that resolved it. Default: `false`. */
  readonly ipBound?: boolean
  /**
   * The native network ({@link FxmPlayerNetwork.id}) the URL was resolved on. Absent: the
   * network current when the message arrives.
   */
  readonly network?: number
  /**
   * Names the bytes the URL serves: two sources with the same key serve the same file, so the
   * player reads on through a fresh URL at the same byte offset instead of preparing the entry
   * again. Opaque to the player; the web app sets it from what it knows about the stream. Absent:
   * only an equal URL counts as the same file.
   */
  readonly fileKey?: string
  /**
   * How loud the audio is, when the source says (`StreamOption.loudness`, stage 8.1): the native
   * player applies loudness normalization itself, so an entry it moves on to by itself plays at
   * its own level from its first sample.
   */
  readonly loudness?: FxmPlayerLoudness
}

/** How loud an entry's audio is, for loudness normalization. */
export interface FxmPlayerLoudness {
  /** The track's integrated loudness, in LUFS. */
  readonly trackLufs: number
  /** Its album's, in LUFS, when known (album mode). */
  readonly albumLufs?: number
}

/**
 * The audio effects, as {@link FxmPlayerPlugin.setEffects} takes them (stage 8.1). The native
 * player runs the same ten peaking filters as the web (`EQUALIZER_BANDS_HZ` in `@fxm/core`), and
 * turns loud tracks down to the target; it doesn't turn quiet ones up yet.
 */
export interface FxmPlayerEffects {
  /** The equalizer: on or off, and one gain per band in dB (-12 to 12). */
  readonly equalizer: { readonly enabled: boolean; readonly gainsDb: readonly number[] }
  /** Loudness normalization: on or off, the target level in LUFS, track or album gain. */
  readonly loudness: {
    readonly enabled: boolean
    readonly targetLufs: number
    readonly mode: 'track' | 'album'
  }
  /** Playback speed, from 0.5 to 2; the pitch stays. */
  readonly speed: number
}

/**
 * A sleep timer, as {@link FxmPlayerPlugin.setSleepTimer} takes it: pause at `endsAt` (epoch
 * milliseconds) after fading out over `fadeMs`, or at the end of the current entry
 * (`endOfTrack`). With neither, it cancels the timer.
 */
export interface FxmPlayerSleepTimer {
  readonly endsAt: number | null
  readonly fadeMs: number
  readonly endOfTrack: boolean
}

/** What the media notification and the lock screen show for an entry. */
export interface FxmPlayerMetadata {
  /** The title, never blank (at most 1000 characters are shown). */
  readonly title: string
  /** The artists' names, in order (at most 50 are shown). */
  readonly artists: readonly string[]
  /** The album's name. */
  readonly album?: string
  /** An HTTPS image URL; another URL is left out. */
  readonly artworkUrl?: string
  /** The track's duration from its metadata, in milliseconds, until Media3 knows better. */
  readonly durationMs?: number
}

/** One entry of the native queue: a queue item (`uid`) with its resolved source. */
export interface FxmPlayerEntry {
  /**
   * Chosen by the web app: unique among the entries it sends, `[A-Za-z0-9._:-]{1,100}`. Every
   * message and event names entries by id, never by URL.
   */
  readonly id: string
  /** The queue item's uid in the web app's player. */
  readonly uid: number
  /** Where the audio comes from. */
  readonly source: FxmPlayerSource
  /** What the notification and the lock screen show. */
  readonly metadata: FxmPlayerMetadata
  /**
   * The web app's own data for the entry, at most {@link FXM_PLAYER_MAX_ENTRY_DATA} characters:
   * opaque to the player, which returns it with the entry in the session ({@link
   * FxmPlayerPlugin.attach}). The native engine keeps the entry's stream there, so a recreated
   * page takes the entry over without resolving it again.
   */
  readonly data?: string
}

/**
 * How the queue repeats: `one` loops the current entry natively; `off` and `all` play the
 * entries in order (for `all` the web app lists the wrapped-around entries itself).
 */
export type FxmPlayerRepeat = 'off' | 'all' | 'one'

/**
 * Media3's playback states: `idle` (nothing prepared, or a failure), `buffering`, `ready` (plays
 * when it should) and `ended` (the last entry played to its end).
 */
export type FxmPlayerPlaybackState = 'idle' | 'buffering' | 'ready' | 'ended'

/** What the native player is doing. */
export interface FxmPlayerState {
  /** The current entry's id, or `null` when the playlist is empty. */
  readonly id: string | null
  /** How far into the current entry playback is, in milliseconds. */
  readonly positionMs: number
  /** The current entry's duration in milliseconds, or -1 while unknown. */
  readonly durationMs: number
  /** Whether audio is coming out. */
  readonly playing: boolean
  /** Whether it plays as soon as it can (Media3's `playWhenReady`). */
  readonly playWhenReady: boolean
  /** Media3's playback state. */
  readonly state: FxmPlayerPlaybackState
}

/** A playback failure, typed like an `EngineError`, with the HTTP status where there was one. */
export interface FxmPlayerFailure {
  /**
   * Why it failed, as the engine's `EngineErrorType`: `network` (fetching failed, including an
   * HTTP error), `decode`, `unsupported` (a format the device cannot play, or a request FXM's
   * rules refused) or `expired` (an HTTP error after the URL's `expiresAt`).
   */
  readonly type: 'network' | 'decode' | 'unsupported' | 'expired'
  /** The HTTP status of the failed request, or `null` when there was none. */
  readonly status: number | null
  /** Media3's description, for logs. Never contains a URL. */
  readonly message: string
}

/** The device's network, from Android's own callbacks. */
export interface FxmPlayerNetwork {
  /**
   * Counts the changes of the default network (another network, losing it, new addresses on
   * it): IP-bound URLs resolved under an earlier id may fail now.
   */
  readonly id: number
  /** Whether the device is on mobile data. A change of this alone keeps the id. */
  readonly cellular: boolean
}

/** Where the native player is, for a web app that attaches (e.g. after its renderer died). */
export interface FxmPlayerSession extends FxmPlayerState {
  /** The current entry and the ones queued after it, as the web app sent them. */
  readonly entries: readonly FxmPlayerEntry[]
  /** How the current entry failed, while nothing replaced it; otherwise `null`. */
  readonly error: FxmPlayerFailure | null
  /** What the web app last saved with {@link FxmPlayerPlugin.saveSnapshot}, or `null`. */
  readonly snapshot: string | null
  /** The device's network now. */
  readonly network: FxmPlayerNetwork
}

/** The events the plugin sends once the web app has attached. */
export interface FxmPlayerEventMap {
  /** The playback state, on every change and about once a second while playing (every 5 s
   * while the app is not on screen). */
  state: FxmPlayerState
  /** The native player moved to another entry by itself. */
  transition: {
    /** The entry it left, or `null`. */
    readonly from: string | null
    /** The entry it plays now, or `null`. */
    readonly to: string | null
    /**
     * `auto`: the previous entry ended; `repeat`: it loops (repeat one); `skip`: the native
     * player skipped an entry that failed, or followed a system control, while the web app did
     * not answer.
     */
    readonly reason: 'auto' | 'repeat' | 'skip'
  }
  /** An entry failed to play (`id`, or `null`). Act on it (load, pause), or the native player
   * skips it in 30 s. */
  error: FxmPlayerFailure & { readonly id: string | null }
  /** An upcoming entry needs a fresh source: its URL expires before it would finish, or it is
   * bound to an earlier network. Send it again with {@link FxmPlayerPlugin.setUpcoming}. */
  request: {
    /** The upcoming entry. */
    readonly id: string
    /** `expiring`: its URL expires before it would finish; `network`: it is IP-bound and was
     * resolved on an earlier network. */
    readonly reason: 'expiring' | 'network'
  }
  /** A system control (notification, lock screen, headset, Bluetooth) asked for next or previous.
   * Acknowledge it ({@link FxmPlayerPlugin.ack}), or the native player acts on it in 8 s. */
  command: { readonly command: 'next' | 'previous' }
  /** The device changed network: IP-bound URLs resolved before may fail now. */
  network: FxmPlayerNetwork
  /** The sleep timer paused playback: at its time, or at the end of the entry it waited for. */
  sleep: { readonly reason: 'timer' | 'end-of-track' }
}

/** A listener registration, as Capacitor returns it. */
export interface FxmPlayerListenerHandle {
  /** Removes the listener. */
  remove(): Promise<void> | void
}

/** The options of {@link FxmPlayerPlugin.load}. */
export interface FxmPlayerLoadOptions {
  /** The entry to play. */
  readonly entry: FxmPlayerEntry
  /** Where to start, in milliseconds. */
  readonly startAtMs: number
  /** The entries to queue after it, in play order: at most {@link FXM_PLAYER_MAX_UPCOMING}. */
  readonly upcoming: readonly FxmPlayerEntry[]
  /** Whether the web app's queue has more items than `upcoming` lists. */
  readonly hasMore: boolean
  /** How the queue repeats. */
  readonly repeat: FxmPlayerRepeat
}

/** The options of {@link FxmPlayerPlugin.setUpcoming}. */
export interface FxmPlayerUpcomingOptions {
  /** The entries to queue after the current one, in play order: at most
   * {@link FXM_PLAYER_MAX_UPCOMING}. */
  readonly upcoming: readonly FxmPlayerEntry[]
  /** Whether the web app's queue has more items than `upcoming` lists. */
  readonly hasMore: boolean
  /** How the queue repeats. */
  readonly repeat: FxmPlayerRepeat
}

/**
 * The `FxmPlayer` plugin as the Capacitor bridge exposes it. Every method resolves once the
 * native player has acted on the message, in the order the messages were sent, and rejects with
 * an error whose `code` is one of {@link FXM_PLAYER_ERROR_CODES} ({@link fxmPlayerErrorCode}).
 */
export interface FxmPlayerPlugin {
  /**
   * Attaches this page: from now on it gets the events, and the native player waits for its
   * decisions (failures, system controls). Resolves with where playback is.
   */
  attach(): Promise<FxmPlayerSession>
  /**
   * Plays `entry` from `startAtMs`, paused until {@link play}, with entries queued after it. An
   * entry already queued after the current one, with the same id and the same bytes (an equal
   * URL or {@link FxmPlayerSource.fileKey}), is skipped to, keeping its buffer.
   */
  load(options: FxmPlayerLoadOptions): Promise<void>
  /**
   * Replaces the entries queued after the current one. The unchanged leading entries (the same
   * ids and bytes, in the same order) keep their slot and buffer, taking up a fresh URL from
   * their next request; everything after the first change is prepared anew.
   */
  setUpcoming(options: FxmPlayerUpcomingOptions): Promise<void>
  /** Plays, preparing the current entry again after a failure. */
  play(): Promise<void>
  /** Pauses. */
  pause(): Promise<void>
  /** Moves within the current entry to `positionMs`, in milliseconds. */
  seek(options: { readonly positionMs: number }): Promise<void>
  /** Sets the volume, from 0 to 1. */
  setVolume(options: { readonly volume: number }): Promise<void>
  /** Takes over a system control's next or previous ({@link FxmPlayerEventMap.command}). */
  ack(): Promise<void>
  /**
   * Keeps `data` (at most 4 Mi characters) in memory for the next {@link attach}, e.g. after the
   * renderer died; `null` clears it. It does not survive the app's process.
   */
  saveSnapshot(options: { readonly data: string | null }): Promise<void>
  /** Stops playback and forgets the queue and the snapshot; the notification goes away. */
  release(): Promise<void>
  /**
   * Applies the audio effects (stage 8.1): the equalizer, loudness normalization and the speed.
   * Optional, so a native side without them is still found; the engine then reports the effects
   * as unavailable.
   */
  setEffects?(options: FxmPlayerEffects): Promise<void>
  /**
   * Starts, replaces or cancels the native sleep timer, which keeps time while the page may not
   * run (screen off). When it pauses, the plugin sends `sleep`. Optional, like `setEffects`.
   */
  setSleepTimer?(options: FxmPlayerSleepTimer): Promise<void>
  /** Adds a listener for one of the {@link FxmPlayerEventMap} events. */
  addListener<K extends keyof FxmPlayerEventMap>(
    eventName: K,
    listener: (event: FxmPlayerEventMap[K]) => void,
  ): Promise<FxmPlayerListenerHandle> | FxmPlayerListenerHandle
}

const PLUGIN_METHODS = [
  'attach',
  'load',
  'setUpcoming',
  'play',
  'pause',
  'seek',
  'setVolume',
  'ack',
  'saveSnapshot',
  'release',
  'addListener',
]

/** The parts of the WebView's global object the plugin lookup reads. */
interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: Readonly<Record<string, unknown>>
  }
}

/**
 * The `FxmPlayer` plugin of the Android app, or `undefined` outside it: only on a native
 * Capacitor platform whose bridge has the plugin with all its methods.
 */
export function findFxmPlayerPlugin(global: object = globalThis): FxmPlayerPlugin | undefined {
  const capacitor = (global as CapacitorGlobal).Capacitor
  if (typeof capacitor?.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) {
    return undefined
  }
  const plugin = capacitor.Plugins?.[FXM_PLAYER_PLUGIN]
  if (typeof plugin !== 'object' || plugin === null) return undefined
  const methods = plugin as Record<string, unknown>
  return PLUGIN_METHODS.every((name) => typeof methods[name] === 'function')
    ? (plugin as FxmPlayerPlugin)
    : undefined
}
