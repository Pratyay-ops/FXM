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
 *   reads opaque media as zeros. Where the path should work, Web Audio must read samples, or the
 *   run fails: every stream on Windows, and MP4 on macOS, whose WebKit plays WebM past the graph
 *   (WebKit bug 276813), so silence from WebM is what it should read there. Where nobody has
 *   checked what to expect (WebKitGTK, so far), silence makes the run inconclusive
 *   ({@link runVerdict});
 * - for comparison, the stream's own googlevideo URL in a `crossorigin` element, which googlevideo
 *   should refuse for want of CORS headers, and in a plain element, as the app plays it today:
 *   how long it takes to start, and the duration the webview reads.
 *
 * Every stream is checked and reported before the step fails, so one that fails hides no other.
 *
 * Nothing is heard: the test runs unattended, often at night. The comparison elements are muted,
 * and so is the routed element, except on Windows ({@link samplePlan}): Chromium, and so WebView2,
 * scales what an element hands Web Audio by its volume, which is 0 while it is muted
 * (`HTMLMediaElement::EffectiveMediaVolume` and `WebAudioSourceProviderImpl::ProvideInput`, read
 * 2026-10-26), so Web Audio would read silence. A routed element is heard only through the graph,
 * whose gain is 0, so unmuted it stays silent. WebKit on macOS hands Web Audio a muted MP4
 * element's samples all the same (measured), and plays WebM past the graph, where only `muted`
 * keeps it silent.
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'
import { isStreamUrl, readableStreamUrl } from '../bridge'
import { Inconclusive, type ReadablePath } from './steps'

/** What Web Audio should read from a stream where the app runs ({@link samplePlan}). */
export type SampleExpectation = 'samples' | 'silence' | 'unknown'

/** How one stream's run went: see {@link runVerdict}. */
export type RunVerdict = 'passed' | 'failed' | 'inconclusive'

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
  /** What Web Audio should have read, where the app runs. */
  readonly expected: SampleExpectation
  /** Whether the routed element was muted. */
  readonly muted: boolean
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

/** How to play a stream where the app runs: what Web Audio should read, and whether to mute. */
export interface SamplePlan {
  readonly expected: SampleExpectation
  /** Whether the routed element stays muted (see the module documentation). */
  readonly muted: boolean
}

/**
 * How to play `stream` on `os` (`desktop_environment`'s `macos`, `windows` or `linux`):
 *
 * - Windows (WebView2): samples from every stream, from an unmuted element, since a muted one
 *   hands Web Audio silence;
 * - macOS (WebKit): samples from MP4, silence from WebM, which WebKit plays past the graph; muted;
 * - anything else, WebKitGTK included: unknown, and muted, since WebKitGTK might play WebM past
 *   the graph too, and nobody has checked whether it hands Web Audio a muted element's samples.
 */
export function samplePlan(
  os: string | undefined,
  stream: Pick<StreamOption, 'container'>,
): SamplePlan {
  if (os === 'windows') return { expected: 'samples', muted: false }
  if (os === 'macos')
    return { expected: stream.container === 'webm' ? 'silence' : 'samples', muted: true }
  return { expected: 'unknown', muted: true }
}

/**
 * Whether a run shows the readable path working. It fails unless the element played from the
 * scheme to its end. Then Web Audio's samples pass it, and so does silence where silence is what
 * it should read. Silence fails it where Web Audio should read samples, and leaves it
 * inconclusive where nobody knows, or where the audio context never ran.
 */
export function runVerdict(
  run: ReadableRun,
  listenS: number,
): { readonly verdict: RunVerdict; readonly why: string } {
  if (run.playedS < listenS || !run.ended) {
    return { verdict: 'failed', why: 'it didn’t play from the scheme to its end' }
  }
  if (run.peak > 0) return { verdict: 'passed', why: 'Web Audio read its samples' }
  if (run.contextState !== 'running') {
    return {
      verdict: 'inconclusive',
      why: `Web Audio heard nothing: its context was ${run.contextState}`,
    }
  }
  switch (run.expected) {
    case 'samples':
      return { verdict: 'failed', why: 'Web Audio read only silence where it should read samples' }
    case 'silence':
      return { verdict: 'passed', why: 'silence, as expected: WebKit plays WebM past Web Audio' }
    default:
      return {
        verdict: 'inconclusive',
        why: run.muted
          ? 'silence from a muted element, which this webview may hand Web Audio as silence'
          : 'silence, where nobody knows what to expect',
      }
  }
}

/** One run, for the report. */
export function describeRun(run: ReadableRun, listenS = LISTEN_S): string {
  const { verdict, why } = runVerdict(run, listenS)
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
    `${run.label}: ${verdict} (${why}): started ${Math.round(run.startedMs)} ms after loading, ` +
    `played ${run.playedS.toFixed(1)} s, ${run.ended ? 'then its end' : 'but not its end'} after a ` +
    `seek (${run.durationS.toFixed(1)} s in all); ${samples} (context ${run.contextState}, ` +
    `element ${run.muted ? 'muted' : 'unmuted'}); ${direct}; ${plain}`
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The readable path's step: runs `probe` on each stream {@link readableCandidates} picks, one
 * after another, and reports every one. It fails when none can be checked or one failed, and is
 * inconclusive when one was and none failed ({@link runVerdict}).
 */
export function readablePath(probe: ReadableProbe, listenS = LISTEN_S): ReadablePath {
  return {
    async check(options) {
      const candidates = readableCandidates(options)
      if (candidates.length === 0) throw new Error('no verified googlevideo stream to play')
      const verdicts: RunVerdict[] = []
      const details: string[] = []
      for (const stream of candidates) {
        try {
          const run = await probe(stream)
          verdicts.push(runVerdict(run, listenS).verdict)
          details.push(describeRun(run, listenS))
        } catch (error) {
          verdicts.push('failed')
          details.push(`${streamLabel(stream)}: failed (${message(error)})`)
        }
      }
      const detail = details.join('. ')
      if (verdicts.includes('failed')) throw new Error(detail)
      if (verdicts.includes('inconclusive')) throw new Inconclusive(detail)
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
  /**
   * The operating system the app runs on, as the shell reports it (`macos`, `windows` or
   * `linux`), which decides what to expect ({@link samplePlan}). Unknown without it.
   */
  readonly os?: () => Promise<string | undefined>
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
    const os = options.os === undefined ? undefined : await options.os().catch(() => undefined)
    const plan = samplePlan(os, stream)
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
    // Routed, the element is heard only through the graph and its gain of 0, so it may play
    // unmuted where muting would also silence what it hands Web Audio.
    audio.muted = plan.muted
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
        expected: plan.expected,
        muted: plan.muted,
        direct,
        ...plain,
      }
    } finally {
      audio.muted = true
      release(audio)
      await context.close().catch(() => {})
    }
  }
}
