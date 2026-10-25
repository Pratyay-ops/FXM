/**
 * The direct audio engine: plays progressive streams with `HTMLAudioElement`, on web and
 * desktop.
 *
 * - **No `crossOrigin`.** googlevideo answers media requests from other sites without CORS
 *   headers, so a CORS-mode request (`crossorigin="anonymous"`) fails. A plain media request
 *   plays any stream that was resolved on this device. Web Audio, which needs CORS, is not used.
 * - **No byte fetching.** The engine only sets `src`; it never reads stream bytes with `fetch`
 *   or MediaSource, which googlevideo would refuse to the page. A plain `<audio src>` also
 *   follows googlevideo's cross-host redirects that a CORS read cannot. For the same reason it
 *   cannot send request headers, so it refuses a stream that needs some (`requestHeaders`).
 * - **Near-gapless.** A second element preloads the next stream (`preload="auto"`); loading
 *   that stream then swaps the elements instead of starting a new download.
 * - **User gestures.** WebKit and Android WebView let `play()` start only an element that was
 *   once played in a user gesture. {@link DirectAudioEngine.unlock}, which the player calls in
 *   every user action, does that for both elements; an element that is not unlocked is never
 *   swapped in, so playback stays on one that is.
 * - **Typed failures.** `play()` refusals from the autoplay policy and `MediaError` codes are
 *   reported as `EngineError`s; an error after the stream's `expiresAt` is `expired`.
 *
 * Events are checked against the element's state when they arrive, so events of a replaced
 * source never leak through, even in a browser that delivers them late.
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'
import { Emitter } from './emitter'
import {
  type Engine,
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

/** `MediaError.MEDIA_ERR_DECODE`. */
const MEDIA_ERR_DECODE = 3

/** `MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED`, also what a refused (e.g. 403) request reports. */
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

const MESSAGES: Readonly<Record<EngineErrorType, string>> = {
  network: 'The stream could not be loaded',
  decode: 'The stream could not be decoded',
  'autoplay-blocked': 'The browser wants a user gesture before playback starts',
  unsupported: 'The stream format is not supported or the server refused it',
  expired: 'The stream URL has expired',
}

/** Options for {@link DirectAudioEngine}. */
export interface DirectAudioEngineOptions {
  /** Creates the engine's two audio elements. Default: `document.createElement('audio')`. */
  createAudio?: () => HTMLAudioElement
  /** The clock, in epoch milliseconds, for stream expiry. Default: `Date.now`. */
  now?: () => number
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
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

/**
 * Plays progressive streams through two alternating `HTMLAudioElement`s. It refuses, without
 * loading them, streams that are not progressive, that need request headers (an `<audio>`
 * element cannot send any), that are `capped`, or that have already expired.
 */
export class DirectAudioEngine implements Engine {
  readonly #events = new Emitter<EngineEventMap>()
  readonly #listeners = new AbortController()
  readonly #now: () => number
  /** The elements the browser lets start without a user gesture. */
  readonly #unlocked = new WeakSet<HTMLAudioElement>()
  /** The element that plays. */
  #active: HTMLAudioElement
  /** The element that preloads the next stream. */
  #standby: HTMLAudioElement
  /** What the active element plays. */
  #source: PlaybackSource | undefined
  /** The URL the standby element preloads. */
  #standbyUrl: string | undefined
  #standbyFailed = false
  /** Where to start once the duration is known. */
  #pendingSeekMs: number | undefined
  /** Whether the active element's current source has started playing (and not paused since). */
  #playing = false
  /** Counts loads, so a deferred refusal of an old load is dropped. */
  #generation = 0
  /** Set while {@link unlock} plays and pauses an element, whose events then mean nothing. */
  #unlocking = false
  #destroyed = false

  constructor(options: DirectAudioEngineOptions = {}) {
    const createAudio = options.createAudio ?? (() => document.createElement('audio'))
    this.#now = options.now ?? Date.now
    this.#active = this.#prepare(createAudio())
    this.#standby = this.#prepare(createAudio())
  }

