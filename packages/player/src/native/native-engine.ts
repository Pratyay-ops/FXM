/**
 * The native engine: the player facade's `Engine` on the Android app's Media3 player (stage 6.3).
 *
 * The facade stays in charge while the page runs, exactly as with the direct audio engine: it
 * loads each item, retries failures through the stream lifecycle, and decides what comes next.
 * What changes is that Media3 plays in a foreground service and keeps a deeper queue of resolved
 * items ({@link NativeEngine.connect}), so it crosses track boundaries by itself, gapless and
 * without waiting for JavaScript, which may be slow in the background, frozen or gone (its
 * WebView renderer killed). The engine then lets the facade catch up: it reports the item that
 * ended, and when the facade loads the item Media3 already plays, it adopts it instead of
 * loading it again. When the facade moves without loading (next or previous while paused), or
 * stops, Media3 follows it.
 *
 * @module
 */

import {
  APP_NAME,
  type AudioCandidate,
  candidateKey,
  currentQueueItem,
  FxmError,
  nextQueueItem,
  type QueueItem,
  type QueueState,
  type StreamOption,
  URL_REFRESH_MARGIN_MS,
  upcomingQueueItems,
} from '@fxm/core'
import { Emitter, type Listener } from '../emitter'
import {
  type Engine,
  EngineError,
  type EngineEventMap,
  type EngineEventType,
  type PlaybackSource,
  type PlaySupport,
} from '../engine'
import type { DisposableNetworkMonitor } from '../lifecycle/network'
import type { Player, PlayerState } from '../player'
import type { ResolvedStream, ResolveRequest, StreamResolver } from '../resolver'
import { nativeEntry, nativeSource, nativeSupport, restoreStream } from './entries'
import {
  FXM_PLAYER_MAX_UPCOMING,
  type FxmPlayerEntry,
  type FxmPlayerEventMap,
  type FxmPlayerFailure,
  type FxmPlayerListenerHandle,
  type FxmPlayerPlugin,
  type FxmPlayerRepeat,
  type FxmPlayerSession,
  type FxmPlayerState,
  findFxmPlayerPlugin,
  fxmPlayerErrorCode,
} from './plugin'

/** What the engine reads from, and asks of, the player it serves ({@link NativeEngine.connect}). */
export type NativePlaybackPlayer = Pick<
  Player,
  'getState' | 'subscribe' | 'next' | 'previous' | 'play' | 'restore'
>

/** Options for {@link NativeEngine}. */
export interface NativeEngineOptions {
  /** The plugin. Default: the one the Capacitor bridge exposes ({@link findFxmPlayerPlugin}). */
  plugin?: FxmPlayerPlugin
  /** The clock, in epoch milliseconds. Default: `Date.now`. */
  now?: () => number
}

/** Options for {@link NativeEngine.connect}. */
export interface NativeConnectOptions {
  /** The player the engine plays for: the one it is the engine of. */
  player: NativePlaybackPlayer
  /**
   * Resolves the upcoming items: the stream lifecycle, the same resolver the player uses (not
   * the {@link NativeEngine.wrapResolver} wrapper around it).
   */
  resolver: StreamResolver
  /** How many upcoming items to keep resolved in the native queue. Default: 5, at most 50. */
  depth?: number
  /** Stop adding items once this much audio is queued natively, in ms. Default: 40 minutes. */
  aheadMs?: number
}

/** What {@link NativeEngine.connect} resolves with. */
export interface NativeConnection {
  /**
   * Whether connecting picked up a native session: the page was recreated (its WebView renderer
   * died) while Media3 kept playing, and the player now has Media3's queue and position,
   * restored from the snapshot. The app skips restoring its own saved queue then.
   */
  readonly resumed: boolean
  /**
   * Stops playing for the player: no deeper native queue, system controls or snapshots any more.
   * What Media3 holds plays on, and the engine stays the player's engine.
   */
  disconnect(): void
}

/** The defaults behind {@link NativeConnectOptions}. */
export const NATIVE_ENGINE_DEFAULTS = Object.freeze({
  depth: 5,
  aheadMs: 40 * 60_000,
  /** What an item without a duration counts as, for `aheadMs`. */
  assumedDurationMs: 4 * 60_000,
  /** At most this many queue items go into a snapshot, around the current one. */
  snapshotItems: 400,
})

/** The snapshot the engine stores natively, to restore the queue after the page came back. */
interface Snapshot {
  readonly v: 1
  readonly queue: QueueState
}

/** What the engine knows about an entry it sent, or found in Media3. */
interface Known {
  readonly entry: FxmPlayerEntry
  /**
   * The queue item it plays, by uid and track: an entry never plays for another item, whose uid
   * a restored queue may reuse. `undefined` when unknown (it then plays for no item).
   */
  readonly item: { readonly uid: number; readonly track: string } | undefined
  /** The stream it plays, for the facade's resolution when it takes the entry over. */
  readonly stream: StreamOption | undefined
  /** The candidate the stream was resolved from, when the resolver said. */
  readonly candidate: AudioCandidate | undefined
}

/**
 * An entry Media3 holds that the facade has not loaded yet: Media3 moved on to it by itself, or
 * holds it for the facade's current item (after a page restart, or a move while paused).
 */
interface Passed {
  readonly entryId: string
  /** Where the facade loads it unless the user moves the position meanwhile, in ms. */
  readonly expectMs: number
  /** How it failed meanwhile, reported once the facade loads it. */
  failure?: EngineError
}

/** An upcoming item, resolved ahead. */
interface Resolved {
  readonly stream: StreamOption
  readonly candidate: AudioCandidate | undefined
  /** The item's candidate when it was resolved (`candidateKey`), or `''`. */
  readonly candidateKey: string
  /** The item's track id. */
  readonly track: string
  /** The native network it was resolved on. */
  readonly network: number
}

/** An upcoming entry in the native queue. */
interface Queued {
  readonly entryId: string
  /** The item's candidate when it was queued (`candidateKey`), or `''`. */
  readonly candidateKey: string
  /** The item's track id. */
  readonly track: string
}

/** What was last reported to the facade for the loaded entry. */
interface Reported {
  phase: 'paused' | 'playing' | 'waiting' | 'ended' | 'idle'
  durationMs: number
  ready: boolean
  positionMs: number
}

/** The native queue's tail, as sent with `setUpcoming`. */
interface Plan {
  readonly entries: readonly FxmPlayerEntry[]
  readonly hasMore: boolean
  readonly repeat: FxmPlayerRepeat
  /** The first item that still needs resolving, if any may. */
  readonly missing?: QueueItem
}

/** The engines alive, by plugin: one per page. */
const liveEngines = new WeakMap<FxmPlayerPlugin, NativeEngine>()

const NOT_CONNECTED: NativeConnection = Object.freeze({ resumed: false, disconnect() {} })

function candidateOf(item: QueueItem): string {
  return item.candidate === undefined ? '' : candidateKey(item.candidate)
}

function wantsPlayback(status: PlayerState['status']): boolean {
  return status === 'loading' || status === 'playing'
}

