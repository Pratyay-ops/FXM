/**
 * The MediaSource engine: plays YouTube's SABR streams (`protocol: 'sabr'`), which no `<audio
 * src>` can, by feeding a session's audio into a `MediaSource` attached to an audio element. It
 * implements stage 2.2's engine contract (`engine-contract.ts`), so the player facade drives it
 * like the direct audio engine. Where it runs:
 *
 * - **Web, with FXM Connect:** the session's requests go through the page's `fetch` with FXM
 *   Connect's googlevideo rules (CORS for the FXM origin, a YouTube origin on preflights). After a
 *   cross-host redirect googlevideo's answers stay unreadable to the page, which ends the session
 *   with a `network` error; the playback policy then re-resolves.
 * - **Desktop:** the native `fetch` of stage 7.2.
 * - Not Android: its native player (stage 6.3) plays the queue there.
 *
 * The session downloads the song as fast as the server lets it, and the engine appends each
 * chunk as the source buffer takes it. When the buffer is full (`QuotaExceededError`), the engine
 * removes what lies more than 10 s behind the playhead, or waits for playback to move on. A seek
 * into data already removed starts the session again from the beginning.
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'
import {
  type Engine,
  EngineError,
  type EngineErrorType,
  type EngineEventMap,
  type EngineEventType,
  type PlaybackSource,
  type PlaySupport,
} from './engine-contract'
import { type SabrFeed, type SabrFeedStarter, startSabrFeed } from './sabr-feed'
import { parseSabrPlayback, type SabrPlayback } from './sabr-playback'

/** `HTMLMediaElement.HAVE_FUTURE_DATA`: enough is buffered to play on for a while. */
const HAVE_FUTURE_DATA = 3

/** `MediaError.MEDIA_ERR_DECODE`. */
const MEDIA_ERR_DECODE = 3

/** `MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED`. */
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

/** How much played audio the engine keeps when the source buffer is full, in seconds. */
const KEEP_BEHIND_SECONDS = 10

/** How long a full buffer waits for playback to move on before trying again, in milliseconds. */
const FULL_BUFFER_WAIT_MS = 1_000

/** What the engine needs of `MediaSource` and object URLs. */
export interface MediaSourceHost {
  /** Creates a media source. */
  create(): MediaSource
  /** Whether a source buffer takes `mimeType`, e.g. `audio/webm; codecs="opus"`. */
  isTypeSupported(mimeType: string): boolean
  /** An object URL for `source`, to set as the element's `src`. */
  createObjectURL(source: MediaSource): string
  /** Releases an object URL. */
  revokeObjectURL(url: string): void
}

/**
 * The page's `MediaSource` (or Safari's `ManagedMediaSource`) and `URL`, or `undefined` where
 * there is none.
 */
export function browserMediaSource(global: object = globalThis): MediaSourceHost | undefined {
  const scope = global as {
    MediaSource?: typeof MediaSource
    ManagedMediaSource?: typeof MediaSource
    URL?: typeof URL
  }
  const Source = scope.MediaSource ?? scope.ManagedMediaSource
  const Url = scope.URL
  if (Source === undefined || Url === undefined || typeof Url.createObjectURL !== 'function') {
    return undefined
  }
  return {
    create: () => new Source(),
    isTypeSupported: (mimeType) => Source.isTypeSupported(mimeType),
    createObjectURL: (source) => Url.createObjectURL(source),
    revokeObjectURL: (url) => Url.revokeObjectURL(url),
  }
}

/** Options for {@link MseEngine}. */
export interface MseEngineOptions {
  /**
   * The `fetch` for the session's requests: FXM Connect's page `fetch` (the platform transport) on
   * the web, the native one on desktop.
   */
  fetch: typeof globalThis.fetch
  /** Creates the audio element. Default: `document.createElement('audio')`. */
  createAudio?: () => HTMLAudioElement
  /** The media source. Default: {@link browserMediaSource}. */
  mediaSource?: MediaSourceHost
  /** Starts a session's feed; googlevideo's `SabrStream` by default. */
  startFeed?: SabrFeedStarter
  /** The clock, in epoch milliseconds, for stream expiry. Default `Date.now`. */
  now?: () => number
}

/** A loaded stream. */
interface Session {
  readonly source: PlaybackSource
  readonly playback: SabrPlayback
  readonly mediaSource: MediaSource
  readonly url: string
  sourceBuffer?: SourceBuffer
  feed?: SabrFeed
  /** The position to start at, until the first data is in. */
  startAtMs: number | undefined
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Why the engine cannot play `stream` at all, or `undefined` when it might. */
function unsupportedReason(stream: StreamOption): string | undefined {
  if (stream.protocol !== 'sabr') return `The MediaSource engine plays SABR, not ${stream.protocol}`
  if (stream.fullLength === 'capped') return 'The stream stops before the end'
  if (parseSabrPlayback(stream.playback) === undefined) return 'The stream carries no SABR session'
  return undefined
}

/** Plays SABR streams through `MediaSource`. See the module documentation. */
export class MseEngine implements Engine {
  readonly #audio: HTMLAudioElement
  readonly #host: MediaSourceHost | undefined
  readonly #fetch: typeof globalThis.fetch
  readonly #startFeed: SabrFeedStarter
  readonly #now: () => number
  readonly #listeners = new Map<EngineEventType, Set<(payload: never) => void>>()
  readonly #removers: Array<() => void> = []
  #session: Session | undefined
  #destroyed = false

