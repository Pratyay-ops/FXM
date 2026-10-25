/**
 * Stand-ins for the MediaSource engine's tests, which run in Node: an audio element, a media
 * source with its source buffer, and a SABR feed the test controls. Nothing plays or decodes;
 * the fakes only keep the state and fire the events the engine reads.
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'
import type { SabrFeedStarter } from './sabr-feed'
import { SABR_PLAYBACK_FORMAT, type SabrPlayback } from './sabr-playback'

/** `TimeRanges` over a list of `[start, end]` pairs, in seconds. */
export class FakeTimeRanges {
  constructor(public ranges: Array<[number, number]> = []) {}

  get length(): number {
    return this.ranges.length
  }

  start(index: number): number {
    const range = this.ranges[index]
    if (range === undefined) throw new RangeError('No such range')
    return range[0]
  }

  end(index: number): number {
    const range = this.ranges[index]
    if (range === undefined) throw new RangeError('No such range')
    return range[1]
  }
}

/**
 * A source buffer: each appended byte stands for `secondsPerByte` of audio, appended after the
 * last range; appends past `quotaSeconds` of buffered audio throw `QuotaExceededError`.
 */
export class FakeSourceBuffer extends EventTarget {
  updating = false
  readonly appended: Uint8Array[] = []
  readonly removed: Array<[number, number]> = []
  readonly buffered = new FakeTimeRanges()
  secondsPerByte = 1
  quotaSeconds = Number.POSITIVE_INFINITY

  #finish(): void {
    this.updating = true
    queueMicrotask(() => {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    })
  }

  #bufferedSeconds(): number {
    return this.buffered.ranges.reduce((sum, [start, end]) => sum + end - start, 0)
  }

  appendBuffer(data: Uint8Array): void {
    const seconds = data.byteLength * this.secondsPerByte
    if (this.#bufferedSeconds() + seconds > this.quotaSeconds) {
      throw new DOMException('The source buffer is full', 'QuotaExceededError')
    }
    this.appended.push(data)
    const last = this.buffered.ranges.at(-1)
    if (last === undefined) this.buffered.ranges.push([0, seconds])
    else last[1] += seconds
    this.#finish()
  }

  remove(start: number, end: number): void {
    this.removed.push([start, end])
    this.buffered.ranges = this.buffered.ranges
      .map(([from, to]): [number, number] => [Math.max(from, end), to])
      .filter(([from, to]) => to > from)
    this.#finish()
  }
}

/** A media source; {@link open} fires `sourceopen`, as attaching it to an element does. */
export class FakeMediaSource extends EventTarget {
  readyState: 'closed' | 'open' | 'ended' = 'closed'
  duration = Number.NaN
  mimeType: string | undefined
  readonly sourceBuffers: FakeSourceBuffer[] = []

  addSourceBuffer(mimeType: string): FakeSourceBuffer {
    this.mimeType = mimeType
    const buffer = new FakeSourceBuffer()
    this.sourceBuffers.push(buffer)
    return buffer
  }

  endOfStream(): void {
    this.readyState = 'ended'
  }

  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('sourceopen'))
  }
}

/** A media source host that creates {@link FakeMediaSource}s and records object URLs. */
export function fakeMediaSourceHost(
  supported: readonly string[] = ['audio/webm; codecs="opus"', 'audio/mp4; codecs="mp4a.40.2"'],
) {
  const created: FakeMediaSource[] = []
  const revoked: string[] = []
  return {
    created,
    revoked,
    host: {
      create: () => {
        const source = new FakeMediaSource()
        created.push(source)
        return source as unknown as MediaSource
      },
      isTypeSupported: (mimeType: string) => supported.includes(mimeType),
      createObjectURL: (source: MediaSource) =>
        `blob:https://fxm.test/${created.indexOf(source as unknown as FakeMediaSource)}`,
      revokeObjectURL: (url: string) => {
        revoked.push(url)
      },
    },
  }
}

/** An audio element with the state and events the engine uses. */
export class FakeAudio extends EventTarget {
  src = ''
  currentTime = 0
  duration = Number.NaN
  paused = true
  ended = false
  readyState = 0
  volume = 1
  muted = false
  error: { code: number; message: string } | null = null
  /** When set, `play()` rejects with it. */
  refusePlay: Error | undefined

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }

  load(): void {}

  play(): Promise<void> {
    if (this.refusePlay !== undefined) return Promise.reject(this.refusePlay)
    this.paused = false
    this.fire('playing')
    return Promise.resolve()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.fire('pause')
  }

  /** Fires `type` on the element. */
  fire(type: string): void {
    this.dispatchEvent(new Event(type))
  }
}

/** A SABR feed the test pushes chunks into. */
export function fakeFeed() {
  const starts: Array<{ playback: SabrPlayback; url: string; fetch: typeof fetch }> = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let aborted = 0
  let refuse: Error | undefined
  const start: SabrFeedStarter = async (playback, url, fetch) => {
    if (refuse !== undefined) throw refuse
    starts.push({ playback, url, fetch })
    const audio = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
      },
    })
    return {
      audio,
      abort: () => {
        aborted += 1
      },
    }
  }
  return {
    start,
    starts,
    get aborted() {
      return aborted
    },
    /** Makes the next start fail with `error`. */
    refuseWith(error: Error) {
      refuse = error
    },
    push(...sizes: number[]) {
      for (const size of sizes) controller?.enqueue(new Uint8Array(size))
    },
    close() {
      controller?.close()
    },
    fail(error: Error) {
      controller?.error(error)
    },
  }
}

/** A SABR session as `@fxm/sources` describes one. */
export const SESSION: SabrPlayback = {
  format: SABR_PLAYBACK_FORMAT,
  videoId: 'zFYEYRcjK2g',
  ustreamerConfig: 'CgdmeG1maXh0',
  poToken: 'ZnhtLXRva2Vu',
  client: { nameId: 1, version: '2.20261023.01.00' },
  durationMs: 239_000,
  audio: {
    itag: 251,
    lastModified: '1790437330874792',
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 141_000,
    averageBitrate: 130_000,
    approxDurationMs: 238_661,
  },
  video: {
    itag: 278,
    lastModified: '1790437330000000',
    mimeType: 'video/webm; codecs="vp9"',
    bitrate: 80_000,
    approxDurationMs: 238_661,
    width: 256,
    height: 144,
  },
}

/** A SABR stream option carrying {@link SESSION}. */
export function sabrStream(extra: Partial<StreamOption> = {}): StreamOption {
  return {
    url: 'https://rr1---sn-fxm.googlevideo.com/videoplayback?sabr=1&expire=1792985798',
    codec: 'opus',
    container: 'webm',
    media: 'audio',
    bitrateKbps: 130,
    tier: 'high',
    protocol: 'sabr',
    ipBound: true,
    fullLength: 'unverified',
    playback: SESSION,
    ...extra,
  }
}