function engineError(failure: FxmPlayerFailure): EngineError {
  return new EngineError(
    failure.type,
    failure.message,
    failure.status === null ? {} : { cause: { status: failure.status } },
  )
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message !== '' ? message : 'no reason given'
}

/**
 * The engine error for a command the plugin rejected: a refused stream (`BAD_REQUEST`) is
 * `unsupported`, a native player that is unavailable or failed is a `network` failure.
 */
function commandError(error: unknown, command: 'load' | 'play'): EngineError {
  const code = fxmPlayerErrorCode(error)
  if (command === 'load' && code === 'BAD_REQUEST') {
    return new EngineError(
      'unsupported',
      `The native player refused the stream: ${messageOf(error)}`,
      {
        cause: error,
      },
    )
  }
  const what =
    code === 'UNAVAILABLE' ? 'is not available' : `could not ${command} (${code ?? 'unknown'})`
  return new EngineError('network', `The native player ${what}: ${messageOf(error)}`, {
    cause: error,
  })
}

/** Logs a rejected command that nothing waits for. */
function logFailure(command: string): (error: unknown) => void {
  return (error) => console.error(`FxmPlayer.${command} failed`, error)
}

function phaseOf(state: FxmPlayerState): Reported['phase'] {
  if (state.state === 'ended') return 'ended'
  if (state.playing) return 'playing'
  if (state.state === 'idle') return 'idle'
  if (state.playWhenReady && state.state === 'buffering') return 'waiting'
  return 'paused'
}

function freshReported(): Reported {
  return { phase: 'paused', durationMs: -1, ready: false, positionMs: -1 }
}

function durationOf(item: QueueItem): number {
  const { durationMs } = item.track
  return durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0
    ? durationMs
    : NATIVE_ENGINE_DEFAULTS.assumedDurationMs
}

/** `queue` with at most `limit` items around the current one, so a snapshot stays small. */
function trimQueue(queue: QueueState, limit: number): QueueState {
  if (queue.items.length <= limit) return queue
  const start = Math.min(
    Math.max(queue.index - Math.floor(limit / 2), 0),
    queue.items.length - limit,
  )
  const items = queue.items.slice(start, start + limit)
  const kept = new Set(items.map((item) => item.uid))
  return {
    ...queue,
    items,
    index: queue.index - start,
    playedUids: queue.playedUids.filter((uid) => kept.has(uid)),
    ...(queue.unshuffled === undefined
      ? {}
      : { unshuffled: queue.unshuffled.filter((uid) => kept.has(uid)) }),
  }
}

