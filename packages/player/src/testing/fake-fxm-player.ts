/**
 * A stand-in for the Android app's `FxmPlayer` plugin (stage 6.3), for tests of the native engine
 * and of code that drives it. It keeps a native playlist the way the real coordinator does
 * (`apps/mobile/android/fxm-player`), records every call, and lets the test act as Media3: start
 * playing, move on to the next entry, fail, end, or report a system control or a network change.
 *
 * @module
 */

import type {
  FxmPlayerEffects,
  FxmPlayerEntry,
  FxmPlayerEventMap,
  FxmPlayerFailure,
  FxmPlayerListenerHandle,
  FxmPlayerLoadOptions,
  FxmPlayerPlugin,
  FxmPlayerRepeat,
  FxmPlayerSession,
  FxmPlayerSleepTimer,
  FxmPlayerState,
  FxmPlayerUpcomingOptions,
} from '../native/plugin'

type Listener = (event: never) => void

/** Options for {@link createFakeFxmPlayer}. */
export interface FakeFxmPlayerOptions {
  /** Where the native player is when the page attaches, e.g. after its renderer died. */
  session?: Partial<FxmPlayerSession>
  /** Whether `addListener` answers at once, as Capacitor's injected bridge does, rather than
   * with a promise, as `registerPlugin` does. Default: `false`. */
  syncListeners?: boolean
}

/** The fake plugin, with the test's controls. */
export interface FakeFxmPlayer extends FxmPlayerPlugin {
  /**
   * Every call in order: the method, then what it was about, with entries by title
   * (`load:a@0+[b,c]`, `setUpcoming:[c]+more`, `seek:1000`).
   */
  readonly calls: string[]
  /** The native playlist: the current entry first. */
  readonly entries: readonly FxmPlayerEntry[]
  /** The native state now. */
  readonly state: FxmPlayerState
  /** Whether the web app has more than the playlist holds, as `setUpcoming` or `load` said last. */
  readonly hasMore: boolean
  /** How the playlist repeats, as `setUpcoming` or `load` said last. */
  readonly repeat: FxmPlayerRepeat
  /** The volume `setVolume` set last, from 0 to 1. */
  readonly volume: number
  /** What `saveSnapshot` stored last, or `null`. */
  readonly snapshot: string | null
  /** The effects `setEffects` set last, if any. */
  readonly effects: FxmPlayerEffects | undefined
  /** The sleep timer `setSleepTimer` set last, if any. */
  readonly sleepTimer: FxmPlayerSleepTimer | undefined
  /** Whether a page attached. */
  readonly attached: boolean
  /** How many listeners are registered. */
  readonly listeners: number
  /** Media3 buffered enough: it plays if it should. */
  ready(): void
  /** The position moved on. */
  progress(positionMs: number, durationMs?: number): void
  /** The current entry played to its end; Media3 moves on to the next, or ends. */
  advance(reason?: 'auto' | 'skip'): void
  /** The current entry played to its end with nothing after it. */
  end(): void
  /** Media3 looped the current entry (repeat one). */
  repeatRound(): void
  /** A system control (the notification, a headset) played or paused, or audio focus moved. */
  systemPlay(playWhenReady: boolean): void
  /**
   * The current entry failed. As the real coordinator does, the error goes out first and the
   * idle state after it.
   */
  fail(failure?: Partial<FxmPlayerFailure>): void
  /** Media3 stopped without a failure (`ExoPlayer.stop`): idle, `playWhenReady` unchanged. */
  stop(): void
  /** A system control asked for next or previous. */
  command(command: 'next' | 'previous'): void
  /** The device changed network. */
  changeNetwork(cellular?: boolean): void
  /** Media3 asks for a fresh source for an upcoming entry. */
  request(id: string, reason: 'expiring' | 'network'): void
  /** The page's listeners are gone, as when its renderer dies. */
  detach(): void
  /** The native sleep timer paused playback. */
  sleep(reason?: 'timer' | 'end-of-track'): void
}