  constructor(options: MseEngineOptions) {
    this.#audio = options.createAudio?.() ?? document.createElement('audio')
    this.#audio.removeAttribute('crossorigin')
    this.#host = options.mediaSource ?? browserMediaSource()
    this.#fetch = options.fetch
    this.#startFeed = options.startFeed ?? startSabrFeed
    this.#now = options.now ?? Date.now
    this.#listen()
  }

  canPlay(stream: StreamOption): PlaySupport {
    if (unsupportedReason(stream) !== undefined || this.#host === undefined) return 'no'
    if (stream.expiresAt !== undefined && stream.expiresAt <= this.#now()) return 'no'
    const playback = parseSabrPlayback(stream.playback)
    return playback !== undefined && this.#host.isTypeSupported(playback.audio.mimeType)
      ? 'probably'
      : 'no'
  }

  async load(source: PlaybackSource, startAtMs = 0): Promise<void> {
    if (this.#destroyed) return
    this.#teardown()
    const { stream } = source
    const reason =
      this.#host === undefined ? 'This platform has no MediaSource' : unsupportedReason(stream)
    const playback = parseSabrPlayback(stream.playback)
    if (reason !== undefined || playback === undefined || this.#host === undefined) {
      this.#later(new EngineError('unsupported', reason ?? 'The stream cannot play here'))
      return
    }
    if (stream.expiresAt !== undefined && stream.expiresAt <= this.#now()) {
      this.#later(new EngineError('expired', 'The SABR session has expired'))
      return
    }
    if (!this.#host.isTypeSupported(playback.audio.mimeType)) {
      this.#later(
        new EngineError('unsupported', `MediaSource does not take ${playback.audio.mimeType}`),
      )
      return
    }
    const mediaSource = this.#host.create()
    const url = this.#host.createObjectURL(mediaSource)
    const session: Session = {
      source,
      playback,
      mediaSource,
      url,
      startAtMs: startAtMs > 0 ? startAtMs : undefined,
    }
    this.#session = session
    mediaSource.addEventListener('sourceopen', () => void this.#open(session), { once: true })
    this.#audio.src = url
  }

  async play(): Promise<void> {
    if (this.#session === undefined) return
    try {
      await this.#audio.play()
    } catch (error) {
      const name = errorName(error)
      if (name === 'AbortError' || name === 'NotSupportedError') return
      this.#emit(
        'error',
        name === 'NotAllowedError'
          ? new EngineError(
              'autoplay-blocked',
              'The browser wants a user gesture before playback starts',
              { cause: error },
            )
          : new EngineError('network', `Playback did not start: ${messageOf(error)}`, {
              cause: error,
            }),
      )
    }
  }

  pause(): void {
    this.#audio.pause()
  }

  seek(positionMs: number): void {
    const session = this.#session
    if (session === undefined) return
    const seconds = Math.max(0, positionMs / 1000)
    const buffered = session.sourceBuffer?.buffered
    // Data removed to make room can only come back with a new session from the start.
    if (buffered !== undefined && buffered.length > 0 && seconds < buffered.start(0)) {
      const paused = this.#audio.paused
      void this.load(session.source, positionMs).then(() => {
        if (!paused) void this.play()
      })
      return
    }
    if (session.startAtMs !== undefined) session.startAtMs = seconds * 1000
    else this.#audio.currentTime = seconds
  }

  setVolume(volume: number): void {
    this.#audio.volume = Math.min(1, Math.max(0, volume))
  }

  setMuted(muted: boolean): void {
    this.#audio.muted = muted
  }

  unlock(): void {
    if (this.#session !== undefined) return
    const started = this.#audio.play()
    started?.then(() => this.#audio.pause()).catch(() => {})
  }

  on<K extends EngineEventType>(
    type: K,
    listener: (payload: EngineEventMap[K]) => void,
  ): () => void {
    let set = this.#listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(type, set)
    }
    set.add(listener as (payload: never) => void)
    return () => set?.delete(listener as (payload: never) => void)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#teardown()
    this.#destroyed = true
    for (const remove of this.#removers.splice(0)) remove()
    this.#listeners.clear()
  }

  #emit<K extends EngineEventType>(type: K, payload: EngineEventMap[K]): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      ;(listener as (value: EngineEventMap[K]) => void)(payload)
    }
  }

  /** Reports an error after the current call returns, as the element would. */
  #later(error: EngineError): void {
    queueMicrotask(() => {
      if (!this.#destroyed) this.#emit('error', error)
    })
  }

  #listen(): void {
    const audio = this.#audio
    const on = (type: string, handler: () => void) => {
      const guarded = () => {
        if (this.#session !== undefined && audio.src === this.#session.url) handler()
      }
      audio.addEventListener(type, guarded)
      this.#removers.push(() => audio.removeEventListener(type, guarded))
    }
    on('timeupdate', () => {
      if (this.#session?.startAtMs === undefined) this.#emit('timeupdate', audio.currentTime * 1000)
    })
    on('durationchange', () => {
      const { duration } = audio
      if (Number.isFinite(duration) && duration > 0) this.#emit('durationchange', duration * 1000)
    })
    on('playing', () => this.#emit('play', undefined))
    on('pause', () => {
      if (!audio.ended) this.#emit('pause', undefined)
    })
    on('ended', () => this.#emit('ended', undefined))
    on('waiting', () => this.#emit('waiting', undefined))
    on('canplay', () => this.#emit('canplay', undefined))
    on('stalled', () => {
      if (audio.readyState < HAVE_FUTURE_DATA) this.#emit('stalled', undefined)
    })
    on('error', () => {
      const code = audio.error?.code
      const type: EngineErrorType =
        code === MEDIA_ERR_DECODE
          ? 'decode'
          : code === MEDIA_ERR_SRC_NOT_SUPPORTED
            ? 'unsupported'
            : 'network'
      this.#emit(
        'error',
        new EngineError(type, `The audio element failed (${audio.error?.message ?? code})`),
      )
    })
  }

  #teardown(): void {
    const session = this.#session
    if (session === undefined) return
    this.#session = undefined
    session.feed?.abort()
    this.#host?.revokeObjectURL(session.url)
    this.#audio.pause()
    this.#audio.removeAttribute('src')
    this.#audio.load()
  }

  #current(session: Session): boolean {
    return this.#session === session && !this.#destroyed
  }

  /** Runs one source buffer operation and waits for it to finish. */
  #operate(session: Session, operation: (buffer: SourceBuffer) => void): Promise<void> {
    const buffer = session.sourceBuffer
    if (buffer === undefined) return Promise.reject(new Error('The source buffer is gone'))
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', failed)
        resolve()
      }
      const failed = () => {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', failed)
        reject(new Error('The source buffer refused the data'))
      }
      buffer.addEventListener('updateend', done)
      buffer.addEventListener('error', failed)
      try {
        operation(buffer)
      } catch (error) {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', failed)
        reject(error)
      }
    })
  }

  /** Waits for the playhead to move on, or a moment. */
  #playbackMoves(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.#audio.removeEventListener('timeupdate', done)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, FULL_BUFFER_WAIT_MS)
      this.#audio.addEventListener('timeupdate', done)
    })
  }

  async #append(session: Session, chunk: Uint8Array): Promise<void> {
    for (;;) {
      if (!this.#current(session)) return
      try {
        await this.#operate(session, (buffer) =>
          buffer.appendBuffer(chunk as Uint8Array<ArrayBuffer>),
        )
        break
      } catch (error) {
        if (errorName(error) !== 'QuotaExceededError') throw error
        const buffered = session.sourceBuffer?.buffered
        const start = buffered !== undefined && buffered.length > 0 ? buffered.start(0) : 0
        const keepFrom = this.#audio.currentTime - KEEP_BEHIND_SECONDS
        if (keepFrom > start + 1) {
          await this.#operate(session, (buffer) => buffer.remove(start, keepFrom))
        } else {
          await this.#playbackMoves()
        }
      }
    }
    if (session.startAtMs !== undefined && this.#current(session)) {
      this.#audio.currentTime = session.startAtMs / 1000
      session.startAtMs = undefined
    }
  }

  async #open(session: Session): Promise<void> {
    if (!this.#current(session)) return
    try {
      session.sourceBuffer = session.mediaSource.addSourceBuffer(session.playback.audio.mimeType)
      session.mediaSource.duration = session.playback.durationMs / 1000
      const feed = await this.#startFeed(session.playback, session.source.stream.url, this.#fetch)
      if (!this.#current(session)) {
        feed.abort()
        return
      }
      session.feed = feed
      const reader = feed.audio.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (!this.#current(session)) return
        if (done) break
        await this.#append(session, value)
      }
      if (this.#current(session) && session.mediaSource.readyState === 'open') {
        session.mediaSource.endOfStream()
      }
    } catch (error) {
      if (!this.#current(session)) return
      const expiresAt = session.source.stream.expiresAt
      const type: EngineErrorType =
        expiresAt !== undefined && expiresAt <= this.#now()
          ? 'expired'
          : /attestation|reload/iu.test(messageOf(error))
            ? 'unsupported'
            : 'network'
      this.#emit(
        'error',
        new EngineError(type, `The SABR session failed: ${messageOf(error)}`, { cause: error }),
      )
    }
  }
}