  async load(source: PlaybackSource, startAtMs = 0): Promise<void> {
    if (this.#destroyed) return
    this.#generation += 1
    const generation = this.#generation
    this.#source = source
    this.#pendingSeekMs = undefined
    this.#playing = false
    const { stream } = source
    const refusal = this.#refusal(stream)
    if (refusal !== undefined) {
      this.#release(this.#active)
      queueMicrotask(() => {
        if (generation === this.#generation && !this.#destroyed) this.#events.emit('error', refusal)
      })
      return
    }
    const standby = this.#standby
    if (stream.url === this.#standbyUrl && !this.#standbyFailed && this.#unlocked.has(standby)) {
      this.#swap()
      const { duration } = this.#active
      if (Number.isFinite(duration) && duration > 0) {
        this.#events.emit('durationchange', duration * 1000)
      }
    } else {
      // Start on an element the browser lets play without a gesture, when only the other is.
      if (!this.#unlocked.has(this.#active) && this.#unlocked.has(standby)) this.#swap()
      // Setting src pauses the element anyway; pausing first makes that explicit everywhere.
      this.#active.pause()
      this.#active.src = stream.url
    }
    if (startAtMs > 0) this.#seekTo(startAtMs)
  }

  async play(): Promise<void> {
    const element = this.#active
    if (this.#destroyed || !element.hasAttribute('src')) return
    const generation = this.#generation
    element.play().then(
      () => {
        this.#unlocked.add(element)
      },
      (error: unknown) => {
        if (generation !== this.#generation || element !== this.#active || this.#destroyed) return
        // AbortError: a pause or a new source interrupted the request. NotSupportedError: the
        // element reports that failure itself, as an `error` event.
        if (errorName(error) !== 'NotAllowedError') return
        const message = MESSAGES['autoplay-blocked']
        this.#events.emit('error', new EngineError('autoplay-blocked', message, { cause: error }))
      },
    )
  }

  pause(): void {
    if (!this.#destroyed) this.#active.pause()
  }

  seek(positionMs: number): void {
    if (this.#destroyed || !Number.isFinite(positionMs)) return
    this.#seekTo(Math.max(0, positionMs))
  }

  setVolume(volume: number): void {
    if (this.#destroyed || !Number.isFinite(volume)) return
    const value = Math.min(1, Math.max(0, volume))
    this.#active.volume = value
    this.#standby.volume = value
  }

  setMuted(muted: boolean): void {
    if (this.#destroyed) return
    this.#active.muted = muted
    this.#standby.muted = muted
  }

  /**
   * Loads `source` into the second element so it can start at once; `null` drops it. Only
   * when that element is unlocked (see {@link unlock}): one that is not would never be swapped
   * in, and iOS does not even buffer for it.
   */
  preload(source: PlaybackSource | null): void {
    if (this.#destroyed) return
    const standby = this.#standby
    if (
      source === null ||
      this.#refusal(source.stream) !== undefined ||
      !this.#unlocked.has(standby)
    ) {
      this.#standbyUrl = undefined
      this.#release(standby)
      return
    }
    const { url } = source.stream
    if (url === this.#standbyUrl && !this.#standbyFailed) return
    this.#standbyUrl = url
    this.#standbyFailed = false
    standby.src = url
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
    const answer = this.#active.canPlayType(type)
    return answer === '' ? 'no' : answer
  }

  /**
   * Plays and at once pauses every element that has no source yet and has not been unlocked,
   * inside the user gesture this is called from, so the browser lets it start later without
   * one (WebKit and Android WebView unlock elements one by one). An element the browser refuses
   * to start stays locked. Elements that hold a source are left alone: they unlock with their
   * first successful `play()`.
   */
  unlock(): void {
    if (this.#destroyed) return
    for (const element of [this.#active, this.#standby]) {
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
    this.#listeners.abort()
    this.#release(this.#active)
    this.#release(this.#standby)
    this.#events.clear()
  }

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

  /** Makes the standby element the active one and releases the other. */
  #swap(): void {
    const previous = this.#active
    this.#active = this.#standby
    this.#standby = previous
    this.#standbyUrl = undefined
    this.#standbyFailed = false
    this.#release(previous)
  }

  #seekTo(positionMs: number): void {
    const element = this.#active
    if (element.readyState >= HAVE_METADATA) {
      this.#pendingSeekMs = undefined
      element.currentTime = positionMs / 1000
    } else {
      this.#pendingSeekMs = positionMs
    }
  }

  /** Stops an element and drops its source, which also ends its download. */
  #release(element: HTMLAudioElement): void {
    element.pause()
    if (!element.hasAttribute('src')) return
    element.removeAttribute('src')
    element.load()
  }

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

  /** Sets up one of the two elements and maps its events while it is the active one. */
  #prepare(element: HTMLAudioElement): HTMLAudioElement {
    // Never set crossOrigin: see the module documentation.
    element.removeAttribute('crossorigin')
    element.preload = 'auto'
    const { signal } = this.#listeners
    const listen = (type: string, handler: () => void) => {
      const guarded = () => {
        if (element === this.#active && !this.#destroyed && !this.#unlocking) handler()
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
      if (error !== null) emit('error', this.#toEngineError(error))
    })
    element.addEventListener(
      'error',
      () => {
        if (element === this.#standby) this.#standbyFailed = true
      },
      { signal },
    )
    return element
  }
}
