/**
 * The desktop app's live smoke test: stage 7.2's "done when", run in a hidden window of a debug
 * build (`scripts/run.sh pnpm --filter @fxm/desktop smoke`, see the app's README). Every request
 * goes through the app's real native networking: `createPlatform()` and `createDesktopFetch()`
 * over Tauri's HTTP plugin.
 *
 * A step that needs a stage which hasn't merged yet throws {@link Pending}, and the report says
 * so instead of failing.
 *
 * @module
 */

import type { NetworkCapabilities, ProviderContext, StreamOption } from '@fxm/core'

/** How a step ended. */
export type StepStatus = 'passed' | 'failed' | 'pending'

/** One step of the report. */
export interface StepResult {
  /** What the step checks. */
  readonly name: string
  /** How it ended. */
  readonly status: StepStatus
  /** What it found, or why it failed or waits. */
  readonly detail: string
  /** How long it took, in milliseconds. */
  readonly ms: number
}

/** What the hidden window reports to the app, which prints it and exits. */
export interface SmokeReport {
  /** Whether no step failed. Pending steps don't count against it. */
  readonly ok: boolean
  /** Every step, in order. */
  readonly steps: readonly StepResult[]
}

/** Thrown by a step whose stage hasn't merged yet. */
export class Pending extends Error {
  override readonly name = 'Pending'
}

/**
 * Runs one step and records its result: `run` returns the step's value and a detail for the
 * report. Resolves with the value, or `undefined` when the step failed or waits.
 */
export type RunStep = <T>(name: string, run: () => Promise<[T, string]>) => Promise<T | undefined>

/** A YouTube Music song found by a search. */
export interface FoundSong {
  readonly videoId: string
  readonly title?: string
}

/**
 * The smoke test's touch-points with stages 1.3 (the YouTube Music provider) and 1.4 (the stream
 * resolver). See `youtube.ts`.
 */
export interface SmokeYouTube {
  /** A YouTube Music song search: the first song. */
  search(query: string, ctx: ProviderContext): Promise<FoundSong>
  /** The song's streams, VISIONOS first, each probed at the end of the file where it can be. */
  resolve(videoId: string, ctx: ProviderContext): Promise<StreamOption[]>
}

/** Plays a URL to its end, muted. */
export interface MediaPlayer {
  /** Resolves when the media element reaches `ended`, with the media's duration in seconds. */
  playToEnd(url: string, options: { readonly timeoutMs: number }): Promise<{ durationS: number }>
}

/** A short free track, played to its end to show `<audio>` works in a hidden window. */
export interface FreeTrack {
  /** Its URL on a host in the CSP's `media-src` and the http plugin's scope. */
  readonly url: string
  /** What it is, for the report. */
  readonly label: string
}

/** Options for {@link runSmoke}. */
export interface SmokeOptions {
  /** A provider context for one step, with the app's native `fetch`. */
  readonly context: () => ProviderContext
  /** The capabilities the platform detected. */
  readonly capabilities: NetworkCapabilities
  /** Stages 1.3 and 1.4, or what stands in for them. */
  readonly youtube: SmokeYouTube
  /** The media player. */
  readonly player: MediaPlayer
  /** What to search YouTube Music for. */
  readonly query: string
  /** The free track to probe and play. */
  readonly freeTrack: FreeTrack
  /** How long one track may take to play to its end. Default: 10 minutes. */
  readonly playTimeoutMs?: number
  /** The clock, in milliseconds. Default: `performance.now`. */
  readonly now?: () => number
  /** Called with each step's result as soon as it is known, for progress. */
  readonly onStep?: (result: StepResult) => void
  /** Steps to run after these, such as stage 7.3's playback steps (`playback-steps.ts`). */
  readonly extraSteps?: (step: RunStep) => Promise<void>
}

/** The service worker data of www.youtube.com, which carries a server-issued visitorData. */
export const SW_JS_DATA_URL = 'https://www.youtube.com/sw.js_data'

/**
 * Spotify's server time, which its anonymous token needs and which answers without a token: the
 * cheapest check that Spotify accepts the app's requests (its Origin and browser User-Agent).
 */
export const SPOTIFY_TIME_URL = 'https://open.spotify.com/api/server-time'

/** The size of the end-of-file probe: the last 64 KB, as stage 1.4's probe asks for. */
export const PROBE_BYTES = 65_536

/** `sw.js_data` starts with this guard before its JSON. */
const JSON_GUARD = ")]}'"

