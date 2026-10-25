/**
 * The `FxmPlayer` Capacitor plugin: the Android app's native player (stage 6.3), a Media3
 * `MediaSessionService` in a `mediaPlayback` foreground service. Its native side is
 * `apps/mobile/android/fxm-player` (`FxmPlayerPlugin.kt`, `PlayerMessages.kt`), which documents
 * the same messages.
 *
 * @module
 */

/** The plugin's name on the Capacitor bridge (`Capacitor.Plugins.FxmPlayer`). */
export const FXM_PLAYER_PLUGIN = 'FxmPlayer'

/** The most entries one message may queue after the current one. */
export const FXM_PLAYER_MAX_UPCOMING = 50

/**
 * Every code the plugin rejects with:
 *
 * - `BAD_REQUEST`: a malformed message, e.g. an entry without an HTTPS URL or a title
 * - `UNAVAILABLE`: the player service could not be started
 * - `INTERNAL`: the player failed
 */
export const FXM_PLAYER_ERROR_CODES = ['BAD_REQUEST', 'UNAVAILABLE', 'INTERNAL'] as const

/** One of {@link FXM_PLAYER_ERROR_CODES}. */
export type FxmPlayerErrorCode = (typeof FXM_PLAYER_ERROR_CODES)[number]

/**
 * Where an entry's audio comes from: a resolved stream, fetched with plain `GET`s through the
 * app's OkHttp client and FXM's network rules.
 */
export interface NativeSource {
  /** The HTTPS URL of the whole file. */
  readonly url: string
  /** Headers the URL needs (`StreamOption.requestHeaders`); the player sets them per URL. */
  readonly headers?: Readonly<Record<string, string>>
  /** When the URL stops working, in epoch milliseconds. */
  readonly expiresAt?: number
  /** Whether the URL only works from the IP address that resolved it. */
  readonly ipBound: boolean
  /** The native network ({@link NativeNetwork.id}) it was resolved on. */
  readonly network?: number
}

/** What the media notification and the lock screen show for an entry. */
export interface NativeMetadata {
  readonly title: string
  readonly artists: readonly string[]
  readonly album?: string
  /** An HTTPS image URL. */
  readonly artworkUrl?: string
  readonly durationMs?: number
}

/** One entry of the native queue: a queue item (`uid`) with its resolved source. */
export interface NativeEntry {
  /** Chosen by the web app: unique among the entries it sends, `[A-Za-z0-9._:-]{1,100}`. */
  readonly id: string
  /** The queue item's uid in the web app's player. */
  readonly uid: number
  readonly source: NativeSource
  readonly metadata: NativeMetadata
}

/** How the queue repeats: `one` loops the current entry natively. */
export type NativeRepeat = 'off' | 'all' | 'one'

/** Media3's playback states. */
export type NativePlaybackState = 'idle' | 'buffering' | 'ready' | 'ended'

/** What the native player is doing. */
export interface NativeState {
  /** The current entry, or `null` when the playlist is empty. */
  readonly id: string | null
  readonly positionMs: number
  /** The current entry's duration, or -1 while unknown. */
  readonly durationMs: number
  /** Whether audio is coming out. */
  readonly playing: boolean
  /** Whether it plays as soon as it can. */
  readonly playWhenReady: boolean
  readonly state: NativePlaybackState
}

/** A playback failure, typed like an `EngineError`, with the HTTP status where there was one. */
export interface NativeFailure {
  readonly type: 'network' | 'decode' | 'unsupported' | 'expired'
  readonly status: number | null
  readonly message: string
}

/** The device's network: `id` counts its changes. */
export interface NativeNetwork {
  readonly id: number
  readonly cellular: boolean
}

/** Where the native player is, for a web app that attaches (e.g. after its renderer died). */
export interface NativeSession extends NativeState {
  /** The current entry and the ones queued after it. */
  readonly entries: readonly NativeEntry[]
  /** How the current entry failed, while nothing replaced it. */
  readonly error: NativeFailure | null
  /** What the web app last saved with {@link FxmPlayerPlugin.saveSnapshot}. */
  readonly snapshot: string | null
  readonly network: NativeNetwork
}

/** The events the plugin sends once the web app has attached. */
export interface FxmPlayerEventMap {
  /** The playback state, on every change and about once a second while playing (every 5 s
   * while the app is not on screen). */
  state: NativeState
  /** The native player moved to another entry by itself. */
  transition: {
    readonly from: string | null
    readonly to: string | null
    /**
     * `auto`: the previous entry ended; `repeat`: it loops (repeat one); `skip`: the native
     * player skipped an entry that failed, or followed a system control, while the web app did
     * not answer.
     */
    readonly reason: 'auto' | 'repeat' | 'skip'
  }
  /** An entry failed to play. Act on it (load, pause), or the native player skips it in 30 s. */
  error: NativeFailure & { readonly id: string | null }
  /** An upcoming entry needs a fresh source: its URL expires before it would finish, or it is
   * bound to an earlier network. Send it again with {@link FxmPlayerPlugin.setUpcoming}. */
  request: { readonly id: string; readonly reason: 'expiring' | 'network' }
  /** A system control (notification, lock screen, headset, Bluetooth) asked for next or previous.
   * Acknowledge it ({@link FxmPlayerPlugin.ack}), or the native player acts on it in 8 s. */
  command: { readonly command: 'next' | 'previous' }
  /** The device changed network: IP-bound URLs resolved before may fail now. */
  network: NativeNetwork
}

/** A listener registration, as Capacitor returns it. */
export interface FxmPlayerListenerHandle {
  remove(): Promise<void> | void
}

/** The options of {@link FxmPlayerPlugin.load}. */
export interface NativeLoadOptions {
  readonly entry: NativeEntry
  readonly startAtMs: number
  readonly upcoming: readonly NativeEntry[]
  /** Whether the queue has more items than `upcoming` lists. */
  readonly hasMore: boolean
  readonly repeat: NativeRepeat
}

/** The options of {@link FxmPlayerPlugin.setUpcoming}. */
export interface NativeUpcomingOptions {
  readonly upcoming: readonly NativeEntry[]
  readonly hasMore: boolean
  readonly repeat: NativeRepeat
}

/** The `FxmPlayer` plugin as the Capacitor bridge exposes it. */
export interface FxmPlayerPlugin {
  /** Attaches this page: its events start, and it gets where playback is. */
  attach(): Promise<NativeSession>
  /** Plays `entry` from `startAtMs`, paused until {@link play}, with entries queued after it. An
   * entry already queued with the same bytes is skipped to, keeping its buffer. */
  load(options: NativeLoadOptions): Promise<void>
  /** Replaces the entries queued after the current one; unchanged ones keep their buffer. */
  setUpcoming(options: NativeUpcomingOptions): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(options: { readonly positionMs: number }): Promise<void>
  /** From 0 to 1. */
  setVolume(options: { readonly volume: number }): Promise<void>
  /** Takes over a system control's next or previous ({@link FxmPlayerEventMap.command}). */
  ack(): Promise<void>
  /** Stores state for the next {@link attach}, at most 4 Mi characters; `null` clears it. */
  saveSnapshot(options: { readonly data: string | null }): Promise<void>
  /** Stops playback and forgets the queue. */
  release(): Promise<void>
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
