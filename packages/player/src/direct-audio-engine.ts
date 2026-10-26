/**
 * The direct audio engine: plays progressive streams with `HTMLAudioElement`, on web and
 * desktop.
 *
 * - **No `crossOrigin` by default.** googlevideo answers media requests from other sites without
 *   CORS headers, so a CORS-mode request (`crossorigin="anonymous"`) fails. A plain media request
 *   plays any stream that was resolved on this device.
 * - **No byte fetching.** The engine only sets `src`; it never reads stream bytes with `fetch`
 *   or MediaSource, which googlevideo would refuse to the page. A plain `<audio src>` also
 *   follows googlevideo's cross-host redirects that a CORS read cannot. For the same reason it
 *   cannot send request headers, so it refuses a stream that needs some (`requestHeaders`).
 * - **Near-gapless.** A second element preloads the next stream (`preload="auto"`); loading
 *   that stream then swaps the elements instead of starting a new download.
 * - **User gestures.** WebKit and Android WebView let `play()` start only an element that was
 *   once played in a user gesture. {@link DirectAudioEngine.unlock}, which the player calls in
 *   every user action, does that for every element; an element that is not unlocked is never
 *   swapped in, so playback stays on one that is.
 * - **Typed failures.** `play()` refusals from the autoplay policy and `MediaError` codes are
 *   reported as `EngineError`s; an error after the stream's `expiresAt` is `expired`.
 * - **Audio effects (stage 8.1).** Speed (`playbackRate`, pitch kept) works on every stream, and
 *   so do crossfades where the page can set the volume (not on iOS, see `canSetVolume`).
 *   Loudness normalization turns tracks down through the element's volume, on every stream. The
 *   equalizer, and turning quiet tracks up, need Web Audio, which processes only media whose
 *   bytes the page can read: such streams (see `isReadable`) play on a second pair of elements
 *   with `crossorigin="anonymous"`, routed through the effects graph (`effects/web-audio.ts`),
 *   only while an effect needs it. A routed stream that fails before it plays (CORS, e.g. after a
 *   googlevideo redirect) plays again at once without effects.
 *
 * Events are checked against the element's state when they arrive, so events of a replaced
 * source never leak through, even in a browser that delivers them late.
 *
 * @module
 */

import {
  crossfadeGains,
  dbToGain,
  type EqualizerSettings,
  isFlatEqualizer,
  loudnessGainDb,
  type StreamOption,
} from '@fxm/core'
import { isLocalMediaUrl } from './effects/readable'
import { type EffectsContext, EffectsGraph, type ElementChain, setParam } from './effects/web-audio'
import { Emitter } from './emitter'
import {
  type AudioEffectsStatus,
  type Engine,
  type EngineEffects,
  EngineError,
  type EngineErrorType,
  type EngineEventMap,
  type EngineEventType,
  type PlaybackSource,
  type PlaySupport,
} from './engine'
import { mimeTypeOf } from './mime'

/** `HTMLMediaElement.HAVE_METADATA`: the duration and dimensions are known. */
const HAVE_METADATA = 1

/** `HTMLMediaElement.HAVE_FUTURE_DATA`: enough is buffered to play on for a while. */
const HAVE_FUTURE_DATA = 3

/** `MediaError.MEDIA_ERR_NETWORK`. */
const MEDIA_ERR_NETWORK = 2

/** `MediaError.MEDIA_ERR_DECODE`. */
const MEDIA_ERR_DECODE = 3

/** `MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED`, also what a refused (e.g. 403) request reports. */
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

/** How often a fade moves the volume on, in milliseconds. */
const FADE_STEP_MS = 50

const MESSAGES: Readonly<Record<EngineErrorType, string>> = {
  network: 'The stream could not be loaded',
  decode: 'The stream could not be decoded',
  'autoplay-blocked': 'The browser wants a user gesture before playback starts',
  unsupported: 'The stream format is not supported or the server refused it',
  expired: 'The stream URL has expired',
}

/** Options for {@link DirectAudioEngine}. */
export interface DirectAudioEngineOptions {
  /** Creates the engine's audio elements. Default: `document.createElement('audio')`. */
  createAudio?: () => HTMLAudioElement
  /** The clock, in epoch milliseconds, for stream expiry. Default: `Date.now`. */
  now?: () => number
  /**
   * Creates the Web Audio context the equalizer and loudness boosts run on, the first time an
   * effect needs it. Default: an `AudioContext` with the `playback` latency hint, where the
   * browser has one. `null`: no Web Audio, so no equalizer, and loudness only turns tracks down.
   */
  createAudioContext?: (() => EffectsContext) | null
  /**
   * Whether the page can read `stream`'s bytes through a `crossorigin` element, which Web Audio
   * needs. Default: only `blob:`, `data:` and same-origin URLs (`isLocalMediaUrl`); the app
   * passes `isMediaReadable` with its platform, which knows the hosts that send CORS headers.
   */
  isReadable?: (stream: StreamOption) => boolean
  /** A steady clock in milliseconds, for fades. Default: `performance.now`. */
  clock?: () => number
}