const DEFAULT_PLAY_TIMEOUT_MS = 10 * 60_000

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The stream that stage 7.2's done-when plays: one whose end-of-file probe passed. */
export function verifiedStream(options: readonly StreamOption[]): StreamOption | undefined {
  return options.find((option) => option.fullLength === 'verified')
}

/**
 * Runs the smoke test's steps in order. A step that needs an earlier step's result waits
 * (`pending`) when that one didn't pass.
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const now = options.now ?? (() => performance.now())
  const timeoutMs = options.playTimeoutMs ?? DEFAULT_PLAY_TIMEOUT_MS
  const steps: StepResult[] = []

  async function step<T>(name: string, run: () => Promise<[T, string]>): Promise<T | undefined> {
    const started = now()
    const record = (result: StepResult) => {
      steps.push(result)
      options.onStep?.(result)
    }
    try {
      const [value, detail] = await run()
      record({ name, status: 'passed', detail, ms: now() - started })
      return value
    } catch (error) {
      const status = error instanceof Pending ? 'pending' : 'failed'
      record({ name, status, detail: message(error), ms: now() - started })
      return undefined
    }
  }

  const waiting = (what: string) => async (): Promise<never> => {
    throw new Pending(`waits for ${what}`)
  }

  await step('native networking', async () => {
    const { youtube, mediaBytes, spotify } = options.capabilities
    if (youtube !== 'full' || !mediaBytes || spotify === 'unreachable') {
      throw new Error(`capabilities are ${JSON.stringify(options.capabilities)}`)
    }
    return [true, `youtube ${youtube}, media bytes, spotify ${spotify}`]
  })

  await step('server-issued visitorData is readable', async () => {
    const response = await options.context().fetch(SW_JS_DATA_URL)
    const text = await response.text()
    if (response.status !== 200 || !text.startsWith(JSON_GUARD)) {
      throw new Error(`sw.js_data answered ${response.status} with ${text.slice(0, 40)}`)
    }
    return [true, `sw.js_data: ${text.length} characters`]
  })

  await step('Spotify answers', async () => {
    const response = await options.context().fetch(SPOTIFY_TIME_URL)
    const body: unknown = await response.json().catch(() => undefined)
    const time = (body as { serverTime?: unknown } | undefined)?.serverTime
    if (response.status !== 200 || typeof time !== 'number') {
      throw new Error(`server-time answered ${response.status} with ${JSON.stringify(body)}`)
    }
    return [true, `server time ${new Date(time * 1000).toISOString()}`]
  })

  const song = await step('YouTube Music search', async () => {
    const found = await options.youtube.search(options.query, options.context())
    return [found, `${JSON.stringify(options.query)}: ${found.title ?? ''} (${found.videoId})`]
  })

  const stream = await step(
    'VISIONOS URL passes the end-of-file probe',
    song === undefined
      ? waiting('the search')
      : async () => {
          const found = await options.youtube.resolve(song.videoId, options.context())
          const verified = verifiedStream(found)
          if (verified === undefined) {
            const seen = found.map((option) => `${option.codec} ${option.fullLength}`)
            throw new Error(`no stream passed the probe: ${seen.join(', ') || 'none'}`)
          }
          return [verified, `${verified.codec} in ${verified.container}, ${verified.media}`]
        },
  )

  await step(
    'the track plays to the end',
    stream === undefined
      ? waiting('a verified stream')
      : async () => {
          const { durationS } = await options.player.playToEnd(stream.url, { timeoutMs })
          return [true, `${durationS.toFixed(1)} s`]
        },
  )

  const probed = await step(`${options.freeTrack.label}: end-of-file probe`, async () => {
    const response = await options.context().fetch(options.freeTrack.url, {
      headers: { Range: `bytes=-${PROBE_BYTES}` },
    })
    const bytes = (await response.arrayBuffer()).byteLength
    const range = response.headers.get('content-range') ?? ''
    if (response.status !== 206 || !/^bytes \d+-\d+\/\d+$/.test(range) || bytes > PROBE_BYTES) {
      throw new Error(`answered ${response.status}, ${range || 'no Content-Range'}, ${bytes} bytes`)
    }
    return [true, `206, ${range}, from ${new URL(response.url || options.freeTrack.url).host}`]
  })

  await step(
    `${options.freeTrack.label}: plays to the end`,
    probed === undefined
      ? waiting('the probe')
      : async () => {
          const { durationS } = await options.player.playToEnd(options.freeTrack.url, { timeoutMs })
          return [true, `${durationS.toFixed(1)} s`]
        },
  )

  await options.extraSteps?.(step)

  return { ok: steps.every((result) => result.status !== 'failed'), steps }
}
