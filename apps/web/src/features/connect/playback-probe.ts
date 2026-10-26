/**
 * Plays a stream URL in a media element for a few seconds and says whether it played: the
 * "play" half of the Diagnostics self-test.
 *
 * Neither the page nor the Lite sandbox can read googlevideo's responses, so, as the playback
 * policy does in Lite (docs/ARCHITECTURE.md §10), the media element's first request is the
 * probe: a media error, or a stall before the first `playing` event, counts as a failure. Capped
 * URLs fail within about 70–300 ms. Success needs a few seconds of real playback after
 * `playing`, not just the first bytes.
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'
import { wavTone } from './wav'

/** Why a probe failed. */
export type ProbeFailure =
  /** The element reported a media error: a refused request (403), or bytes it couldn't decode. */
  | 'media-error'
  /** The element stalled before playing, or stopped making progress while playing. */
  | 'stalled'
  /** Nothing played within the start timeout. */
  | 'timeout'
  /** The browser refused to start playback without a tap (autoplay rules). */
  | 'blocked'
  /** The probe was cancelled. */
  | 'aborted'

/** What a probe found. */
export type ProbeResult =
  | {
      readonly ok: true
      /** From setting the URL to the first `playing` event. */
      readonly startedAfterMs: number
      /** How much of the stream played. */
      readonly playedMs: number
    }
  | {
      readonly ok: false
      readonly reason: ProbeFailure
      /** When it failed, from setting the URL. */
      readonly afterMs: number
      /** How much had played by then (0 when nothing did). */
      readonly playedMs: number
      /** The media error's name, e.g. `MEDIA_ERR_SRC_NOT_SUPPORTED`. */
      readonly detail?: string
    }

/** Options for {@link PlaybackProbe.play}. */
export interface ProbeOptions {
  /** How long the first `playing` event may take, in ms. Default 15,000. */
  readonly startTimeoutMs?: number
  /** How much must play to pass, in ms. Default 3,000. */
  readonly playMs?: number
  /** Loudness from 0 to 1. Default 0.5. */
  readonly volume?: number
  /** Cancels the probe, which then fails with `aborted`. */
  readonly signal?: AbortSignal
}

/** Plays stream URLs to see whether they play. */
export interface PlaybackProbe {
  /**
   * Prepares the media element. Call it from the click that starts the self-test: browsers that
   * allow sound only after a tap then let this element play later, after the resolution.
   */
  prime(): void
  /** Whether the browser can decode the option's codec and container (`canPlayType`). */
  canPlay(option: Pick<StreamOption, 'codec' | 'container' | 'media'>): boolean
  /** Plays `url` until it has played long enough, failed or timed out, then pauses it. */
  play(url: string, options?: ProbeOptions): Promise<ProbeResult>
  /** Stops playback and releases the element. */
  dispose(): void
}

/** The parts of `HTMLMediaElement` the probe uses. */
export interface MediaElementLike extends EventTarget {
  src: string
  volume: number
  preload: string
  readonly currentTime: number
  readonly error: { readonly code: number } | null
  play(): Promise<void>
  pause(): void
  load(): void
  removeAttribute(name: string): void
  canPlayType(type: string): string
}

/** Timers, for tests. */
export interface ProbeClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: ProbeClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Options for {@link createPlaybackProbe}. */
export interface PlaybackProbeOptions {
  /** Creates the media element. Default: a new `Audio`. */
  readonly createElement?: () => MediaElementLike
  /** Timers. Default: the real ones. */
  readonly clock?: ProbeClock
  /** Makes a URL for the silent primer sound. Default: a `blob:` URL; none without `Blob`. */
  readonly primerUrl?: () => { readonly url: string; release(): void } | undefined
}

const MEDIA_ERRORS: Readonly<Record<number, string>> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
}

/** The MIME type `canPlayType` should answer for an option. */
export function mimeTypeOf(option: Pick<StreamOption, 'codec' | 'container' | 'media'>): string {
  const { codec, container, media } = option
  if (media === 'muxed-video' && container === 'mp4' && codec === 'aac') {
    // YouTube's itag 18: H.264 Baseline video with AAC-LC audio.
    return 'video/mp4; codecs="avc1.42001E, mp4a.40.2"'
  }
  switch (codec) {
    case 'opus':
      return container === 'ogg' ? 'audio/ogg; codecs="opus"' : 'audio/webm; codecs="opus"'
    case 'vorbis':
      return container === 'webm' ? 'audio/webm; codecs="vorbis"' : 'audio/ogg; codecs="vorbis"'
    case 'aac':
      return 'audio/mp4; codecs="mp4a.40.2"'
    case 'alac':
      return 'audio/mp4; codecs="alac"'
    case 'mp3':
      return 'audio/mpeg'
    case 'flac':
      return container === 'ogg' ? 'audio/ogg; codecs="flac"' : 'audio/flac'
    case 'pcm':
      return 'audio/wav'
  }
}

