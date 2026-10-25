/**
 * The direct audio engine: plays progressive streams with `HTMLAudioElement`, on web and
 * desktop.
 *
 * - **No `crossOrigin`.** googlevideo answers media requests from other sites without CORS
 *   headers, so a CORS-mode request (`crossorigin="anonymous"`) fails. A plain media request
 *   plays any stream that was resolved on this device. Web Audio, which needs CORS, is not used.
 * - **No byte fetching.** The engine only sets `src`; it never reads stream bytes with `fetch`
 *   or MediaSource, which googlevideo would refuse to the page. A plain `<audio src>` also
 *   follows googlevideo's cross-host redirects that a CORS read cannot.
 * - **Near-gapless.** A second element preloads the next stream (`preload="auto"`); loading
 *   that stream then swaps the elements instead of starting a new download.
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
} from './engine'
import { mimeTypeOf } from './mime'

/** `HTMLMediaElement.HAVE_METADATA`: the duration and dimensions are known. */
const HAVE_METADATA = 1

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

/** Plays progressive streams through two alternating `HTMLAudioElement`s. */
export class DirectAudioEngine implements Engine {
  readonly #events = new Emitter<EngineEventMap>()
  readonly #listeners = new AbortController()
  readonly #now: () => number
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
    if (stream.url === this.#standbyUrl && !this.#standbyFailed) {
      const previous = this.#active
      this.#active = this.#standby
      this.#standby = previous
      this.#standbyUrl = undefined
      this.#release(previous)
      const { duration } = this.#active
      if (Number.isFinite(duration) && duration > 0) {
        this.#events.emit('durationchange', duration * 1000)
      }
    } else {
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
    element.play().catch((error: unknown) => {
      if (generation !== this.#generation || element !== this.#active || this.#destroyed) return
      // AbortError: a pause or a new source interrupted the request. NotSupportedError: the
      // element reports that failure itself, as an `error` event.
      if (errorName(error) !== 'NotAllowedError') return
      const message = MESSAGES['autoplay-blocked']
      this.#events.emit('error', new EngineError('autoplay-blocked', message, { cause: error }))
    })
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

  /** Loads `source` into the second element so it can start at once; `null` drops it. */
  preload(source: PlaybackSource | null): void {
    if (this.#destroyed) return
    if (source === null || this.#refusal(source.stream) !== undefined) {
      this.#standbyUrl = undefined
      this.#release(this.#standby)
      return
    }
    const { url } = source.stream
    if (url === this.#standbyUrl && !this.#standbyFailed) return
    this.#standbyUrl = url
    this.#standbyFailed = false
    this.#standby.src = url
  }

  /**
   * Whether the browser can play `stream`: a progressive stream whose MIME type
   * `canPlayType` does not reject. Unknown codec and container pairs are left to the element.
   */
  canPlay(stream: StreamOption): boolean {
    if (stream.protocol !== 'progressive') return false
    const type = mimeTypeOf(stream)
    return type === undefined || this.#active.canPlayType(type) !== ''
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
    if (stream.protocol !== 'progressive') {
      const message = `Direct audio plays progressive streams, not ${stream.protocol}`
      return new EngineError('unsupported', message)
    }
    if (this.#hasExpired(stream)) return new EngineError('expired', MESSAGES.expired)
    return undefined
  }

  #hasExpired(stream: StreamOption): boolean {
    return stream.expiresAt !== undefined && stream.expiresAt <= this.#now()
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
        if (element === this.#active && !this.#destroyed) handler()
      }
      element.addEventListener(type, guarded, { signal })
    }
    const emit = <K extends EngineEventType>(type: K, payload: EngineEventMap[K]) => {
      this.#events.emit(type, payload)
    }
    listen('timeupdate', () => emit('timeupdate', element.currentTime * 1000))
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
    listen('stalled', () => emit('stalled', undefined))
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
