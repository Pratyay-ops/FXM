/**
 * Stage 7.6's step of the live smoke test: the readable audio path. For each verified googlevideo
 * stream the resolve found, one per container, it plays the stream in a `crossorigin="anonymous"`
 * element from the shell's `fxm-media:` scheme (`src-tauri/src/media.rs`), through a Web Audio
 * graph, as the equalizer of stage 8.1 will:
 *
 * - the element must start, play a few seconds, then play to its end after a seek to just before
 *   it, which makes the element ask for a range far into the file;
 * - an `AnalyserNode` reads the samples Web Audio gets, and the graph ends in a gain of 0. Media
 *   that failed the CORS check doesn't play at all in a `crossorigin` element, and Web Audio
 *   reads opaque media as zeros. The element stays muted all the same: WebKit plays WebM past
 *   the graph (WebKit bug 276813), so its gain would silence nothing;
 * - for comparison, the stream's own googlevideo URL in a `crossorigin` element, which googlevideo
 *   should refuse for want of CORS headers, and in a plain element, as the app plays it today:
 *   how long it takes to start, and the duration the webview reads.
 *
 * Everything stays muted: the test runs unattended, often at night.
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'
import { isStreamUrl, readableStreamUrl } from '../bridge'
import type { ReadablePath } from './steps'

/** What one stream's check found. */
export interface ReadableRun {
  /** The stream, for the report: `Opus in WebM`. */
  readonly label: string
  /** How long the element took from its source to its first `playing` event, in milliseconds. */
  readonly startedMs: number
  /** How far it played from the start, in seconds, before the seek. */
  readonly playedS: number
  /** The media's duration, in seconds. */
  readonly durationS: number
  /** Whether it reached `ended` after the seek to just before its end. */
  readonly ended: boolean
  /** The largest sample Web Audio read, from 0 to 1. */
  readonly peak: number
  /** The audio context's state while it played: `running` unless the webview held it back. */
  readonly contextState: string
  /** What the stream's own URL did in a `crossorigin` element. */
  readonly direct: 'refused' | 'played' | 'no answer'
  /** The stream's own URL in a plain element: how long it took to start, in milliseconds. */
  readonly plainStartedMs?: number
  /** The duration the plain element read, in seconds. */
  readonly plainDurationS?: number
}

/** Plays one stream through the readable path and reports what happened. */
export type ReadableProbe = (stream: StreamOption) => Promise<ReadableRun>

/** A stream for the report: its codec and container, e.g. `Opus in WebM`. */
export function streamLabel(stream: Pick<StreamOption, 'codec' | 'container' | 'media'>): string {
  const codec = stream.codec === 'opus' ? 'Opus' : stream.codec.toUpperCase()
  const container = stream.container === 'webm' ? 'WebM' : stream.container.toUpperCase()
  return `${codec} in ${container}${stream.media === 'muxed-video' ? ' video' : ''}`
}

/**
 * The streams to check: verified googlevideo streams, the first of each container, audio before
 * muxed video. WebKit loads WebM without a `Range` (the whole file at once) and MP4 in ranges,
 * so both kinds of request get tried where the resolve probed both.
 */
export function readableCandidates(options: readonly StreamOption[]): StreamOption[] {
  const picked = new Map<string, StreamOption>()
  const ordered = [...options].sort(
    (a, b) => Number(a.media === 'muxed-video') - Number(b.media === 'muxed-video'),
  )
  for (const option of ordered) {
    const readable = option.protocol === 'progressive' && isStreamUrl(option.url)
    if (option.fullLength === 'verified' && readable && !picked.has(option.container)) {
      picked.set(option.container, option)
    }
  }
  return [...picked.values()]
}

/** Whether a run shows the readable path working: it started, played and ended. */
export function runPassed(run: ReadableRun, listenS: number): boolean {
  return run.playedS >= listenS && run.ended
}

/** One run, for the report. */
export function describeRun(run: ReadableRun): string {
  const samples =
    run.peak > 0
      ? `Web Audio read samples up to ${run.peak.toFixed(2)}`
      : 'Web Audio read only silence'
  const direct = {
    refused: 'its own URL in such an element: refused, as googlevideo sends no CORS headers',
    played: 'its own URL in such an element: played too',
    'no answer': 'its own URL in such an element: no answer',
  }[run.direct]
  const plain =
    run.plainStartedMs === undefined
      ? 'in a plain element it didn’t start'
      : `in a plain element it started ${Math.round(run.plainStartedMs)} ms after loading` +
        (run.plainDurationS === undefined ? '' : ` (${run.plainDurationS.toFixed(1)} s in all)`)
  return (
    `${run.label}: started ${Math.round(run.startedMs)} ms after loading, played ` +
    `${run.playedS.toFixed(1)} s, ${run.ended ? 'then its end' : 'but not its end'} after a seek ` +
    `(${run.durationS.toFixed(1)} s in all); ${samples} (context ${run.contextState}); ${direct}; ` +
    plain
  )
}

/**
 * The readable path's step: runs `probe` on each stream {@link readableCandidates} picks, one
 * after another. It fails when none can be checked, or when one didn't play from the scheme.
 */