/** Creates a {@link FakeFxmPlayer}. */
export function createFakeFxmPlayer(options: FakeFxmPlayerOptions = {}): FakeFxmPlayer {
  const listeners = new Map<string, Set<Listener>>()
  const calls: string[] = []
  const preset = options.session
  let entries: FxmPlayerEntry[] = [...(preset?.entries ?? [])]
  let state: FxmPlayerState = {
    id: preset?.id ?? entries[0]?.id ?? null,
    positionMs: preset?.positionMs ?? 0,
    durationMs: preset?.durationMs ?? -1,
    playing: preset?.playing ?? false,
    playWhenReady: preset?.playWhenReady ?? false,
    state: preset?.state ?? (entries.length > 0 ? 'ready' : 'idle'),
  }
  let error: FxmPlayerFailure | null = preset?.error ?? null
  let snapshot: string | null = preset?.snapshot ?? null
  let network = preset?.network ?? { id: 0, cellular: false }
  let hasMore = false
  let repeat: FxmPlayerRepeat = 'off'
  let volume = 1
  let attached = false
  let effects: FxmPlayerEffects | undefined
  let sleepTimer: FxmPlayerSleepTimer | undefined

  function emit<K extends keyof FxmPlayerEventMap>(name: K, payload: FxmPlayerEventMap[K]): void {
    if (!attached) return
    for (const listener of [...(listeners.get(name) ?? [])]) {
      ;(listener as (event: FxmPlayerEventMap[K]) => void)(payload)
    }
  }

  function update(patch: Partial<FxmPlayerState>): void {
    state = { ...state, ...patch, id: entries[0]?.id ?? null }
    state = { ...state, playing: state.playWhenReady && state.state === 'ready' }
    emit('state', state)
  }

  function titles(list: readonly FxmPlayerEntry[]): string {
    return `[${list.map((entry) => entry.metadata.title).join(',')}]`
  }

  const plugin: FakeFxmPlayer = {
    get calls() {
      return calls
    },
    get entries() {
      return entries
    },
    get state() {
      return state
    },
    get hasMore() {
      return hasMore
    },
    get repeat() {
      return repeat
    },
    get volume() {
      return volume
    },
    get snapshot() {
      return snapshot
    },
    get effects() {
      return effects
    },
    get sleepTimer() {
      return sleepTimer
    },
    get attached() {
      return attached
    },
    get listeners() {
      let count = 0
      for (const set of listeners.values()) count += set.size
      return count
    },

    async attach() {
      calls.push('attach')
      attached = true
      return { ...state, entries: [...entries], error, snapshot, network }
    },

    async load(load: FxmPlayerLoadOptions) {
      calls.push(`load:${load.entry.metadata.title}@${load.startAtMs}+${titles(load.upcoming)}`)
      // The real player skips to a queued entry with the same bytes, keeping its buffer; either
      // way the playlist is the entry and the ones after it.
      entries = [load.entry, ...load.upcoming]
      hasMore = load.hasMore
      repeat = load.repeat
      error = null
      update({
        positionMs: load.startAtMs,
        durationMs: -1,
        playWhenReady: false,
        state: 'buffering',
      })
    },

    async setUpcoming(upcoming: FxmPlayerUpcomingOptions) {
      calls.push(`setUpcoming:${titles(upcoming.upcoming)}${upcoming.hasMore ? '+more' : ''}`)
      entries = entries.length === 0 ? [] : [entries[0] as FxmPlayerEntry, ...upcoming.upcoming]
      hasMore = upcoming.hasMore
      repeat = upcoming.repeat
    },

    async play() {
      calls.push('play')
      update({ playWhenReady: true })
    },

    async pause() {
      calls.push('pause')
      update({ playWhenReady: false })
    },

    async seek({ positionMs }) {
      calls.push(`seek:${positionMs}`)
      update({ positionMs, state: state.state === 'ended' ? 'buffering' : state.state })
    },

    async setVolume(options) {
      calls.push(`setVolume:${options.volume}`)
      volume = options.volume
    },

    async ack() {
      calls.push('ack')
    },

    async setEffects(options) {
      calls.push(
        `setEffects:eq=${options.equalizer.enabled ? options.equalizer.gainsDb.join(',') : 'off'}` +
          ` loudness=${options.loudness.enabled ? options.loudness.targetLufs : 'off'}` +
          ` speed=${options.speed}`,
      )
      effects = options
    },

    async setSleepTimer(options) {
      calls.push(
        `setSleepTimer:${options.endOfTrack ? 'end' : options.endsAt === null ? 'off' : `${options.endsAt}-${options.fadeMs}`}`,
      )
      sleepTimer = options
    },

    async saveSnapshot(options) {
      calls.push('saveSnapshot')
      snapshot = options.data
    },

    async release() {
      calls.push('release')
      entries = []
      snapshot = null
      update({ positionMs: 0, durationMs: -1, playWhenReady: false, state: 'idle' })
    },

    addListener<K extends keyof FxmPlayerEventMap>(
      eventName: K,
      listener: (event: FxmPlayerEventMap[K]) => void,
    ): Promise<FxmPlayerListenerHandle> | FxmPlayerListenerHandle {
      const set = listeners.get(eventName) ?? new Set<Listener>()
      listeners.set(eventName, set)
      set.add(listener as Listener)
      const handle: FxmPlayerListenerHandle = {
        remove: async () => {
          set.delete(listener as Listener)
        },
      }
      return options.syncListeners === true ? handle : Promise.resolve(handle)
    },

    ready() {
      update({ state: 'ready' })
    },

    progress(positionMs, durationMs) {
      update({ positionMs, ...(durationMs === undefined ? {} : { durationMs }) })
    },

    advance(reason = 'auto') {
      const [from, to] = entries
      if (from === undefined) return
      if (to === undefined) {
        plugin.end()
        return
      }
      entries = entries.slice(1)
      state = { ...state, id: to.id, positionMs: 0, durationMs: -1 }
      emit('transition', { from: from.id, to: to.id, reason })
      update({ state: 'ready' })
    },

    end() {
      update({ state: 'ended' })
    },

    repeatRound() {
      const id = entries[0]?.id ?? null
      emit('transition', { from: id, to: id, reason: 'repeat' })
      update({ positionMs: 0 })
    },

    systemPlay(playWhenReady) {
      update({ playWhenReady })
    },

    fail(failure = {}) {
      const full: FxmPlayerFailure = {
        type: failure.type ?? 'network',
        status: failure.status === undefined ? 403 : failure.status,
        message: failure.message ?? 'ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 403)',
      }
      error = full
      emit('error', { ...full, id: entries[0]?.id ?? null })
      update({ state: 'idle' })
    },

    stop() {
      update({ state: 'idle' })
    },

    command(command) {
      emit('command', { command })
    },

    changeNetwork(cellular = false) {
      network = { id: network.id + 1, cellular }
      emit('network', network)
    },

    request(id, reason) {
      emit('request', { id, reason })
    },

    sleep(reason = 'timer') {
      sleepTimer = undefined
      emit('sleep', { reason })
      update({ playWhenReady: false })
    },

    detach() {
      attached = false
      listeners.clear()
    },
  }
  return plugin
}