function defaultPrimerUrl(): { url: string; release(): void } | undefined {
  if (typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
  const url = URL.createObjectURL(new Blob([wavTone({ seconds: 0.05 })], { type: 'audio/wav' }))
  return { url, release: () => URL.revokeObjectURL(url) }
}

/** Creates a probe with one media element, made on first use. */
export function createPlaybackProbe(options: PlaybackProbeOptions = {}): PlaybackProbe {
  const createElement = options.createElement ?? (() => new Audio() as MediaElementLike)
  const clock = options.clock ?? systemClock
  const makePrimer = options.primerUrl ?? defaultPrimerUrl
  let element: MediaElementLike | undefined
  let primer: { url: string; release(): void } | undefined
  let stopCurrent: (() => void) | undefined

  function media(): MediaElementLike {
    if (element === undefined) {
      element = createElement()
      element.preload = 'auto'
    }
    return element
  }

  function release(target: MediaElementLike): void {
    target.pause()
    // Dropping the source stops the download that the element would otherwise keep going.
    target.removeAttribute('src')
    target.load()
  }

  return {
    prime() {
      const target = media()
      primer?.release()
      primer = makePrimer()
      if (primer === undefined) return
      target.src = primer.url
      target.volume = 0
      target.play().catch(() => {
        // Nothing to unlock, or the browser refused: play() says so again later.
      })
    },

    canPlay(option) {
      return media().canPlayType(mimeTypeOf(option)) !== ''
    },

    play(url, playOptions = {}) {
      const { startTimeoutMs = 15_000, playMs = 3_000, volume = 0.5, signal } = playOptions
      stopCurrent?.()
      const target = media()
      return new Promise<ProbeResult>((resolve) => {
        const startedAt = clock.now()
        let playingAt: number | undefined
        let playingFrom = 0
        let done = false
        const timers: unknown[] = []
        const played = () =>
          playingAt === undefined ? 0 : Math.max(0, (target.currentTime - playingFrom) * 1000)

        function finish(result: ProbeResult): void {
          if (done) return
          done = true
          for (const timer of timers) clock.clearTimeout(timer)
          target.removeEventListener('playing', onPlaying)
          target.removeEventListener('timeupdate', onTimeUpdate)
          target.removeEventListener('error', onError)
          target.removeEventListener('stalled', onStalled)
          target.removeEventListener('ended', onEnded)
          signal?.removeEventListener('abort', onAbort)
          if (stopCurrent === stop) stopCurrent = undefined
          release(target)
          resolve(result)
        }
        function fail(reason: ProbeFailure, detail?: string): void {
          finish({
            ok: false,
            reason,
            afterMs: clock.now() - startedAt,
            playedMs: played(),
            ...(detail === undefined ? {} : { detail }),
          })
        }
        function pass(): void {
          finish({
            ok: true,
            startedAfterMs: (playingAt ?? clock.now()) - startedAt,
            playedMs: played(),
          })
        }
        function onPlaying(): void {
          if (playingAt !== undefined) return
          playingAt = clock.now()
          playingFrom = target.currentTime
          // Playing but making no progress for this long counts as a stall.
          timers.push(clock.setTimeout(() => fail('stalled'), playMs + 10_000))
        }
        function onTimeUpdate(): void {
          if (playingAt !== undefined && played() >= playMs) pass()
        }
        function onError(): void {
          const code = target.error?.code
          fail('media-error', code === undefined ? undefined : (MEDIA_ERRORS[code] ?? `${code}`))
        }
        function onStalled(): void {
          if (playingAt === undefined) fail('stalled')
        }
        function onEnded(): void {
          // A file shorter than `playMs` that played to its end did play.
          if (playingAt === undefined) fail('media-error')
          else pass()
        }
        function onAbort(): void {
          fail('aborted')
        }
        function stop(): void {
          fail('aborted')
        }

        if (signal?.aborted) {
          fail('aborted')
          return
        }
        stopCurrent = stop
        target.addEventListener('playing', onPlaying)
        target.addEventListener('timeupdate', onTimeUpdate)
        target.addEventListener('error', onError)
        target.addEventListener('stalled', onStalled)
        target.addEventListener('ended', onEnded)
        signal?.addEventListener('abort', onAbort, { once: true })
        timers.push(
          clock.setTimeout(() => {
            if (playingAt === undefined) fail('timeout')
          }, startTimeoutMs),
        )
        target.volume = Math.max(0, Math.min(1, volume))
        target.src = url
        target.play().catch((error: unknown) => {
          if (done) return
          // Autoplay rules: the browser wants a tap. Other rejections (an aborted load, an
          // unsupported source) also fire `error`, which says more.
          if ((error as { name?: unknown } | null)?.name === 'NotAllowedError') fail('blocked')
        })
      })
    },

    dispose() {
      stopCurrent?.()
      primer?.release()
      primer = undefined
      if (element !== undefined) release(element)
      element = undefined
    },
  }
}