export function readablePath(probe: ReadableProbe, listenS = LISTEN_S): ReadablePath {
  return {
    async check(options) {
      const candidates = readableCandidates(options)
      if (candidates.length === 0) throw new Error('no verified googlevideo stream to play')
      const runs: ReadableRun[] = []
      for (const stream of candidates) runs.push(await probe(stream))
      const detail = runs.map(describeRun).join('. ')
      if (!runs.every((run) => runPassed(run, listenS))) throw new Error(detail)
      return detail
    },
  }
}

/** How many seconds from the start each stream must play. */
export const LISTEN_S = 6

/** How close to its end the seek goes, in seconds. */
const END_LEAD_S = 4

/** How long the stream's own URL gets to answer. */
const DIRECT_TIMEOUT_MS = 15_000

/** Options for {@link webAudioProbe}. */
export interface WebAudioProbeOptions {
  /** How many seconds from the start to play. Default: {@link LISTEN_S}. */
  readonly listenS?: number
  /** How long each part (starting, playing, ending) may take. Default: 60 s. */
  readonly timeoutMs?: number
}

/** Resolves after `ms` milliseconds. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Stops an element and drops its source, which ends its download. */
function release(audio: HTMLAudioElement): void {
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
}

/**
 * The stream's own URL in a muted plain element, as the app plays it today: how long it takes to
 * start, and the duration the webview reads.
 */
async function plainStart(
  url: string,
): Promise<Pick<ReadableRun, 'plainStartedMs' | 'plainDurationS'>> {
  const audio = new Audio()
  audio.muted = true
  const loading = performance.now()
  try {
    return await new Promise((resolve) => {
      audio.addEventListener(
        'playing',
        () => {
          const plainStartedMs = performance.now() - loading
          resolve(
            Number.isFinite(audio.duration)
              ? { plainStartedMs, plainDurationS: audio.duration }
              : { plainStartedMs },
          )
        },
        { once: true },
      )
      audio.addEventListener('error', () => resolve({}), { once: true })
      setTimeout(() => resolve({}), DIRECT_TIMEOUT_MS)
      audio.src = url
      audio.play().catch(() => {})
    })
  } finally {
    release(audio)
  }
}

/** What the stream's own URL does in a muted `crossorigin` element. */
async function directOutcome(url: string): Promise<ReadableRun['direct']> {
  const audio = new Audio()
  audio.crossOrigin = 'anonymous'
  audio.muted = true
  try {
    return await new Promise<ReadableRun['direct']>((resolve) => {
      audio.addEventListener('playing', () => resolve('played'), { once: true })
      audio.addEventListener('error', () => resolve('refused'), { once: true })
      setTimeout(() => resolve('no answer'), DIRECT_TIMEOUT_MS)
      audio.src = url
      audio.play().catch(() => {})
    })
  } finally {
    release(audio)
  }
}

/** The page's probe, in the smoke build's hidden window (see the module documentation). */
export function webAudioProbe(options: WebAudioProbeOptions = {}): ReadableProbe {
  const listenS = options.listenS ?? LISTEN_S
  const timeoutMs = options.timeoutMs ?? 60_000
  return async (stream) => {
    const url = readableStreamUrl(stream)
    if (url === undefined) throw new Error('not a googlevideo stream')
    const direct = await directOutcome(stream.url)
    const plain = await plainStart(stream.url)
    const audio = new Audio()
    audio.crossOrigin = 'anonymous'
    audio.muted = true
    audio.preload = 'auto'
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    const silence = context.createGain()
    silence.gain.value = 0
    context.createMediaElementSource(audio).connect(analyser)
    analyser.connect(silence).connect(context.destination)
    const samples = new Float32Array(analyser.fftSize)
    let peak = 0
    let failure: string | undefined
    let ended = false
    audio.addEventListener('error', () => {
      failure = `media error ${audio.error?.code}: ${audio.error?.message ?? ''}`
    })
    audio.addEventListener('ended', () => {
      ended = true
    })
    const sample = () => {
      analyser.getFloatTimeDomainData(samples)
      for (const value of samples) peak = Math.max(peak, Math.abs(value))
    }
    /** Samples until `done` holds; throws on a media error or after the timeout. */
    const until = async (done: () => boolean, what: string) => {
      const deadline = performance.now() + timeoutMs
      while (!done()) {
        if (failure !== undefined) throw new Error(`${what}: ${failure}`)
        if (performance.now() > deadline) {
          throw new Error(`${what}: nothing after ${timeoutMs / 1000} s at ${audio.currentTime} s`)
        }
        sample()
        await sleep(200)
      }
    }
    try {
      await context.resume().catch(() => {})
      const loading = performance.now()
      let startedMs: number | undefined
      audio.addEventListener(
        'playing',
        () => {
          startedMs ??= performance.now() - loading
        },
        { once: true },
      )
      audio.src = url
      void audio.play().catch(() => {})
      await until(() => startedMs !== undefined, 'starting')
      await until(() => audio.currentTime >= listenS, 'playing')
      const playedS = audio.currentTime
      if (!Number.isFinite(audio.duration)) throw new Error('the element knows no duration')
      audio.currentTime = Math.max(listenS, audio.duration - END_LEAD_S)
      await until(() => ended, 'ending')
      return {
        label: streamLabel(stream),
        startedMs: startedMs ?? 0,
        playedS,
        durationS: audio.duration,
        ended,
        peak,
        contextState: context.state,
        direct,
        ...plain,
      }
    } finally {
      release(audio)
      await context.close().catch(() => {})
    }
  }
}