function parseSnapshot(data: string | null): Snapshot | undefined {
  if (data === null) return undefined
  try {
    const value = JSON.parse(data) as unknown
    if (typeof value !== 'object' || value === null) return undefined
    const { v, queue } = value as { v?: unknown; queue?: unknown }
    return v === 1 && typeof queue === 'object' && queue !== null
      ? { v: 1, queue: queue as QueueState }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The track id of each item in a snapshot's queue, by uid. The snapshot is data from storage:
 * `restoreQueue` checks the queue itself, this only reads what it can.
 */
function snapshotTracks(snapshot: Snapshot | undefined): ReadonlyMap<number, string> {
  const tracks = new Map<number, string>()
  const items: unknown = (snapshot?.queue as { items?: unknown } | undefined)?.items
  if (!Array.isArray(items)) return tracks
  for (const item of items) {
    const { uid, track } = (item ?? {}) as { uid?: unknown; track?: { id?: unknown } }
    if (typeof uid === 'number' && typeof track?.id === 'string') tracks.set(uid, track.id)
  }
  return tracks
}

/** The queue items that follow the current one in play order, wrapping around for repeat all. */
function upcomingInOrder(queue: QueueState): readonly QueueItem[] {
  const after = upcomingQueueItems(queue)
  if (queue.repeat !== 'all') return after
  return [...after, ...queue.items.slice(0, Math.max(0, queue.index))]
}

/**
 * Plays the player facade's streams on the Android app's native player, Media3 in a foreground
 * service with the media notification and lock-screen controls (the `FxmPlayer` plugin).
 *
 * ```ts
 * const engine = await NativeEngine.create() // Android only; undefined elsewhere
 * const lifecycle = new StreamLifecycle({ ...options, network: engine?.network ?? createBrowserNetworkMonitor() })
 * const player = new Player({
 *   engine: engine ?? new DirectAudioEngine(),
 *   resolver: engine?.wrapResolver(lifecycle) ?? lifecycle,
 * })
 * lifecycle.attach(player)
 * const native = await engine?.connect({ player, resolver: lifecycle })
 * if (!native?.resumed) restoreSavedQueue(player) // the app's own restore comes after connect
 * ```
 *
 * **One engine per page.** Creating an engine attaches it to the app's single native player:
 * it gets Media3's events and drives it, and {@link destroy} releases Media3 for the whole app.
 * While one engine is alive, creating another on the same plugin throws.
 *
 * Without {@link connect} it is a plain engine: one stream at a time, plus the next one the
 * facade preloads. {@link connect} adds the deeper native queue, the system's next and previous
 * buttons, following the facade when it moves while paused, and picking up where the native
 * player is after the page was recreated.
 */
export class NativeEngine implements Engine {
  /**
   * The device's network, from Android's own callbacks, which keep arriving with the screen off:
   * the stream lifecycle's URL cache follows it (pass it as its `network`).
   */
  readonly network: DisposableNetworkMonitor

  readonly #plugin: FxmPlayerPlugin
  readonly #now: () => number
  readonly #events = new Emitter<EngineEventMap>()
  readonly #ready: Promise<FxmPlayerSession | undefined>
  readonly #handles: FxmPlayerListenerHandle[] = []
  readonly #networkListeners = new Set<() => void>()
  readonly #prefix = `n${Math.floor(Math.random() * 2 ** 32).toString(36)}`
  #sequence = 0
  #attached = false
  #destroyed = false
  #volume = 1
  #muted = false
  /** Commands that change whether Media3 plays (load, play, pause, release) not answered yet. */
  #commands = 0
  /** Inside the engine's own `ended` event: the facade's pause there lets go of the item. */
  #ending = 0

  /** The entry the facade loaded last. */
  #loaded: string | undefined
  /** Entries Media3 holds beyond it, oldest first; the facade adopts them in turn. */
  #trail: Passed[] = []
  /** Media3 looped the entry (repeat one): the facade's restart must not seek it back. */
  #repeating = false
  /** Media3's last reported state. */
  #state: FxmPlayerState | undefined
  #reported: Reported = freshReported()
  /** Every entry the engine knows, by id, least recently used first. */
  readonly #known = new Map<string, Known>()
  #networkId = 0
  #cellular = false

  // What connect() adds.
  #player: NativePlaybackPlayer | undefined
  #resolver: StreamResolver | undefined
  #depth: number = NATIVE_ENGINE_DEFAULTS.depth
  #aheadMs: number = NATIVE_ENGINE_DEFAULTS.aheadMs
  /** Upcoming items resolved ahead, by uid. */
  readonly #resolved = new Map<number, Resolved>()
  /** Upcoming items whose URL Media3 asked to refresh, with the stream that expires. */
  readonly #expiring = new Map<number, StreamOption>()
  /** The entry id of each upcoming item in the native queue, by uid. */
  readonly #upcomingIds = new Map<number, string>()
  /** The upcoming entries Media3 has, by uid. */
  #queued = new Map<number, Queued>()
  /** Items that failed to resolve ahead; tried again after the queue or the network changes. */
  readonly #failedAhead = new Set<number>()
  #resolving: { readonly uid: number; readonly abort: AbortController } | undefined
  /** The native queue's tail as last sent, while Media3 has it. */
  #sent: string | undefined
  #feedQueued = false
  #snapshotQueued = false
  #reconcileQueued = false
  /** The snapshot Media3 has: `null` for none, `undefined` when unknown. */
  #lastSnapshot: string | null | undefined = null
  #connection: Promise<NativeConnection> | undefined
  #disconnect: (() => void) | undefined

  /**
   * Attaches to the app's native player (see the class's "One engine per page").
   *
   * @throws an `Unsupported` `FxmError` without the plugin, i.e. outside the Android app, and an
   * `Error` while another engine is alive on the plugin.
   */
  constructor(options: NativeEngineOptions = {}) {
    const plugin = options.plugin ?? findFxmPlayerPlugin()
    if (plugin === undefined) {
      throw new FxmError(
        'Unsupported',
        'The native player needs the Android app’s FxmPlayer plugin',
      )
    }
    if (liveEngines.has(plugin)) {
      throw new Error('Another NativeEngine plays on the FxmPlayer plugin: destroy it first')
    }
    liveEngines.set(plugin, this)
    this.#plugin = plugin
    this.#now = options.now ?? Date.now
    this.network = this.#createNetworkMonitor()
    this.#ready = this.#start()
  }

  /**
   * A native engine on the Android app's plugin (see the class's "One engine per page"), or
   * `undefined` elsewhere. It cannot tell whether attaching to the native player works; if that
   * fails, the engine logs it and plays without events. {@link create} waits and tells.
   *
   * @throws an `Error` while another engine is alive on the plugin.
   */
  static ifAvailable(global: object = globalThis): NativeEngine | undefined {
    const plugin = findFxmPlayerPlugin(global)
    return plugin === undefined ? undefined : new NativeEngine({ plugin })
  }

  /**
   * A native engine attached to the Android app's native player, or `undefined` outside the app
   * or when attaching fails (the player service is unavailable), so the app can fall back to the
   * direct audio engine.
   *
   * @throws an `Error` while another engine is alive on the plugin.
   */
  static async create(options: NativeEngineOptions = {}): Promise<NativeEngine | undefined> {
    const plugin = options.plugin ?? findFxmPlayerPlugin()
    if (plugin === undefined) return undefined
    const engine = new NativeEngine({ ...options, plugin })
    await engine.#ready
    if (engine.#attached && !engine.#destroyed) return engine
    engine.#teardown()
    return undefined
  }

  // --- The engine ------------------------------------------------------------------------------

  /**
   * Loads `source` paused at `startAtMs`. Unlike other engines, when Media3 already plays an
   * entry for the item (it moved on by itself, or holds it after a page restart or a move while
   * paused), the engine adopts that entry instead: nothing is loaded again, Media3 keeps playing
   * (unless the facade paused meanwhile) and the facade hears Media3's position. It seeks only
   * when the facade asks for another position than the one it had when Media3 took the entry.
   * An entry queued for the item is skipped to, keeping its buffer. A stream the plugin refuses
   * arrives as an `error` event: `unsupported` for a refused stream, `network` when the native
   * player is unavailable.
   */
  async load(source: PlaybackSource, startAtMs = 0): Promise<void> {
    if (this.#destroyed) return
    this.#repeating = false
    const { item, stream } = source
    const at =
      item === undefined ? -1 : this.#trail.findIndex((passed) => this.#isFor(passed.entryId, item))
    if (at >= 0) {
      this.#adopt(at, startAtMs)
      return
    }
    this.#trail = []
    const queuedId = item === undefined ? undefined : this.#queuedFor(item)
    const id = queuedId ?? this.#nextId()
    if (item !== undefined) this.#upcomingIds.delete(item.uid)
    const entry: FxmPlayerEntry =
      item === undefined
        ? {
            id,
            uid: 0,
            source: nativeSource(stream, this.#networkId),
            metadata: { title: APP_NAME, artists: [] },
          }
        : nativeEntry(id, item, stream, this.#networkId)
    this.#remember(entry, item, stream, undefined)
    this.#loaded = id
    this.#reported = freshReported()
    const plan = this.#plan()
    const signature = this.#signature(plan)
    this.#sent = signature
    try {
      await this.#command((plugin) =>
        plugin.load({
          entry,
          startAtMs: Math.max(0, Math.floor(startAtMs)),
          upcoming: plan.entries,
          hasMore: plan.hasMore,
          repeat: plan.repeat,
        }),
      )
    } catch (error) {
      if (this.#sent === signature) this.#sent = undefined
      if (this.#loaded !== id) return
      queueMicrotask(() => {
        if (this.#loaded === id && !this.#destroyed)
          this.#emit('error', commandError(error, 'load'))
      })
      return
    }
    if (plan.missing !== undefined) this.#resolveAhead(plan.missing)
  }

  /** Plays. A rejected play arrives as an `error` event of the loaded entry. */
  async play(): Promise<void> {
    if (this.#destroyed) return
    this.#repeating = false
    const id = this.#loaded
    try {
      await this.#command((plugin) => plugin.play())
    } catch (error) {
      if (id !== undefined && this.#loaded === id && !this.#destroyed) {
        this.#emit('error', commandError(error, 'play'))
      }
    }
  }

  /**
   * Pauses Media3, except for the facade letting go of the item that ended inside the engine's
   * own `ended` event, as it moves on to the item Media3 already plays: that one keeps playing,
   * and if the facade does not take it over (its queue ended or changed), Media3 stops then.
   */
  pause(): void {
    if (this.#destroyed || this.#ending > 0) return
    this.#pauseNative()
  }

  /**
   * Seeks within the loaded entry. Ignored while Media3 has moved past it, and once right after
   * Media3 looped the entry itself (repeat one), when the facade's restart has nothing to do.
   */
  seek(positionMs: number): void {
    if (this.#destroyed || !Number.isFinite(positionMs) || this.#trail.length > 0) return
    // Media3 looped the entry itself; the facade's restart has nothing left to do.
    if (this.#repeating && positionMs === 0) {
      this.#repeating = false
      return
    }
    this.#seekNative(positionMs)
  }

  setVolume(volume: number): void {
    this.#volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1))
    this.#sendVolume()
  }

  setMuted(muted: boolean): void {
    this.#muted = muted
    this.#sendVolume()
  }

  /**
   * Without {@link connect}, queues the facade's next item as Media3's only upcoming entry, and
   * `null` drops it. Connected, the native queue follows the facade's queue (the plan is
   * authoritative): a stream the facade prepared only fills in an item the engine could not
   * resolve, and `null` changes nothing.
   */
  preload(source: PlaybackSource | null): void {
    if (this.#destroyed) return
    const item = source?.item
    const usable = source !== null && item !== undefined && nativeSupport(source.stream) !== 'no'
    if (this.#player === undefined) {
      if (!usable) {
        if (this.#upcomingIds.size === 0) return
        this.#upcomingIds.clear()
        void this.#call((plugin) =>
          plugin.setUpcoming({ upcoming: [], hasMore: false, repeat: 'off' }),
        ).catch(logFailure('setUpcoming'))
        return
      }
      const id = this.#queuedFor(item) ?? this.#nextId()
      this.#upcomingIds.clear()
      this.#upcomingIds.set(item.uid, id)
      const entry = nativeEntry(id, item, source.stream, this.#networkId)
      this.#remember(entry, item, source.stream, undefined)
      void this.#call((plugin) =>
        plugin.setUpcoming({ upcoming: [entry], hasMore: false, repeat: 'off' }),
      ).catch(logFailure('setUpcoming'))
      return
    }
    if (!usable) return
    if (!this.#resolved.has(item.uid)) {
      this.#resolved.set(item.uid, {
        stream: source.stream,
        candidate: undefined,
        candidateKey: candidateOf(item),
        track: item.track.id,
        network: this.#networkId,
      })
    }
    this.#scheduleFeed()
  }

  /**
   * How sure Media3 is that it plays `stream`: `no` unless it is a progressive, uncapped stream
   * at an absolute HTTPS URL with headers the plugin takes; `probably` for the formats every
   * supported Android version plays, `maybe` for the rest.
   */
  canPlay(stream: StreamOption): PlaySupport {
    return nativeSupport(stream)
  }

  on<K extends EngineEventType>(
    type: K,
    listener: (payload: EngineEventMap[K]) => void,
  ): () => void {
    return this.#events.on(type, listener as Listener<EngineEventMap[K]>)
  }

  /** Stops Media3 and releases it for the whole app (its queue and snapshot too). */
  destroy(): void {
    if (this.#destroyed) return
    this.#teardown()
    void this.#plugin.release().catch(logFailure('release'))
  }

  /**
   * The resolver to give the player: `resolver`, except that the facade's `play` resolution of
   * an item Media3 already holds for it, which it takes over ({@link load}), answers with the
   * stream Media3 plays. No request is made, so a recreated page, or one whose URL cache missed,
   * takes the entry over without the network, and a failed request cannot switch Media3 away
   * from a track that plays fine.
   */
  wrapResolver(resolver: StreamResolver): StreamResolver {
    return {
      resolve: (item, request) => {
        const taken = request.reason === 'play' ? this.#heldStream(item, request) : undefined
        return taken === undefined ? resolver.resolve(item, request) : Promise.resolve(taken)
      },
    }
  }

  // --- The native queue ------------------------------------------------------------------------

  /**
   * Plays for `player`: keeps the next items resolved in the native queue (up to `depth` items or
   * `aheadMs` of audio, at the resolver's prefetch priority, so within the request budget),
   * hands the system's next and previous buttons to the player, makes Media3 follow the player
   * when it moves without loading or stops, and stores its queue natively. When the page was
   * recreated while the native player kept playing (its WebView renderer was killed), it restores
   * the queue there and adopts what plays ({@link NativeConnection.resumed}).
   *
   * Connect before the app restores or starts a queue of its own. If the player already has a
   * queue, the engine takes Media3's entry over only when it plays the player's current item,
   * and otherwise releases Media3. Connecting again with the same player resolves with the same
   * connection; another player is refused with an error in the console.
   */
  connect(options: NativeConnectOptions): Promise<NativeConnection> {
    if (this.#destroyed) return Promise.resolve(NOT_CONNECTED)
    if (this.#connection !== undefined) {
      if (options.player === this.#player) return this.#connection
      console.error(new Error('This NativeEngine already plays for another player'))
      return Promise.resolve(NOT_CONNECTED)
    }
    const connection = this.#connect(options)
    this.#connection = connection
    return connection
  }

  async #connect(options: NativeConnectOptions): Promise<NativeConnection> {
    const { player, resolver } = options
    this.#player = player
    this.#resolver = resolver
    this.#depth = Math.max(
      0,
      Math.min(Math.floor(options.depth ?? NATIVE_ENGINE_DEFAULTS.depth), FXM_PLAYER_MAX_UPCOMING),
    )
    this.#aheadMs = Math.max(0, options.aheadMs ?? NATIVE_ENGINE_DEFAULTS.aheadMs)
    const session = await this.#ready
    if (this.#destroyed || this.#player !== player) return NOT_CONNECTED
    const resumed =
      session !== undefined && this.#loaded === undefined && this.#resync(session, player)
    const stop = player.subscribe((state, previous) => this.#onPlayerState(state, previous))
    const disconnect = () => {
      stop()
      if (this.#disconnect !== disconnect) return
      this.#disconnect = undefined
      this.#connection = undefined
      this.#player = undefined
      this.#resolver = undefined
      this.#resolving?.abort.abort()
      this.#resolving = undefined
    }
    this.#disconnect = disconnect
    this.#scheduleFeed()
    this.#scheduleSnapshot()
    return { resumed, disconnect }
  }

  /**
   * Picks up where the native player is, after the page was recreated. Returns whether the
   * player has Media3's queue now. Never awaits the player: taking the entry over may need it to
   * resolve, and connecting does not wait for that.
   */
  #resync(session: FxmPlayerSession, player: NativePlaybackPlayer): boolean {
    const current = session.entries.find((entry) => entry.id === session.id)
    if (current === undefined) return false
    const snapshot = parseSnapshot(session.snapshot)
    const tracks = snapshotTracks(snapshot)
    if (player.getState().queue.items.length > 0) {
      return this.#handOver(session, current, tracks, player)
    }
    // Without a snapshot the page cannot tell what Media3 plays: it plays on, under its own
    // controls, until the app plays something (the app's restore pauses it, see #reconcile).
    if (snapshot === undefined) return false
    const ended = session.state === 'ended'
    const positionMs = ended ? 0 : session.positionMs
    // restoreQueue checks the stored queue and keeps every valid uid (`@fxm/core`'s contract),
    // so Media3's entries still name the restored items. This only finds the current one.
    const items: unknown = (snapshot.queue as { items?: unknown }).items
    const index = Array.isArray(items)
      ? items.findIndex((item: unknown) => (item as { uid?: unknown } | null)?.uid === current.uid)
      : -1
    const saved = index >= 0 ? { ...snapshot.queue, index } : snapshot.queue
    if (!player.restore(saved, positionMs)) return false
    const queue = player.getState().queue
    this.#learnSession(session, tracks, queue)
    const item = currentQueueItem(queue)
    if (item === undefined) return true
    if (!this.#isFor(current.id, item)) {
      // The restored queue lost Media3's item (the catalog mode hides it now): the player's own
      // item takes over, playing if Media3 played.
      this.#pauseNative()
      if (session.playWhenReady && !ended) void player.play()
      return true
    }
    if (ended) {
      // Media3 played everything it had: the queue goes on with its next item, as the player
      // sees it (shuffle, repeat all).
      const next = nextQueueItem(queue)
      if (next !== undefined && next.uid !== item.uid) {
        void player.next().then(() => player.play())
      }
      return true
    }
    this.#trail = [
      {
        entryId: current.id,
        expectMs: positionMs,
        ...(session.error === null ? {} : { failure: engineError(session.error) }),
      },
    ]
    if (session.playWhenReady) void player.play()
    return true
  }

  /**
   * The app restored or started a queue of its own before connecting: Media3's entry is taken
   * over when it plays the player's current item, and released otherwise.
   */
  #handOver(
    session: FxmPlayerSession,
    current: FxmPlayerEntry,
    tracks: ReadonlyMap<number, string>,
    player: NativePlaybackPlayer,
  ): boolean {
    const state = player.getState()
    this.#learnSession(session, tracks, state.queue)
    const item = currentQueueItem(state.queue)
    if (item !== undefined && session.state !== 'ended' && this.#isFor(current.id, item)) {
      this.#trail = [
        {
          entryId: current.id,
          expectMs: state.positionMs,
          ...(session.error === null ? {} : { failure: engineError(session.error) }),
        },
      ]
      if (session.playWhenReady && !wantsPlayback(state.status)) void player.play()
      return true
    }
    this.#release()
    return false
  }

  /** Learns the session's entries: the queue items they play, their streams, the queued ones. */
  #learnSession(
    session: FxmPlayerSession,
    tracks: ReadonlyMap<number, string>,
    queue: QueueState,
  ): void {
    const items = new Map(queue.items.map((item) => [item.uid, item]))
    for (const entry of session.entries) {
      const track = tracks.get(entry.uid)
      const known: Known = {
        entry,
        item: track === undefined ? undefined : { uid: entry.uid, track },
        stream: restoreStream(entry),
        candidate: undefined,
      }
      this.#setKnown(entry.id, known)
      const item = items.get(entry.uid)
      if (entry.id === session.id || item === undefined || item.track.id !== track) continue
      // Media3's queue stays as it is while the new page resolves its items again.
      this.#upcomingIds.set(entry.uid, entry.id)
      this.#queued.set(entry.uid, {
        entryId: entry.id,
        candidateKey: candidateOf(item),
        track: item.track.id,
      })
    }
  }

  // --- Following the player --------------------------------------------------------------------

  #onPlayerState(state: PlayerState, previous: PlayerState): void {
    if (state.queue !== previous.queue) {
      if (state.queue.items !== previous.queue.items) {
        this.#failedAhead.clear()
        this.#forgetGone(state.queue)
      }
      this.#scheduleFeed()
      this.#scheduleSnapshot()
    }
    if (state.queue.items.length === 0) {
      // The queue was emptied: Media3 lets go, and the notification goes away.
      if (previous.queue.items.length > 0) this.#release()
      return
    }
    if (
      state.status !== previous.status ||
      currentQueueItem(state.queue) !== currentQueueItem(previous.queue)
    ) {
      this.#scheduleReconcile()
    }
  }

  #scheduleReconcile(): void {
    if (this.#reconcileQueued || this.#destroyed) return
    this.#reconcileQueued = true
    queueMicrotask(() => {
      this.#reconcileQueued = false
      this.#reconcile()
    })
  }

  /**
   * While the player does not want playback (paused, ended, stopped), Media3 does not play, and
   * holds the player's current item where it can: an entry the player keeps (its queue ended
   * there after Media3 moved on), or one queued for the item (next or previous while paused),
   * which the player adopts when it plays. Otherwise its entry is dropped, so Media3's events no
   * longer reach the player until it loads its item.
   */
  #reconcile(): void {
    const player = this.#player
    if (player === undefined || this.#destroyed) return
    const { status, queue, positionMs } = player.getState()
    if (wantsPlayback(status)) return
    const state = this.#state
    if (state?.playWhenReady && state.state !== 'ended') this.#pauseNative()
    const item = currentQueueItem(queue)
    if (item === undefined || this.#isFor(this.#nativeId(), item)) return
    const loaded = this.#loaded
    if (loaded !== undefined && this.#trail.length > 0 && this.#isFor(loaded, item)) {
      this.#cue(loaded, item, status === 'ended' ? 0 : positionMs, true)
      return
    }
    const queued = this.#queuedFor(item)
    if (queued !== undefined) {
      this.#cue(queued, item, positionMs, false)
      return
    }
    this.#trail = []
    this.#loaded = undefined
  }

  /**
   * Makes Media3 hold entry `entryId` for `item` at `startAtMs`, paused unless `play`: as the
   * loaded entry (`asLoaded`, the player still has it), or as one the player adopts when it
   * loads the item.
   */
  #cue(entryId: string, item: QueueItem, startAtMs: number, asLoaded: boolean, play = false): void {
    const known = this.#known.get(entryId)
    if (known === undefined) return
    const at = Math.max(0, Math.floor(startAtMs))
    this.#upcomingIds.delete(item.uid)
    this.#repeating = false
    if (asLoaded) {
      this.#trail = []
      this.#loaded = entryId
      // Media3 starts where the player already is: nothing to report until that changes.
      this.#reported = { phase: 'paused', durationMs: -1, ready: false, positionMs: at }
    } else {
      this.#trail = [{ entryId, expectMs: at }]
      this.#loaded = undefined
      this.#reported = freshReported()
    }
    const plan = this.#plan()
    const signature = this.#signature(plan)
    this.#sent = signature
    void this.#command((plugin) =>
      plugin.load({
        entry: known.entry,
        startAtMs: at,
        upcoming: plan.entries,
        hasMore: plan.hasMore,
        repeat: plan.repeat,
      }),
    ).then(
      () => {
        if (plan.missing !== undefined) this.#resolveAhead(plan.missing)
      },
      (error) => {
        if (this.#sent === signature) this.#sent = undefined
        // Media3 still holds what it had: nothing of it may count as the player's item.
        if (this.#nativeId() === entryId) {
          this.#trail = []
          this.#loaded = undefined
        }
        logFailure('load')(error)
      },
    )
    // Right behind the load, in the bridge's order.
    if (play) void this.#command((plugin) => plugin.play()).catch(logFailure('play'))
  }

  // --- Native events ---------------------------------------------------------------------------

  async #start(): Promise<FxmPlayerSession | undefined> {
    try {
      await Promise.all([
        this.#listen('state', (state) => this.#onState(state)),
        this.#listen('transition', (event) => this.#onTransition(event)),
        this.#listen('error', (event) => this.#onError(event)),
        this.#listen('request', (event) => this.#onRequest(event)),
        this.#listen('command', (event) => this.#onCommand(event)),
        this.#listen('network', (event) => this.#onNetwork(event)),
      ])
      const session = await this.#plugin.attach()
      if (this.#destroyed) return undefined
      this.#attached = true
      this.#networkId = session.network.id
      this.#cellular = session.network.cellular
      this.#state = session
      return session
    } catch (error) {
      console.error(error)
      return undefined
    }
  }

  async #listen<K extends keyof FxmPlayerEventMap>(
    name: K,
    listener: (event: FxmPlayerEventMap[K]) => void,
  ): Promise<void> {
    const handle = await this.#plugin.addListener(name, (event) => {
      if (this.#destroyed) return
      try {
        listener(event)
      } catch (error) {
        console.error(error)
      }
    })
    if (this.#destroyed) void Promise.resolve(handle.remove()).catch(() => {})
    else this.#handles.push(handle)
  }

  #onState(state: FxmPlayerState): void {
    const before = this.#state
    this.#state = state
    this.#report(state)
    this.#onSystemPlay(before, state)
  }

  /** Turns Media3's state for the loaded entry into the engine's events. */
  #report(state: FxmPlayerState): void {
    const loaded = this.#loaded
    if (loaded === undefined || state.id !== loaded || this.#trail.length > 0) return
    const reported = this.#reported
    if (state.durationMs > 0 && state.durationMs !== reported.durationMs) {
      reported.durationMs = state.durationMs
      this.#emit('durationchange', state.durationMs)
    }
    if (state.state === 'ready' && !reported.ready) {
      reported.ready = true
      this.#emit('canplay', undefined)
    }
    const phase = phaseOf(state)
    const before = reported.phase
    reported.phase = phase
    if (phase !== before) {
      if (phase === 'playing') this.#emit('play', undefined)
      else if (phase === 'waiting') this.#emit('waiting', undefined)
      else if (
        (phase === 'paused' || phase === 'idle') &&
        (before === 'playing' || before === 'waiting')
      ) {
        // Idle without a failure (a failure arrives first, as an error) is a stop: a pause.
        this.#emit('pause', undefined)
      }
    }
    if (state.positionMs !== reported.positionMs) {
      reported.positionMs = state.positionMs
      this.#emit('timeupdate', state.positionMs)
    }
    if (phase === 'ended' && before !== 'ended') this.#emitEnded()
  }

  /**
   * A system control (notification, lock screen, headset) started Media3 while the player did not
   * want playback: the player plays, adopting what Media3 holds for its item, or loading it while
   * Media3 waits. Only a change that no command of the engine's explains counts.
   */
  #onSystemPlay(before: FxmPlayerState | undefined, state: FxmPlayerState): void {
    const player = this.#player
    if (player === undefined || this.#commands > 0) return
    if (!state.playWhenReady || before === undefined || before.playWhenReady) return
    const { status, queue } = player.getState()
    if (wantsPlayback(status)) return
    const item = currentQueueItem(queue)
    if (item === undefined) return
    if (!this.#isFor(this.#nativeId(), item)) this.#pauseNative()
    void player.play()
  }

  #onTransition(event: FxmPlayerEventMap['transition']): void {
    const to = event.to
    if (to === null) return
    if (event.reason === 'repeat') {
      if (this.#trail.length > 0 || to !== this.#loaded) return
      this.#repeating = true
      this.#reported = { ...freshReported(), durationMs: this.#reported.durationMs, ready: true }
      this.#emitEnded()
      return
    }
    if (event.from !== this.#nativeId()) return
    const uid = this.#known.get(to)?.item?.uid
    if (uid !== undefined && this.#upcomingIds.get(uid) === to) this.#upcomingIds.delete(uid)
    this.#trail.push({ entryId: to, expectMs: 0 })
    // Only the first step needs the player: it catches up through the rest one at a time.
    if (this.#trail.length > 1) return
    const player = this.#player
    if (player !== undefined) {
      const { status } = player.getState()
      if (status === 'paused') {
        // The user paused as Media3 crossed the boundary: the player follows to its next item,
        // still paused, and adopts Media3's entry when it plays. Where it has none (its queue
        // ends there), Media3 follows the player instead.
        void player.next().then(() => this.#scheduleReconcile())
        return
      }
      if (!wantsPlayback(status)) {
        this.#reconcile()
        return
      }
    }
    this.#emitEnded()
  }

  /** Tells the player its item ended, then checks that it goes on to what Media3 plays. */
  #emitEnded(): void {
    this.#ending += 1
    try {
      this.#emit('ended', undefined)
    } finally {
      this.#ending -= 1
    }
    this.#checkHandover()
  }

  /**
   * After the player heard that its item ended: if it does not go on to the item Media3 moved
   * to, Media3 stops (the player's queue changed) or follows it (its queue ended there).
   */
  #checkHandover(): void {
    const player = this.#player
    const first = this.#trail[0]
    if (player === undefined || first === undefined) return
    const { status, queue } = player.getState()
    if (wantsPlayback(status)) {
      const item = currentQueueItem(queue)
      if (this.#isFor(first.entryId, item)) return
      const loaded = this.#loaded
      if (item !== undefined && loaded !== undefined && this.#isFor(loaded, item)) {
        // It plays its own item again (repeat one, turned on as Media3 crossed the boundary):
        // Media3 goes back to it.
        this.#cue(loaded, item, 0, true, true)
        return
      }
      // It goes elsewhere: Media3 stops until the player's load replaces what it plays.
      this.#trail = []
      this.#pauseNative()
      return
    }
    this.#reconcile()
  }

  /** The player loads the item Media3 already holds: take it over without loading it again. */
  #adopt(at: number, startAtMs: number): void {
    const passed = this.#trail[at] as Passed
    const rest = this.#trail.slice(at + 1)
    this.#trail = rest
    this.#loaded = passed.entryId
    this.#reported = freshReported()
    // One more try, per track, for items that failed to resolve ahead.
    this.#failedAhead.clear()
    // The user moved the position while the player caught up (Media3 is still on this entry).
    const target = Math.max(0, Math.floor(startAtMs))
    if (rest.length === 0 && Math.abs(target - passed.expectMs) > 1) this.#seekNative(target)
    // The user paused while the player caught up: Media3 pauses now.
    const status = this.#player?.getState().status
    if (status !== undefined && !wantsPlayback(status)) this.#pauseNative()
    queueMicrotask(() => {
      if (this.#destroyed || this.#loaded !== passed.entryId) return
      if (passed.failure !== undefined) this.#emit('error', passed.failure)
      else if (rest.length > 0 && this.#trail[0] === rest[0]) this.#emitEnded()
      else if (this.#trail.length === 0 && this.#state !== undefined) this.#report(this.#state)
    })
    this.#scheduleFeed()
  }

  #onError(event: FxmPlayerEventMap['error']): void {
    const failure = engineError(event)
    const passed = this.#trail.find((entry) => entry.entryId === event.id)
    if (passed !== undefined) {
      passed.failure = failure
      return
    }
    if (this.#loaded === undefined || event.id !== this.#loaded) return
    this.#reported.phase = 'idle'
    this.#emit('error', failure)
  }

  #onRequest(event: FxmPlayerEventMap['request']): void {
    const uid = this.#known.get(event.id)?.item?.uid
    if (uid === undefined || this.#upcomingIds.get(uid) !== event.id) return
    const resolved = this.#resolved.get(uid)
    this.#resolved.delete(uid)
    this.#failedAhead.delete(uid)
    // A URL that expires: let the stream lifecycle drop it from its cache too.
    if (event.reason === 'expiring' && resolved !== undefined)
      this.#expiring.set(uid, resolved.stream)
    this.#scheduleFeed()
  }

  #onCommand(event: FxmPlayerEventMap['command']): void {
    const player = this.#player
    // Without a player, Media3 acts on its own after a moment.
    if (player === undefined) return
    void this.#call((plugin) => plugin.ack()).catch(logFailure('ack'))
    if (event.command === 'next') void player.next()
    else void player.previous()
  }

  #onNetwork(event: FxmPlayerEventMap['network']): void {
    const changed = event.id !== this.#networkId
    this.#networkId = event.id
    this.#cellular = event.cellular
    if (!changed) return
    // The stream lifecycle drops its cached URLs first; the next feed resolves afresh.
    for (const listener of [...this.#networkListeners]) {
      try {
        listener()
      } catch (error) {
        console.error(error)
      }
    }
    this.#failedAhead.clear()
    this.#scheduleFeed()
  }

  #createNetworkMonitor(): DisposableNetworkMonitor {
    const engine = this
    return {
      get id() {
        return `native-${engine.#networkId}`
      },
      get cellular() {
        return engine.#cellular
      },
      subscribe(listener) {
        engine.#networkListeners.add(listener)
        return () => {
          engine.#networkListeners.delete(listener)
        }
      },
      destroy() {
        engine.#networkListeners.clear()
      },
    }
  }

  // --- Feeding the native queue ----------------------------------------------------------------

  #scheduleFeed(): void {
    if (this.#feedQueued || this.#player === undefined || this.#destroyed) return
    this.#feedQueued = true
    queueMicrotask(() => {
      this.#feedQueued = false
      this.#feed()
    })
  }

  #feed(): void {
    const player = this.#player
    if (player === undefined || this.#destroyed) return
    // Only while Media3 is on the player's current item; while it is ahead (the player catches
    // up) its queue is fine as it is.
    if (!this.#isFor(this.#nativeId(), currentQueueItem(player.getState().queue))) return
    const plan = this.#plan()
    if (plan.missing !== undefined) this.#resolveAhead(plan.missing)
    const signature = this.#signature(plan)
    if (signature === this.#sent) return
    this.#sent = signature
    void this.#call((plugin) =>
      plugin.setUpcoming({ upcoming: plan.entries, hasMore: plan.hasMore, repeat: plan.repeat }),
    ).catch((error) => {
      // Media3 kept its old tail: the next feed sends this one again.
      if (this.#sent === signature) this.#sent = undefined
      logFailure('setUpcoming')(error)
    })
  }

  /** The native queue's tail: the resolved prefix of the player's upcoming items. */
  #plan(): Plan {
    const player = this.#player
    if (player === undefined) return { entries: [], hasMore: false, repeat: 'off' }
    const { queue } = player.getState()
    const repeat: FxmPlayerRepeat =
      queue.repeat === 'one' || (queue.repeat === 'all' && queue.items.length === 1)
        ? 'one'
        : queue.repeat
    if (repeat === 'one') {
      this.#upcomingIds.clear()
      this.#queued = new Map()
      return { entries: [], hasMore: false, repeat }
    }
    const desired = upcomingInOrder(queue)
    const entries: FxmPlayerEntry[] = []
    const queued = new Map<number, Queued>()
    let aheadMs = 0
    let missing: QueueItem | undefined
    for (const item of desired) {
      if (entries.length >= this.#depth || aheadMs >= this.#aheadMs) break
      const candidate = candidateOf(item)
      const resolved = this.#fresh(item)
      const known = this.#queued.get(item.uid)
      const kept =
        known !== undefined && known.candidateKey === candidate && known.track === item.track.id
          ? this.#known.get(known.entryId)
          : undefined
      let entry: FxmPlayerEntry
      if (resolved !== undefined) {
        const id = this.#queuedFor(item) ?? this.#nextId()
        entry = nativeEntry(id, item, resolved.stream, resolved.network)
        this.#remember(entry, item, resolved.stream, resolved.candidate)
      } else if (kept !== undefined) {
        // Media3 has it already: it stays queued while a fresh source is on its way.
        entry = kept.entry
        if (missing === undefined && !this.#failedAhead.has(item.uid)) missing = item
      } else {
        if (missing === undefined && !this.#failedAhead.has(item.uid)) missing = item
        break
      }
      entries.push(entry)
      queued.set(item.uid, { entryId: entry.id, candidateKey: candidate, track: item.track.id })
      aheadMs += durationOf(item)
    }
    // Only the queued items keep their entry ids, and only the wanted ones their resolutions.
    this.#queued = queued
    for (const uid of [...this.#upcomingIds.keys()])
      if (!queued.has(uid)) this.#upcomingIds.delete(uid)
    for (const entry of entries) this.#upcomingIds.set(entry.uid, entry.id)
    const wanted = new Set(desired.map((item) => item.uid))
    for (const uid of [...this.#resolved.keys()]) if (!wanted.has(uid)) this.#resolved.delete(uid)
    return {
      entries,
      hasMore: queue.repeat === 'all' ? queue.items.length > 0 : desired.length > entries.length,
      repeat,
      ...(missing === undefined ? {} : { missing }),
    }
  }

  /** The resolution of `item` when it is still good to queue. */
  #fresh(item: QueueItem): Resolved | undefined {
    const resolved = this.#resolved.get(item.uid)
    if (resolved === undefined) return undefined
    if (
      resolved.track === item.track.id &&
      resolved.candidateKey === candidateOf(item) &&
      !this.#isStale(resolved)
    ) {
      return resolved
    }
    this.#resolved.delete(item.uid)
    return undefined
  }

  /** Whether a resolution belongs to an earlier network or expires within the refresh margin. */
  #isStale({ stream, network }: { stream: StreamOption; network: number }): boolean {
    return (
      (stream.ipBound && network !== this.#networkId) ||
      (stream.expiresAt !== undefined && stream.expiresAt - URL_REFRESH_MARGIN_MS <= this.#now())
    )
  }

  /** Resolves `item` ahead, at the prefetch priority, then feeds the native queue again. */
  #resolveAhead(item: QueueItem): void {
    const resolver = this.#resolver
    if (resolver === undefined) return
    if (this.#resolving !== undefined) {
      if (this.#resolving.uid === item.uid) return
      this.#resolving.abort.abort()
    }
    const abort = new AbortController()
    const resolving = { uid: item.uid, abort }
    this.#resolving = resolving
    const expiring = this.#expiring.get(item.uid)
    const request: ResolveRequest = {
      reason: 'preload',
      attempt: 0,
      signal: abort.signal,
      canPlay: (stream) => this.canPlay(stream),
      ...(expiring === undefined
        ? {}
        : {
            failure: {
              error: new EngineError('expired', 'The queued URL expires before it plays'),
              stream: expiring,
              positionMs: 0,
              started: false,
            },
          }),
    }
    const network = this.#networkId
    const done = () => {
      if (this.#resolving !== resolving) return
      this.#resolving = undefined
      this.#scheduleFeed()
    }
    Promise.resolve()
      .then(() => resolver.resolve(item, request))
      .then(
        ({ stream, candidate }) => {
          if (this.#resolving !== resolving) return
          this.#expiring.delete(item.uid)
          if (network !== this.#networkId) return
          // A stream Media3 cannot play, or one that expires too soon to queue, is not queued;
          // resolving it again at once would only give the same.
          const resolved: Resolved = {
            stream,
            candidate,
            candidateKey: candidateOf(item),
            track: item.track.id,
            network,
          }
          if (nativeSupport(stream) === 'no' || this.#isStale(resolved)) {
            this.#failedAhead.add(item.uid)
            return
          }
          this.#resolved.set(item.uid, resolved)
        },
        () => {
          // Rate limited, unavailable or a guess that needs review: the facade meets it in turn.
          if (this.#resolving === resolving && !abort.signal.aborted)
            this.#failedAhead.add(item.uid)
        },
      )
      .finally(done)
  }

  #signature(plan: Plan): string {
    return JSON.stringify([
      plan.entries.map((entry) => [entry.id, entry.source.url]),
      plan.hasMore,
      plan.repeat,
    ])
  }

  /** Drops what the engine keeps for items that left the queue, or whose uid now names another. */
  #forgetGone(queue: QueueState): void {
    const tracks = new Map(queue.items.map((item) => [item.uid, item.track.id]))
    const gone = (uid: number, track: string | undefined) =>
      track === undefined || tracks.get(uid) !== track
    for (const [uid, resolved] of [...this.#resolved]) {
      if (gone(uid, resolved.track)) this.#resolved.delete(uid)
    }
    for (const uid of [...this.#expiring.keys()]) if (!tracks.has(uid)) this.#expiring.delete(uid)
    for (const [uid, id] of [...this.#upcomingIds]) {
      if (gone(uid, this.#known.get(id)?.item?.track)) this.#upcomingIds.delete(uid)
    }
  }

  // --- Snapshots -------------------------------------------------------------------------------

  #scheduleSnapshot(): void {
    if (this.#snapshotQueued || this.#player === undefined || this.#destroyed) return
    this.#snapshotQueued = true
    queueMicrotask(() => {
      this.#snapshotQueued = false
      const player = this.#player
      if (player === undefined || this.#destroyed) return
      const { queue } = player.getState()
      const snapshot: Snapshot = {
        v: 1,
        queue: trimQueue(queue, NATIVE_ENGINE_DEFAULTS.snapshotItems),
      }
      const data = queue.items.length === 0 ? null : JSON.stringify(snapshot)
      if (data === this.#lastSnapshot) return
      this.#lastSnapshot = data
      void this.#call((plugin) => plugin.saveSnapshot({ data })).catch((error) => {
        // Media3 kept the old one: the next change stores this one again.
        if (this.#lastSnapshot === data) this.#lastSnapshot = undefined
        logFailure('saveSnapshot')(error)
      })
    })
  }

  // --- Helpers ---------------------------------------------------------------------------------

  /** Sends a command once the listeners and `attach` are in, in the order of the calls. */
  #call(action: (plugin: FxmPlayerPlugin) => Promise<void>): Promise<void> {
    return this.#ready.then(() => {
      if (this.#destroyed) return undefined
      return action(this.#plugin)
    })
  }

  /** {@link #call} for a command that changes whether Media3 plays. */
  #command(action: (plugin: FxmPlayerPlugin) => Promise<void>): Promise<void> {
    this.#commands += 1
    return this.#call(action).finally(() => {
      this.#commands -= 1
    })
  }

  #pauseNative(): void {
    void this.#command((plugin) => plugin.pause()).catch(logFailure('pause'))
  }

  #seekNative(positionMs: number): void {
    void this.#call((plugin) =>
      plugin.seek({ positionMs: Math.max(0, Math.floor(positionMs)) }),
    ).catch(logFailure('seek'))
  }

  #release(): void {
    this.#trail = []
    this.#loaded = undefined
    this.#sent = undefined
    this.#upcomingIds.clear()
    this.#queued = new Map()
    void this.#command((plugin) => plugin.release()).catch(logFailure('release'))
  }

  #sendVolume(): void {
    if (this.#destroyed) return
    const volume = this.#muted ? 0 : this.#volume
    void this.#call((plugin) => plugin.setVolume({ volume })).catch(logFailure('setVolume'))
  }

  #teardown(): void {
    this.#destroyed = true
    if (liveEngines.get(this.#plugin) === this) liveEngines.delete(this.#plugin)
    this.#disconnect?.()
    this.#resolving?.abort.abort()
    for (const handle of this.#handles.splice(0))
      void Promise.resolve(handle.remove()).catch(() => {})
    this.#networkListeners.clear()
    this.#events.clear()
  }

  #emit<K extends EngineEventType>(type: K, payload: EngineEventMap[K]): void {
    this.#events.emit(type, payload)
  }

  #nextId(): string {
    this.#sequence += 1
    return `${this.#prefix}-${this.#sequence.toString(36)}`
  }

  /** The entry Media3 is on, as far as the engine knows. */
  #nativeId(): string | undefined {
    return this.#trail.at(-1)?.entryId ?? this.#loaded
  }

  /** Whether entry `entryId` plays `item`: the same uid and the same track. */
  #isFor(entryId: string | undefined, item: QueueItem | undefined): boolean {
    if (entryId === undefined || item === undefined) return false
    const known = this.#known.get(entryId)?.item
    return known !== undefined && known.uid === item.uid && known.track === item.track.id
  }

  /** The upcoming entry queued for `item`, if there is one. */
  #queuedFor(item: QueueItem): string | undefined {
    const id = this.#upcomingIds.get(item.uid)
    return id !== undefined && this.#isFor(id, item) ? id : undefined
  }

  /** The stream Media3 plays for `item`, in an entry the player has not loaded yet. */
  #heldStream(item: QueueItem, request: ResolveRequest): ResolvedStream | undefined {
    if (this.#destroyed) return undefined
    const passed = this.#trail.find((entry) => this.#isFor(entry.entryId, item))
    const known = passed === undefined ? undefined : this.#known.get(passed.entryId)
    const stream = known?.stream
    if (stream === undefined || request.canPlay(stream) === 'no') return undefined
    return known?.candidate === undefined ? { stream } : { stream, candidate: known.candidate }
  }

  #remember(
    entry: FxmPlayerEntry,
    item: QueueItem | undefined,
    stream: StreamOption | undefined,
    candidate: AudioCandidate | undefined,
  ): void {
    this.#setKnown(entry.id, {
      entry,
      item: item === undefined ? undefined : { uid: item.uid, track: item.track.id },
      stream,
      candidate,
    })
  }

  #setKnown(id: string, known: Known): void {
    // Most recently used last.
    this.#known.delete(id)
    this.#known.set(id, known)
    if (this.#known.size <= 256) return
    const inUse = new Set<string>([
      ...(this.#loaded === undefined ? [] : [this.#loaded]),
      ...this.#trail.map((passed) => passed.entryId),
      ...this.#upcomingIds.values(),
    ])
    for (const key of [...this.#known.keys()]) {
      if (this.#known.size <= 128) break
      if (!inUse.has(key)) this.#known.delete(key)
    }
  }
}
