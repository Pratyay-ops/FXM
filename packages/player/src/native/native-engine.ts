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
 * loading it again.
 *
 * @module
 */

import {
  APP_NAME,
  candidateKey,
  currentQueueItem,
  FxmError,
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
import type { Player } from '../player'
import type { ResolveRequest, StreamResolver } from '../resolver'
import { nativeEntry, nativeSource, nativeSupport } from './entries'
import {
  FXM_PLAYER_MAX_UPCOMING,
  type FxmPlayerEventMap,
  type FxmPlayerListenerHandle,
  type FxmPlayerPlugin,
  findFxmPlayerPlugin,
  type NativeEntry,
  type NativeFailure,
  type NativeRepeat,
  type NativeSession,
  type NativeState,
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
  /** The player the engine plays for. */
  player: NativePlaybackPlayer
  /** Resolves the upcoming items: the player's own resolver, the stream lifecycle. */
  resolver: StreamResolver
  /** How many upcoming items to keep resolved in the native queue. Default: 5. */
  depth?: number
  /** Stop adding items once this much audio is queued natively. Default: 40 minutes. */
  aheadMs?: number
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

/** The entry the facade has loaded, as far as the engine knows. */
interface Loaded {
  readonly entryId: string
  readonly uid: number | undefined
}

/** An entry Media3 moved on to by itself, which the facade has not loaded yet. */
interface Passed {
  readonly entryId: string
  readonly uid: number | undefined
  /** How it failed meanwhile, reported once the facade loads it. */
  failure?: EngineError
}

/** An upcoming item, resolved ahead. */
interface Resolved {
  readonly stream: StreamOption
  /** The candidate it was resolved for (`candidateKey`), or `''`. */
  readonly candidate: string
  /** The native network it was resolved on. */
  readonly network: number
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
  readonly entries: readonly NativeEntry[]
  readonly hasMore: boolean
  readonly repeat: NativeRepeat
  /** The first item that still needs resolving, if any may. */
  readonly missing?: QueueItem
}

function candidateOf(item: QueueItem): string {
  return item.candidate === undefined ? '' : candidateKey(item.candidate)
}

function engineError(failure: NativeFailure): EngineError {
  return new EngineError(
    failure.type,
    failure.message,
    failure.status === null ? {} : { cause: { status: failure.status } },
  )
}

function phaseOf(state: NativeState): Reported['phase'] {
  if (state.state === 'ended') return 'ended'
  if (state.playing) return 'playing'
  if (state.state === 'idle') return 'idle'
  if (state.playWhenReady && state.state === 'buffering') return 'waiting'
  return 'paused'
}

function freshReported(): Reported {
  return { phase: 'paused', durationMs: -1, ready: false, positionMs: -1 }
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
 * const engine = NativeEngine.ifAvailable() // Android only
 * const lifecycle = new StreamLifecycle({ ...options, network: engine?.network ?? createBrowserNetworkMonitor() })
 * const player = new Player({ engine: engine ?? new DirectAudioEngine(), resolver: lifecycle })
 * lifecycle.attach(player)
 * void engine?.connect({ player, resolver: lifecycle })
 * ```
 *
 * Without {@link connect} it is a plain engine: one stream at a time, plus the next one the
 * facade preloads. {@link connect} adds the deeper native queue, the system's next and previous
 * buttons, and picking up where the native player is after the page was recreated.
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
  readonly #ready: Promise<NativeSession | undefined>
  readonly #handles: FxmPlayerListenerHandle[] = []
  readonly #networkListeners = new Set<() => void>()
  readonly #prefix = `n${Math.floor(Math.random() * 2 ** 32).toString(36)}`
  #sequence = 0
  #destroyed = false
  #volume = 1
  #muted = false

  /** The entry the facade loaded last. */
  #loaded: Loaded | undefined
  /** Entries Media3 moved on to since, oldest first; the facade adopts them in turn. */
  #trail: Passed[] = []
  /** Media3 looped the entry (repeat one): the facade's restart must not seek it back. */
  #repeating = false
  /** Media3's last reported state. */
  #state: NativeState | undefined
  #reported: Reported = freshReported()
  /** The queue item of every entry the engine knows, by entry id. */
  readonly #uids = new Map<string, number>()
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
  /** The upcoming entries Media3 has, by uid, with the candidate each was resolved for. */
  #queued = new Map<number, { readonly entry: NativeEntry; readonly candidate: string }>()
  /** Items that failed to resolve ahead; tried again after the queue or the network changes. */
  readonly #failedAhead = new Set<number>()
  #resolving: { readonly uid: number; readonly abort: AbortController } | undefined
  /** The native queue's tail as last sent. */
  #sent: string | undefined
  #feedQueued = false
  #snapshotQueued = false
  #lastSnapshot: string | undefined
  #disconnect: (() => void) | undefined

  /**
   * @throws an `Unsupported` `FxmError` without the plugin, i.e. outside the Android app.
   */
  constructor(options: NativeEngineOptions = {}) {
    const plugin = options.plugin ?? findFxmPlayerPlugin()
    if (plugin === undefined) {
      throw new FxmError(
        'Unsupported',
        'The native player needs the Android app’s FxmPlayer plugin',
      )
    }
    this.#plugin = plugin
    this.#now = options.now ?? Date.now
    this.network = this.#createNetworkMonitor()
    this.#ready = this.#start()
  }

  /** A native engine on the Android app's plugin, or `undefined` elsewhere. */
  static ifAvailable(global: object = globalThis): NativeEngine | undefined {
    const plugin = findFxmPlayerPlugin(global)
    return plugin === undefined ? undefined : new NativeEngine({ plugin })
  }

  // --- The engine ------------------------------------------------------------------------------

  async load(source: PlaybackSource, startAtMs = 0): Promise<void> {
    if (this.#destroyed) return
    this.#repeating = false
    const uid = source.item?.uid
    const at = uid === undefined ? -1 : this.#trail.findIndex((passed) => passed.uid === uid)
    if (at >= 0) {
      this.#adopt(at)
      return
    }
    this.#trail = []
    const queuedId = uid === undefined ? undefined : this.#upcomingIds.get(uid)
    const id = queuedId ?? this.#nextId()
    if (uid !== undefined) this.#upcomingIds.delete(uid)
    const entry: NativeEntry =
      source.item === undefined
        ? {
            id,
            uid: 0,
            source: nativeSource(source.stream, this.#networkId),
            metadata: { title: APP_NAME, artists: [] },
          }
        : nativeEntry(id, source.item, source.stream, this.#networkId)
    this.#remember(entry)
    this.#loaded = { entryId: id, uid }
    this.#reported = freshReported()
    const plan = this.#plan()
    this.#sent = this.#signature(plan)
    try {
      await this.#call((plugin) =>
        plugin.load({
          entry,
          startAtMs: Math.max(0, Math.floor(startAtMs)),
          upcoming: plan.entries,
          hasMore: plan.hasMore,
          repeat: plan.repeat,
        }),
      )
    } catch (error) {
      if (this.#loaded?.entryId !== id) return
      queueMicrotask(() => {
        if (this.#loaded?.entryId === id) {
          this.#emit(
            'error',
            new EngineError('unsupported', 'The native player refused the stream', {
              cause: error,
            }),
          )
        }
      })
      return
    }
    if (plan.missing !== undefined) this.#resolveAhead(plan.missing)
  }

  async play(): Promise<void> {
    if (this.#destroyed) return
    this.#repeating = false
    await this.#call((plugin) => plugin.play()).catch(() => {})
  }

  pause(): void {
    if (this.#destroyed) return
    // While Media3 is ahead of the facade, a pause is the facade letting go of the item that
    // ended, not the user's: the item Media3 moved on to keeps playing until the facade decides.
    if (this.#trail.length > 0) return
    void this.#call((plugin) => plugin.pause()).catch(() => {})
  }

  seek(positionMs: number): void {
    if (this.#destroyed || !Number.isFinite(positionMs)) return
    // Media3 looped the entry itself; the facade's restart has nothing left to do.
    if (this.#repeating && positionMs === 0) {
      this.#repeating = false
      return
    }
    void this.#call((plugin) =>
      plugin.seek({ positionMs: Math.max(0, Math.floor(positionMs)) }),
    ).catch(() => {})
  }

  setVolume(volume: number): void {
    this.#volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1))
    this.#sendVolume()
  }

  setMuted(muted: boolean): void {
    this.#muted = muted
    this.#sendVolume()
  }

  preload(source: PlaybackSource | null): void {
    if (this.#destroyed || source === null || source.item === undefined) return
    const { item, stream } = source
    if (nativeSupport(stream) === 'no') return
    if (this.#player === undefined) {
      // Not connected: the facade's next item is the native queue's only one.
      const id = this.#upcomingIds.get(item.uid) ?? this.#nextId()
      this.#upcomingIds.clear()
      this.#upcomingIds.set(item.uid, id)
      const entry = nativeEntry(id, item, stream, this.#networkId)
      this.#remember(entry)
      void this.#call((plugin) =>
        plugin.setUpcoming({ upcoming: [entry], hasMore: false, repeat: 'off' }),
      ).catch(() => {})
      return
    }
    if (!this.#resolved.has(item.uid)) {
      this.#resolved.set(item.uid, {
        stream,
        candidate: candidateOf(item),
        network: this.#networkId,
      })
    }
    this.#scheduleFeed()
  }

  canPlay(stream: StreamOption): PlaySupport {
    return nativeSupport(stream)
  }

  on<K extends EngineEventType>(
    type: K,
    listener: (payload: EngineEventMap[K]) => void,
  ): () => void {
    return this.#events.on(type, listener as Listener<EngineEventMap[K]>)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#disconnect?.()
    this.#resolving?.abort.abort()
    for (const handle of this.#handles.splice(0))
      void Promise.resolve(handle.remove()).catch(() => {})
    void this.#plugin.release().catch(() => {})
    this.#networkListeners.clear()
    this.#events.clear()
  }

  // --- The native queue ------------------------------------------------------------------------

  /**
   * Plays for `player`: keeps the next items resolved in the native queue (up to `depth` items or
   * `aheadMs` of audio, at the resolver's prefetch priority, so within the request budget),
   * hands the system's next and previous buttons to the player, stores its queue natively and,
   * when the page was recreated while the native player kept playing (its WebView renderer was
   * killed), restores the queue there and adopts what plays. Resolves once connected; returns a
   * function that disconnects.
   */
  async connect(options: NativeConnectOptions): Promise<() => void> {
    if (this.#destroyed || this.#player !== undefined) return () => {}
    const { player, resolver } = options
    this.#player = player
    this.#resolver = resolver
    this.#depth = Math.max(
      0,
      Math.min(Math.floor(options.depth ?? NATIVE_ENGINE_DEFAULTS.depth), FXM_PLAYER_MAX_UPCOMING),
    )
    this.#aheadMs = Math.max(0, options.aheadMs ?? NATIVE_ENGINE_DEFAULTS.aheadMs)
    const session = await this.#ready
    if (this.#destroyed || this.#player !== player) return () => {}
    const stop = player.subscribe((state, previous) => {
      if (state.queue !== previous.queue) {
        if (state.queue.items !== previous.queue.items) this.#failedAhead.clear()
        this.#scheduleFeed()
        this.#scheduleSnapshot()
      }
      if (state.status === previous.status) return
      // The facade stopped (failures, or the user must act) or emptied its queue: so does Media3.
      if (state.status === 'error') this.#pauseNative()
      if (state.status === 'idle' && state.queue.items.length === 0) {
        this.#trail = []
        this.#loaded = undefined
        void this.#call((plugin) => plugin.release()).catch(() => {})
      }
    })
    const disconnect = () => {
      stop()
      if (this.#disconnect !== disconnect) return
      this.#disconnect = undefined
      this.#player = undefined
      this.#resolver = undefined
      this.#resolving?.abort.abort()
      this.#resolving = undefined
    }
    this.#disconnect = disconnect
    if (session !== undefined && this.#loaded === undefined) await this.#resync(session, player)
    this.#scheduleFeed()
    this.#scheduleSnapshot()
    return disconnect
  }

  /** Picks up where the native player is, after the page was recreated. */
  async #resync(session: NativeSession, player: NativePlaybackPlayer): Promise<void> {
    const current = session.entries.find((entry) => entry.id === session.id)
    const snapshot = parseSnapshot(session.snapshot)
    if (current === undefined || snapshot === undefined) return
    if (player.getState().queue.items.length > 0) return
    // The snapshot is data from storage: restoreQueue checks it, this only finds the item.
    const items: unknown = (snapshot.queue as { items?: unknown }).items
    const position = Array.isArray(items)
      ? items.findIndex((item: unknown) => (item as { uid?: unknown } | null)?.uid === current.uid)
      : -1
    const saved = position >= 0 ? { ...snapshot.queue, index: position } : snapshot.queue
    const ended = session.state === 'ended'
    if (!player.restore(saved, ended ? 0 : session.positionMs)) return
    const queue = player.getState().queue
    if (currentQueueItem(queue)?.uid !== current.uid) return
    // Media3's queue stays as it is while the new page resolves its items again.
    const candidates = new Map(queue.items.map((item) => [item.uid, candidateOf(item)]))
    for (const entry of session.entries) {
      this.#remember(entry)
      if (entry.id === current.id) continue
      this.#upcomingIds.set(entry.uid, entry.id)
      this.#queued.set(entry.uid, { entry, candidate: candidates.get(entry.uid) ?? '' })
    }
    if (ended) {
      // Media3 played everything it had: continue with the queue's next item.
      if (queue.index + 1 < queue.items.length) await player.play(queue.index + 1)
      return
    }
    this.#state = session
    this.#trail = [
      {
        entryId: current.id,
        uid: current.uid,
        ...(session.error === null ? {} : { failure: engineError(session.error) }),
      },
    ]
    if (session.playWhenReady) await player.play()
  }

  // --- Native events ---------------------------------------------------------------------------

  async #start(): Promise<NativeSession | undefined> {
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
      this.#networkId = session.network.id
      this.#cellular = session.network.cellular
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

  #onState(state: NativeState): void {
    this.#state = state
    this.#report(state)
  }

  /** Turns Media3's state for the loaded entry into the engine's events. */
  #report(state: NativeState): void {
    const loaded = this.#loaded
    if (loaded === undefined || state.id !== loaded.entryId || this.#trail.length > 0) return
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
      else if (phase === 'paused' && (before === 'playing' || before === 'waiting')) {
        this.#emit('pause', undefined)
      }
    }
    if (state.positionMs !== reported.positionMs) {
      reported.positionMs = state.positionMs
      this.#emit('timeupdate', state.positionMs)
    }
    if (phase === 'ended' && before !== 'ended') this.#emit('ended', undefined)
  }

  #onTransition(event: FxmPlayerEventMap['transition']): void {
    const to = event.to
    if (to === null) return
    if (event.reason === 'repeat') {
      if (this.#trail.length > 0 || to !== this.#loaded?.entryId) return
      this.#repeating = true
      this.#reported = { ...freshReported(), durationMs: this.#reported.durationMs, ready: true }
      this.#emit('ended', undefined)
      return
    }
    const tail = this.#trail.at(-1)?.entryId ?? this.#loaded?.entryId
    if (event.from !== tail) return
    const uid = this.#uids.get(to)
    if (uid !== undefined) this.#upcomingIds.delete(uid)
    this.#trail.push({ entryId: to, uid })
    // Only the first step needs the facade: it catches up through the rest one at a time.
    if (this.#trail.length > 1) return
    this.#emit('ended', undefined)
    this.#checkHandover()
  }

  /**
   * After the facade heard that its item ended: if it does not go on to the item Media3 moved
   * to (its queue ended, it stopped, or it changed meanwhile), Media3 stops too.
   */
  #checkHandover(): void {
    const player = this.#player
    const first = this.#trail[0]
    if (player === undefined || first === undefined) return
    const { status, queue } = player.getState()
    const next = currentQueueItem(queue)
    const continuing = (status === 'loading' || status === 'playing') && next?.uid === first.uid
    if (continuing) return
    this.#trail = []
    this.#pauseNative()
  }

  /** The facade loads the item Media3 already plays: take it over without loading it again. */
  #adopt(at: number): void {
    const passed = this.#trail[at] as Passed
    const rest = this.#trail.slice(at + 1)
    this.#trail = rest
    this.#loaded = { entryId: passed.entryId, uid: passed.uid }
    this.#reported = freshReported()
    // One more try, per track, for items that failed to resolve ahead.
    this.#failedAhead.clear()
    // The user paused while the facade caught up: Media3 pauses now.
    const status = this.#player?.getState().status
    if (status !== undefined && status !== 'loading' && status !== 'playing') this.#pauseNative()
    queueMicrotask(() => {
      if (this.#destroyed || this.#loaded?.entryId !== passed.entryId) return
      if (passed.failure !== undefined) this.#emit('error', passed.failure)
      else if (rest.length > 0) this.#emit('ended', undefined)
      else if (this.#state !== undefined) this.#report(this.#state)
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
    if (this.#loaded === undefined || event.id !== this.#loaded.entryId) return
    this.#reported.phase = 'idle'
    this.#emit('error', failure)
  }

  #onRequest(event: FxmPlayerEventMap['request']): void {
    const uid = this.#uids.get(event.id)
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
    void this.#call((plugin) => plugin.ack()).catch(() => {})
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
    const loaded = this.#loaded
    if (player === undefined || loaded === undefined || this.#destroyed) return
    // Media3 is ahead of the facade: its queue is fine until the facade caught up.
    if (this.#trail.length > 0) return
    if (currentQueueItem(player.getState().queue)?.uid !== loaded.uid) return
    const plan = this.#plan()
    if (plan.missing !== undefined) this.#resolveAhead(plan.missing)
    const signature = this.#signature(plan)
    if (signature === this.#sent) return
    this.#sent = signature
    void this.#call((plugin) =>
      plugin.setUpcoming({ upcoming: plan.entries, hasMore: plan.hasMore, repeat: plan.repeat }),
    ).catch(() => {})
  }

  /** The native queue's tail: the resolved prefix of the facade's upcoming items. */
  #plan(): Plan {
    const player = this.#player
    if (player === undefined) return { entries: [], hasMore: false, repeat: 'off' }
    const { queue } = player.getState()
    const repeat: NativeRepeat =
      queue.repeat === 'one' || (queue.repeat === 'all' && queue.items.length === 1)
        ? 'one'
        : queue.repeat
    if (repeat === 'one') {
      this.#upcomingIds.clear()
      this.#queued = new Map()
      return { entries: [], hasMore: false, repeat }
    }
    const desired = upcomingInOrder(queue)
    const entries: NativeEntry[] = []
    const queued = new Map<number, { entry: NativeEntry; candidate: string }>()
    let aheadMs = 0
    let missing: QueueItem | undefined
    for (const item of desired) {
      if (entries.length >= this.#depth || aheadMs >= this.#aheadMs) break
      const candidate = candidateOf(item)
      const resolved = this.#fresh(item)
      const known = this.#queued.get(item.uid)
      let entry: NativeEntry
      if (resolved !== undefined) {
        const id = this.#upcomingIds.get(item.uid) ?? this.#nextId()
        entry = nativeEntry(id, item, resolved.stream, resolved.network)
      } else if (known !== undefined && known.candidate === candidate) {
        // Media3 has it already: it stays queued while a fresh source is on its way.
        entry = known.entry
        if (missing === undefined && !this.#failedAhead.has(item.uid)) missing = item
      } else {
        if (missing === undefined && !this.#failedAhead.has(item.uid)) missing = item
        break
      }
      this.#remember(entry)
      entries.push(entry)
      queued.set(item.uid, { entry, candidate })
      aheadMs += item.track.durationMs ?? NATIVE_ENGINE_DEFAULTS.assumedDurationMs
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
    if (resolved.candidate === candidateOf(item) && !this.#isStale(resolved)) return resolved
    this.#resolved.delete(item.uid)
    return undefined
  }

  /** Whether a resolution belongs to an earlier network or expires within the refresh margin. */
  #isStale({ stream, network }: Resolved): boolean {
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
        ({ stream }) => {
          if (this.#resolving !== resolving) return
          this.#expiring.delete(item.uid)
          if (network !== this.#networkId) return
          // A stream Media3 cannot play, or one that expires too soon to queue, is not queued;
          // resolving it again at once would only give the same.
          const resolved = { stream, candidate: candidateOf(item), network }
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
      if (data === (this.#lastSnapshot ?? null)) return
      this.#lastSnapshot = data ?? undefined
      void this.#call((plugin) => plugin.saveSnapshot({ data })).catch(() => {})
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

  #pauseNative(): void {
    void this.#call((plugin) => plugin.pause()).catch(() => {})
  }

  #sendVolume(): void {
    if (this.#destroyed) return
    const volume = this.#muted ? 0 : this.#volume
    void this.#call((plugin) => plugin.setVolume({ volume })).catch(() => {})
  }

  #emit<K extends EngineEventType>(type: K, payload: EngineEventMap[K]): void {
    this.#events.emit(type, payload)
  }

  #nextId(): string {
    this.#sequence += 1
    return `${this.#prefix}-${this.#sequence.toString(36)}`
  }

  #remember(entry: NativeEntry): void {
    this.#uids.set(entry.id, entry.uid)
    if (this.#uids.size <= 256) return
    // Forget the oldest, which have played long ago.
    for (const id of this.#uids.keys()) {
      if (this.#uids.size <= 128) break
      this.#uids.delete(id)
    }
  }
}