/** One of the engine's audio elements. */
interface Slot {
  readonly element: HTMLAudioElement
  /** Whether it plays through Web Audio, with `crossorigin="anonymous"`. */
  readonly routed: boolean
  /** Its way into the effects graph, once connected (routed elements only). */
  chain: ElementChain | undefined
  /** The loudness gain of the source it holds, in dB. */
  gainDb: number
  /** Its crossfade factor, from 0 to 1. */
  fade: number
}

/** A crossfade under way: the slot fading out. */
interface Crossfade {
  readonly slot: Slot
  readonly startedAt: number
  readonly durationMs: number
  readonly timer: ReturnType<typeof setInterval>
}

/** A fade of the whole output under way (`fadeOutput`). */
interface OutputFade {
  readonly from: number
  readonly to: number
  readonly startedAt: number
  readonly durationMs: number
  readonly timer: ReturnType<typeof setInterval>
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/** Why an `<audio>` element cannot play `stream` at all, or `undefined` when it might. */
function unsupportedReason(stream: StreamOption): string | undefined {
  if (stream.protocol !== 'progressive') {
    return `Direct audio plays progressive streams, not ${stream.protocol}`
  }
  if (stream.requestHeaders !== undefined && Object.keys(stream.requestHeaders).length > 0) {
    return 'An audio element cannot send the request headers the stream needs'
  }
  if (stream.fullLength === 'capped') return 'The stream URL stops before the end of the file'
  return undefined
}

/** The browser's `AudioContext`, where it has one. */
function defaultAudioContext(): (() => EffectsContext) | undefined {
  const Context = (globalThis as { AudioContext?: new (options?: object) => EffectsContext })
    .AudioContext
  return typeof Context === 'function' ? () => new Context({ latencyHint: 'playback' }) : undefined
}

/**
 * Whether the equalizer has something to do: it is on and a band is off 0 dB. A flat one leaves
 * the sound as it is, so no stream moves onto Web Audio for it.
 */
function shapesSound(equalizer: EqualizerSettings): boolean {
  return equalizer.enabled && !isFlatEqualizer(equalizer.gainsDb)
}

/** Whether pages may set a media element's volume: iOS keeps it at 1, whatever a page sets. */
function canSetVolume(element: HTMLAudioElement): boolean {
  const before = element.volume
  element.volume = 0.5
  const settable = element.volume === 0.5
  element.volume = before
  return settable
}

/**
 * Plays progressive streams through alternating `HTMLAudioElement`s. It refuses, without
 * loading them, streams that are not progressive, that need request headers (an `<audio>`
 * element cannot send any), that are `capped`, or that have already expired.
 */
export class DirectAudioEngine implements Engine {
  readonly #events = new Emitter<EngineEventMap>()
  readonly #listeners = new AbortController()
  readonly #now: () => number
  readonly #clock: () => number
  readonly #isReadable: (stream: StreamOption) => boolean
  #createContext: (() => EffectsContext) | undefined
  /** The elements the browser lets start without a user gesture. */
  readonly #unlocked = new WeakSet<HTMLAudioElement>()
  /** Every element: two plain ones, then two routed ones where Web Audio exists. */
  readonly #slots: Slot[]
  /** The element that plays. */
  #active: Slot
  /** The element that preloads the next stream, while one does. */
  #standby: Slot | undefined
  /** What the active element plays. */
  #source: PlaybackSource | undefined
  /** What the standby element preloads. */
  #standbySource: PlaybackSource | undefined
  #standbyFailed = false
  /** A preload that waits for a crossfade to free an element. */
  #pendingPreload: PlaybackSource | null | undefined
  /** Where to start once the duration is known. */
  #pendingSeekMs: number | undefined
  /** Whether the active element's current source has started playing (and not paused since). */
  #playing = false
  /** Whether the active element played since its source was set: failures after that are real. */
  #startedSinceLoad = false
  /** Whether playback should go on: set by `play()`, cleared by `pause()` and `load()`. */
  #intent: 'play' | 'pause' = 'pause'
  /** Counts loads, so a deferred refusal of an old load is dropped. */
  #generation = 0
  /** Set while {@link unlock} plays and pauses an element, whose events then mean nothing. */
  #unlocking = false
  #destroyed = false
  #volume = 1
  #muted = false
  #rate = 1
  /** The output's fade factor (`fadeOutput`). */
  #outputGain = 1
  #outputFade: OutputFade | undefined
  #crossfade: Crossfade | undefined
  /** The effects in use; none until `setEffects`. */
  #effects: EngineEffects | undefined
  #context: EffectsContext | undefined
  #graph: EffectsGraph | undefined
  /** URLs that failed as CORS reads: they play without effects from now on. */
  readonly #unreadable = new Set<string>()
  /** Whether pages may set the volume (not on iOS). */
  readonly #volumeControl: boolean
  /** The status last reported, so an unchanged one isn't reported again. */
  #reported: string | undefined

  constructor(options: DirectAudioEngineOptions = {}) {
    const createAudio = options.createAudio ?? (() => document.createElement('audio'))
    this.#now = options.now ?? Date.now
    this.#clock = options.clock ?? (() => performance.now())
    this.#isReadable = options.isReadable ?? ((stream) => isLocalMediaUrl(stream.url))
    this.#createContext =
      options.createAudioContext === null
        ? undefined
        : (options.createAudioContext ?? defaultAudioContext())
    const plain = [createAudio(), createAudio()].map((element) => this.#prepare(element, false))
    const routed =
      this.#createContext === undefined
        ? []
        : [createAudio(), createAudio()].map((element) => this.#prepare(element, true))
    this.#slots = [...plain, ...routed]
    this.#active = plain[0] as Slot
    this.#standby = undefined
    this.#volumeControl = canSetVolume(this.#active.element)
  }

  async load(source: PlaybackSource, startAtMs = 0): Promise<void> {
    if (this.#destroyed) return
    this.#finishCrossfade()
    this.#generation += 1
    const generation = this.#generation
    this.#source = source
    this.#pendingSeekMs = undefined
    this.#playing = false
    this.#startedSinceLoad = false
    this.#intent = 'pause'
    const { stream } = source
    const refusal = this.#refusal(stream)
    if (refusal !== undefined) {
      this.#release(this.#active)
      queueMicrotask(() => {
        if (generation === this.#generation && !this.#destroyed) this.#events.emit('error', refusal)
      })
      this.#report()
      return
    }
    const routed = this.#wantsRouting(stream)
    const standby = this.#standby
    if (
      standby !== undefined &&
      stream.url === this.#standbySource?.stream.url &&
      !this.#standbyFailed &&
      this.#unlocked.has(standby.element) &&
      standby.routed === routed
    ) {
      this.#makeActive(standby)
      this.#prepareSource(standby, stream)
      const { duration } = standby.element
      if (Number.isFinite(duration) && duration > 0) {
        this.#events.emit('durationchange', duration * 1000)
      }
    } else {
      const target = this.#elementFor(routed)
      this.#makeActive(target)
      this.#prepareSource(target, stream)
      // Setting src pauses the element anyway; pausing first makes that explicit everywhere.
      target.element.pause()
      target.element.src = stream.url
    }
    if (startAtMs > 0) this.#seekTo(startAtMs)
    this.#report()
  }

  async play(): Promise<void> {
    const { element } = this.#active
    if (this.#destroyed || !element.hasAttribute('src')) return
    this.#intent = 'play'
    this.#start(element)
  }

  pause(): void {
    if (this.#destroyed) return
    this.#intent = 'pause'
    this.#finishCrossfade()
    this.#active.element.pause()
  }

  seek(positionMs: number): void {
    if (this.#destroyed || !Number.isFinite(positionMs)) return
    this.#finishCrossfade()
    this.#seekTo(Math.max(0, positionMs))
  }

  setVolume(volume: number): void {
    if (this.#destroyed || !Number.isFinite(volume)) return
    this.#volume = clamp01(volume)
    this.#applyAll()
  }

  setMuted(muted: boolean): void {
    if (this.#destroyed) return
    this.#muted = muted
    this.#applyAll()
  }

  /**
   * Loads `source` into another element so it can start at once; `null` drops it. Only when
   * that element is unlocked (see {@link unlock}): one that is not would never be swapped in,
   * and iOS does not even buffer for it. During a crossfade it waits until the fade is over.
   */
  preload(source: PlaybackSource | null): void {
    if (this.#destroyed) return
    if (this.#crossfade !== undefined) {
      this.#pendingPreload = source
      return
    }
    this.#pendingPreload = undefined
    if (source === null || this.#refusal(source.stream) !== undefined) {
      this.#dropStandby()
      return
    }
    const { stream } = source
    const target = this.#standbyElementFor(this.#wantsRouting(stream))
    if (target === undefined || !this.#unlocked.has(target.element)) {
      this.#dropStandby()
      return
    }
    if (target === this.#standby && stream.url === this.#standbySource?.stream.url) {
      if (!this.#standbyFailed) return
    }
    if (this.#standby !== undefined && this.#standby !== target) this.#dropStandby()
    this.#standby = target
    this.#standbySource = source
    this.#standbyFailed = false
    this.#prepareSource(target, stream)
    target.element.src = stream.url
  }

  /**
   * How sure the browser is that it can play `stream`: `canPlayType` for the stream's MIME
   * type (`mimeTypeOf`), `maybe` for a codec and container pair without one, and `no` for a
   * stream the engine refuses (not progressive, needing request headers, or `capped`).
   */
  canPlay(stream: StreamOption): PlaySupport {
    if (unsupportedReason(stream) !== undefined) return 'no'
    const type = mimeTypeOf(stream)
    if (type === undefined) return 'maybe'
    const answer = this.#active.element.canPlayType(type)
    return answer === '' ? 'no' : answer
  }

  /**
   * Plays and at once pauses every element that has no source yet and has not been unlocked,
   * inside the user gesture this is called from, so the browser lets it start later without
   * one (WebKit and Android WebView unlock elements one by one). An element the browser refuses
   * to start stays locked. Elements that hold a source are left alone: they unlock with their
   * first successful `play()`. With the equalizer on, it also creates the Web Audio context
   * and lets it run, which browsers allow only from a gesture.
   */
  unlock(): void {
    if (this.#destroyed) return
    for (const { element } of this.#slots) {
      if (this.#unlocked.has(element) || element.hasAttribute('src')) continue
      this.#unlocked.add(element)
      let started: Promise<void> | undefined
      this.#unlocking = true
      try {
        started = element.play()
        element.pause()
      } catch {
        this.#unlocked.delete(element)
      } finally {
        this.#unlocking = false
      }
      started?.catch((error: unknown) => {
        // The pause rejects the request with AbortError; only NotAllowedError means "refused".
        if (errorName(error) === 'NotAllowedError') this.#unlocked.delete(element)
      })
    }
    // Browsers let an audio context start only from a user's action: this is one.
    if (this.#effects?.equalizer.enabled === true) this.#ensureContext()
    this.#resumeContext()
  }

  /**
   * Applies the equalizer and loudness normalization. Loudness changes the level of what plays
   * and is preloaded at once. An equalizer that shapes the sound (on, with a band off 0 dB) moves
   * a readable stream that plays onto a routed element, at the same position; switching it off or
   * flattening it leaves the stream there, flat, so nothing restarts. Reports what they do with
   * `effects`.
   */
  setEffects(effects: EngineEffects): void {
    if (this.#destroyed) return
    this.#effects = effects
    this.#graph?.setEqualizer(effects.equalizer.enabled ? effects.equalizer.gainsDb : undefined)
    for (const slot of [this.#active, this.#standby]) {
      const stream = this.#streamOf(slot)
      if (slot !== undefined && stream !== undefined) slot.gainDb = this.#gainFor(slot, stream)
    }
    if (effects.equalizer.enabled && this.#source !== undefined) {
      // The switch's click while something is loaded: a gesture, in which the context may
      // start. Otherwise the next play's `unlock()` starts it, not the settings read at startup.
      this.#ensureContext()
      this.#resumeContext()
    }
    this.#applyAll()
    this.#reroute(false)
    this.#report()
  }

  /** Sets the playback speed of every element, keeping the pitch. */
  setPlaybackRate(rate: number): void {
    if (this.#destroyed || !Number.isFinite(rate) || rate <= 0) return
    this.#rate = rate
    for (const slot of this.#slots) this.#applyRate(slot.element)
  }

  /**
   * Starts the preloaded `source` now and crossfades into it over `durationMs`, with equal-power
   * curves: see {@link Engine.crossfade}. Only while the current source plays, and only when the
   * preloaded element has enough buffered to play on. Where pages can't set the volume (iOS),
   * only between two routed elements, whose levels Web Audio sets: a plain element would play at
   * full level throughout.
   */
  crossfade(source: PlaybackSource, durationMs: number): boolean {
    const standby = this.#standby
    const outgoing = this.#active
    if (
      this.#destroyed ||
      standby === undefined ||
      source.stream.url !== this.#standbySource?.stream.url ||
      this.#standbyFailed ||
      !this.#unlocked.has(standby.element) ||
      standby.element.readyState < HAVE_FUTURE_DATA ||
      standby.routed !== this.#wantsRouting(source.stream) ||
      !this.#playing ||
      outgoing.element.paused ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      (!this.#volumeControl && (outgoing.chain === undefined || standby.chain === undefined))
    ) {
      return false
    }
    this.#finishCrossfade()
    this.#generation += 1
    const generation = this.#generation
    this.#source = source
    this.#pendingSeekMs = undefined
    this.#playing = false
    this.#startedSinceLoad = false
    this.#intent = 'play'
    this.#active = standby
    this.#standby = undefined
    this.#standbySource = undefined
    this.#standbyFailed = false
    standby.fade = 0
    this.#apply(standby)
    const startedAt = this.#clock()
    const timer = setInterval(() => this.#stepCrossfade(), FADE_STEP_MS)
    this.#crossfade = { slot: outgoing, startedAt, durationMs, timer }
    this.#start(standby.element)
    // Its element knew its duration from preloading and won't say it again. Said once the call
    // has returned, when the player has taken the new source as its own.
    queueMicrotask(() => {
      if (this.#destroyed || generation !== this.#generation || this.#active !== standby) return
      const { duration } = standby.element
      if (Number.isFinite(duration) && duration > 0) {
        this.#events.emit('durationchange', duration * 1000)
      }
    })
    this.#report()
    return true
  }

  /** Whether pages may set the volume here: not on iOS, where only Web Audio's gains fade. */
  canSetVolume(): boolean {
    return this.#volumeControl
  }

  /** Fades the whole output to `gain` over `durationMs` (see {@link Engine.fadeOutput}). */
  fadeOutput(gain: number, durationMs: number): void {
    if (this.#destroyed) return
    const to = clamp01(gain)
    if (this.#outputFade !== undefined) clearInterval(this.#outputFade.timer)
    this.#outputFade = undefined
    if (!(durationMs > 0)) {
      this.#outputGain = to
      this.#applyAll()
      return
    }
    const timer = setInterval(() => this.#stepOutputFade(), FADE_STEP_MS)
    this.#outputFade = { from: this.#outputGain, to, startedAt: this.#clock(), durationMs, timer }
  }

  on<K extends EngineEventType>(
    type: K,
    listener: (payload: EngineEventMap[K]) => void,
  ): () => void {
    return this.#events.on(type, listener)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    if (this.#crossfade !== undefined) clearInterval(this.#crossfade.timer)
    if (this.#outputFade !== undefined) clearInterval(this.#outputFade.timer)
    this.#crossfade = undefined
    this.#outputFade = undefined
    this.#listeners.abort()
    for (const slot of this.#slots) this.#release(slot)
    void this.#context?.close?.().catch(() => {})
    this.#events.clear()
  }

  // --- Elements ------------------------------------------------------------------------------

  /** Why the engine refuses `stream` without trying it, if it does. */
  #refusal(stream: StreamOption): EngineError | undefined {
    const reason = unsupportedReason(stream)
    if (reason !== undefined) return new EngineError('unsupported', reason)
    if (this.#hasExpired(stream)) return new EngineError('expired', MESSAGES.expired)
    return undefined
  }

  #hasExpired(stream: StreamOption): boolean {
    return stream.expiresAt !== undefined && stream.expiresAt <= this.#now()
  }

  /**
   * The element to play a stream on, plain or `routed`: the active element when it is of that
   * kind, else another of that kind; one the browser lets start without a gesture where there is
   * a choice.
   */
  #elementFor(routed: boolean): Slot {
    const active = this.#active
    const unlocked = (slot: Slot) => this.#unlocked.has(slot.element)
    const candidates = this.#slots.filter(
      (slot) => slot.routed === routed && slot !== this.#crossfade?.slot,
    )
    if (active.routed === routed) {
      // Start on an element the browser lets play without a gesture, when only the other is.
      if (unlocked(active)) return active
      return candidates.find((slot) => slot !== active && unlocked(slot)) ?? active
    }
    return candidates.find(unlocked) ?? candidates[0] ?? active
  }

  /**
   * The element to preload a stream on, plain or `routed`: the one preloading already, else
   * another of that kind that isn't playing or fading out. None while every such element is.
   */
  #standbyElementFor(routed: boolean): Slot | undefined {
    const candidates = this.#slots.filter(
      (slot) => slot.routed === routed && slot !== this.#active && slot !== this.#crossfade?.slot,
    )
    return candidates.find((slot) => slot === this.#standby) ?? candidates[0]
  }

  /** Makes `slot` the active element and releases the one it replaces. */
  #makeActive(slot: Slot): void {
    const previous = this.#active
    if (slot === this.#standby) {
      this.#standby = undefined
      this.#standbySource = undefined
      this.#standbyFailed = false
    }
    this.#active = slot
    if (previous !== slot) {
      previous.fade = 1
      this.#release(previous)
    }
  }

  /** Drops what the standby element preloads. */
  #dropStandby(): void {
    const standby = this.#standby
    this.#standby = undefined
    this.#standbySource = undefined
    this.#standbyFailed = false
    if (standby !== undefined && standby !== this.#active && standby !== this.#crossfade?.slot) {
      this.#release(standby)
    }
  }

  /** The stream `slot` holds, if any. */
  #streamOf(slot: Slot | undefined): StreamOption | undefined {
    if (slot === undefined) return undefined
    if (slot === this.#active) return this.#source?.stream
    if (slot === this.#standby) return this.#standbySource?.stream
    return undefined
  }

  /** Sets `slot` up for `stream`: its loudness gain, its graph connection, speed and volume. */
  #prepareSource(slot: Slot, stream: StreamOption): void {
    if (slot.routed) this.#connect(slot)
    slot.gainDb = this.#gainFor(slot, stream)
    slot.fade = 1
    this.#applyRate(slot.element)
    this.#apply(slot)
  }

  /** Plays `element`, reporting a refusal by the autoplay policy as `autoplay-blocked`. */
  #start(element: HTMLAudioElement): void {
    const generation = this.#generation
    element.play().then(
      () => {
        this.#unlocked.add(element)
      },
      (error: unknown) => {
        if (generation !== this.#generation || element !== this.#active.element) return
        if (this.#destroyed) return
        // AbortError: a pause or a new source interrupted the request. NotSupportedError: the
        // element reports that failure itself, as an `error` event.
        if (errorName(error) !== 'NotAllowedError') return
        const message = MESSAGES['autoplay-blocked']
        this.#events.emit('error', new EngineError('autoplay-blocked', message, { cause: error }))
      },
    )
  }

  #seekTo(positionMs: number): void {
    const { element } = this.#active
    if (element.readyState >= HAVE_METADATA) {
      this.#pendingSeekMs = undefined
      element.currentTime = positionMs / 1000
    } else {
      this.#pendingSeekMs = positionMs
    }
  }

  /** Stops an element and drops its source, which also ends its download. */
  #release(slot: Slot): void {
    const { element } = slot
    element.pause()
    if (!element.hasAttribute('src')) return
    element.removeAttribute('src')
    element.load()
  }

  #applyRate(element: HTMLAudioElement): void {
    element.defaultPlaybackRate = this.#rate
    element.playbackRate = this.#rate
    // Browsers keep the pitch by default; say so anyway, with the prefix of older Safari.
    if ('preservesPitch' in element) element.preservesPitch = true
    else if ('webkitPreservesPitch' in element) Reflect.set(element, 'webkitPreservesPitch', true)
  }

  // --- Levels --------------------------------------------------------------------------------

  /**
   * The loudness gain of `stream` on `slot`, in dB: turning up only on a routed element, which
   * Web Audio processes.
   */
  #gainFor(slot: Slot, stream: StreamOption): number {
    const effects = this.#effects
    if (effects === undefined) return 0
    return loudnessGainDb(stream.loudness, effects.loudness, { boost: slot.routed })
  }

  /**
   * Sets `slot`'s levels. A plain element's volume carries everything: the volume, the loudness
   * gain (down only), its crossfade factor and the output fade. A routed element stays at full
   * volume, unmuted, and the graph applies them, the loudness gain also upwards.
   */
  #apply(slot: Slot): void {
    const { element, chain } = slot
    const context = this.#context
    if (chain !== undefined && context !== undefined) {
      element.volume = 1
      element.muted = false
      setParam(context, chain.loudness.gain, dbToGain(slot.gainDb))
      setParam(context, chain.fade.gain, slot.fade)
      return
    }
    const loudness = dbToGain(Math.min(0, slot.gainDb))
    element.volume = clamp01(this.#volume * loudness * slot.fade * this.#outputGain)
    element.muted = this.#muted
  }

  /** Sets the levels of every element and of the graph's output. */
  #applyAll(): void {
    for (const slot of this.#slots) this.#apply(slot)
    this.#graph?.setMaster(this.#muted ? 0 : this.#volume * this.#outputGain)
  }

  #stepCrossfade(): void {
    const fade = this.#crossfade
    if (fade === undefined) return
    const progress = (this.#clock() - fade.startedAt) / fade.durationMs
    if (progress >= 1) {
      this.#finishCrossfade()
      return
    }
    const gains = crossfadeGains(progress)
    fade.slot.fade = gains.out
    this.#active.fade = gains.in
    this.#apply(fade.slot)
    this.#apply(this.#active)
  }

  /** Ends a crossfade at once: the old element stops, the new one plays at full level. */
  #finishCrossfade(): void {
    const fade = this.#crossfade
    if (fade === undefined) return
    clearInterval(fade.timer)
    this.#crossfade = undefined
    fade.slot.fade = 1
    this.#release(fade.slot)
    this.#apply(fade.slot)
    this.#active.fade = 1
    this.#apply(this.#active)
    const pending = this.#pendingPreload
    this.#pendingPreload = undefined
    if (pending !== undefined) this.preload(pending)
  }

  #stepOutputFade(): void {
    const fade = this.#outputFade
    if (fade === undefined) return
    const progress = Math.min(1, (this.#clock() - fade.startedAt) / fade.durationMs)
    this.#outputGain = fade.from + (fade.to - fade.from) * progress
    if (progress >= 1) {
      clearInterval(fade.timer)
      this.#outputFade = undefined
    }
    this.#applyAll()
  }

  // --- Web Audio -----------------------------------------------------------------------------

  /**
   * Whether `stream` should play through Web Audio: an effect needs it (the equalizer shapes the
   * sound, or the track should be turned up), its bytes are readable, and the context runs. A
   * flat equalizer, as it is when first switched on, needs nothing: moving the stream would only
   * restart its download. Where pages can't set the volume (iOS), only the equalizer routes a
   * stream: WebKit there suspends Web Audio when the screen locks, which a plain element plays
   * through.
   */
  #wantsRouting(stream: StreamOption): boolean {
    const effects = this.#effects
    if (
      effects === undefined ||
      (this.#createContext === undefined && this.#context === undefined)
    ) {
      return false
    }
    if (this.#unreadable.has(stream.url) || !this.#isReadable(stream)) return false
    const boost =
      this.#volumeControl && loudnessGainDb(stream.loudness, effects.loudness, { boost: true }) > 0
    if (!shapesSound(effects.equalizer) && !boost) return false
    return this.#ensureContext()?.state === 'running'
  }

  /** The audio context, created the first time it is needed; `undefined` where it can't be. */
  #ensureContext(): EffectsContext | undefined {
    if (this.#context !== undefined) return this.#context
    const create = this.#createContext
    if (create === undefined) return undefined
    let context: EffectsContext
    try {
      context = create()
    } catch {
      this.#createContext = undefined
      return undefined
    }
    this.#context = context
    const graph = new EffectsGraph(context)
    this.#graph = graph
    const equalizer = this.#effects?.equalizer
    graph.setEqualizer(equalizer?.enabled === true ? equalizer.gainsDb : undefined)
    graph.setMaster(this.#muted ? 0 : this.#volume * this.#outputGain)
    context.addEventListener('statechange', () => this.#onContextState())
    return context
  }

  /** Lets the context run, from a user gesture. */
  #resumeContext(): void {
    const context = this.#context
    if (context === undefined || context.state === 'running' || context.state === 'closed') return
    void context.resume().catch(() => {})
  }

  /** Connects a routed element to the graph, once. */
  #connect(slot: Slot): void {
    if (slot.chain !== undefined) return
    const graph = this.#graph ?? (this.#ensureContext() === undefined ? undefined : this.#graph)
    if (graph === undefined) return
    try {
      slot.chain = graph.connect(slot.element)
    } catch {
      // The browser refused: the element plays as it is (its volume carries the levels).
    }
  }

  /**
   * The context started or stopped. Running: a readable stream that wants effects moves onto a
   * routed element. Stopped while a routed element plays (the browser suspended it): its audio
   * would be silent, so the stream moves onto a plain element, without effects.
   */
  #onContextState(): void {
    if (this.#destroyed) return
    this.#reroute(true)
    this.#report()
  }

  /**
   * Moves the active stream onto an element of the kind it wants now, at the same position and
   * playing if it was: to a routed one when an effect needs it, and with `downgrade` also back
   * to a plain one when it can't be routed any more.
   */
  #reroute(downgrade: boolean): void {
    const source = this.#source
    const active = this.#active
    if (source === undefined || !active.element.hasAttribute('src')) return
    const routed = this.#wantsRouting(source.stream)
    if (routed === active.routed) return
    if (!routed && (!downgrade || active.chain === undefined)) return
    this.#finishCrossfade()
    const positionMs = this.#pendingSeekMs ?? active.element.currentTime * 1000
    const resume = this.#intent === 'play'
    this.#generation += 1
    this.#playing = false
    this.#startedSinceLoad = false
    this.#pendingSeekMs = undefined
    const target = this.#elementFor(routed)
    this.#makeActive(target)
    this.#prepareSource(target, source.stream)
    target.element.src = source.stream.url
    if (positionMs > 0) this.#seekTo(positionMs)
    if (resume) {
      this.#intent = 'play'
      this.#start(target.element)
    }
  }

  /** Reports what the effects do to the active stream, when it changed. */
  #report(): void {
    const effects = this.#effects
    if (effects === undefined || this.#destroyed) return
    const slot = this.#active
    const stream = this.#source?.stream
    const loaded = stream !== undefined && slot.element.hasAttribute('src')
    let equalizer: AudioEffectsStatus['equalizer'] = 'off'
    if (effects.equalizer.enabled) {
      // A flat equalizer has nothing to process, wherever the stream plays.
      const processes = !loaded || slot.chain !== undefined || !shapesSound(effects.equalizer)
      equalizer = processes ? 'on' : 'unavailable'
    }
    let loudness: AudioEffectsStatus['loudness'] = 'off'
    let loudnessGainDb = 0
    if (effects.loudness.enabled) {
      if (!loaded || stream.loudness === undefined) {
        loudness = 'no-data'
      } else if (slot.chain === undefined && !this.#volumeControl && slot.gainDb < 0) {
        loudness = 'unavailable'
      } else {
        loudness = 'on'
        loudnessGainDb = slot.chain === undefined ? Math.min(0, slot.gainDb) : slot.gainDb
      }
    }
    const status: AudioEffectsStatus = { equalizer, loudness, loudnessGainDb }
    const key = `${equalizer}|${loudness}|${loudnessGainDb}`
    if (key === this.#reported) return
    this.#reported = key
    this.#events.emit('effects', status)
  }

  // --- Events --------------------------------------------------------------------------------

  #toEngineError(error: MediaError): EngineError {
    let type: EngineErrorType = 'network'
    if (error.code === MEDIA_ERR_DECODE) type = 'decode'
    else if (error.code === MEDIA_ERR_SRC_NOT_SUPPORTED) type = 'unsupported'
    const source = this.#source
    if (type !== 'decode' && source !== undefined && this.#hasExpired(source.stream)) {
      type = 'expired'
    }
    return new EngineError(type, error.message || MESSAGES[type], { cause: error })
  }

  /**
   * Whether `error` on the active routed element looks like a refused CORS read: a network or
   * "not supported" failure before the stream played. It then plays again without effects.
   */
  #isCorsFailure(slot: Slot, error: MediaError): boolean {
    return (
      slot.routed &&
      !this.#startedSinceLoad &&
      (error.code === MEDIA_ERR_NETWORK || error.code === MEDIA_ERR_SRC_NOT_SUPPORTED)
    )
  }

  /** Sets up one element and maps its events while it is the active one. */
  #prepare(element: HTMLAudioElement, routed: boolean): Slot {
    const slot: Slot = { element, routed, chain: undefined, gainDb: 0, fade: 1 }
    if (routed) {
      // Routed elements read their bytes, which Web Audio needs: see the module documentation.
      element.crossOrigin = 'anonymous'
    } else {
      // Never on plain elements: see the module documentation.
      element.removeAttribute('crossorigin')
    }
    element.preload = 'auto'
    const { signal } = this.#listeners
    const listen = (type: string, handler: () => void) => {
      const guarded = () => {
        if (slot === this.#active && !this.#destroyed && !this.#unlocking) handler()
      }
      element.addEventListener(type, guarded, { signal })
    }
    const emit = <K extends EngineEventType>(type: K, payload: EngineEventMap[K]) => {
      this.#events.emit(type, payload)
    }
    listen('timeupdate', () => {
      // Until the start position is applied, the element reports the 0 it is leaving.
      if (this.#pendingSeekMs === undefined) emit('timeupdate', element.currentTime * 1000)
    })
    listen('durationchange', () => {
      const { duration } = element
      if (Number.isFinite(duration) && duration > 0) emit('durationchange', duration * 1000)
    })
    listen('loadedmetadata', () => {
      const pending = this.#pendingSeekMs
      if (pending === undefined) return
      this.#pendingSeekMs = undefined
      element.currentTime = pending / 1000
    })
    listen('playing', () => {
      if (element.paused) return
      this.#playing = true
      this.#startedSinceLoad = true
      emit('play', undefined)
    })
    listen('pause', () => {
      // The element also pauses right before `ended`; that one is not a pause.
      if (!this.#playing || element.ended) return
      this.#playing = false
      emit('pause', undefined)
    })
    listen('ended', () => {
      if (!element.ended) return
      this.#playing = false
      emit('ended', undefined)
    })
    listen('waiting', () => emit('waiting', undefined))
    listen('stalled', () => {
      // Browsers also fire `stalled` while buffered audio plays on; only starving counts.
      if (element.readyState < HAVE_FUTURE_DATA) emit('stalled', undefined)
    })
    listen('canplay', () => emit('canplay', undefined))
    listen('error', () => {
      const { error } = element
      if (error === null) return
      const source = this.#source
      if (source !== undefined && this.#isCorsFailure(slot, error)) {
        this.#unreadable.add(source.stream.url)
        this.#reroute(true)
        this.#report()
        return
      }
      emit('error', this.#toEngineError(error))
    })
    element.addEventListener(
      'error',
      () => {
        if (slot !== this.#standby) return
        this.#standbyFailed = true
        // A routed preload that failed is most likely a refused CORS read.
        const url = this.#standbySource?.stream.url
        if (slot.routed && url !== undefined) this.#unreadable.add(url)
      },
      { signal },
    )
    element.addEventListener(
      'ended',
      () => {
        // The element fading out reached its end: the crossfade is over.
        if (slot === this.#crossfade?.slot) this.#finishCrossfade()
      },
      { signal },
    )
    return slot
  }
}
