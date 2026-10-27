/**
 * The "YouTube audio" check of Settings → Diagnostics: whether this page can read YouTube's
 * audio (googlevideo's bytes) through FXM Connect, which YouTube downloads and the equalizer
 * need.
 *
 * Playback doesn't tell: a media element plays googlevideo without CORS, so a song can play while
 * its bytes stay unreadable. That happens, for example, when googlevideo redirects to another of
 * its servers (`cms_redirect`): after a cross-origin redirect the browser sends `Origin: null`,
 * which an `Access-Control-Allow-Origin` naming FXM's origin doesn't match.
 *
 * The check reuses the stream URL the song self-test resolved, so it makes no YouTube API call,
 * and sends at most two small requests to googlevideo, each with a time limit
 * ({@link AUDIO_CHECK_TIMEOUT_MS}):
 *
 * 1. A CORS `GET` of the first kilobyte (`Range: bytes=0-1023`) with `redirect: 'manual'`. An
 *    answer the page can read is `readable`, or `http-error` for a status outside 200–299; an
 *    `opaqueredirect` answer means googlevideo redirected; a network error (a `TypeError`) means
 *    the answer couldn't be read. Asking with `redirect: 'manual'` first, rather than after a read
 *    failed, keeps the check to two requests: a redirect's answer has no body.
 * 2. After a redirect, the same request following it: `readable` (or `http-error`), else
 *    `redirected`. After a network error, a `no-cors` request: an opaque answer means the server
 *    answered and the browser kept it from the page (`refused`), another network error that
 *    nothing answered (`unreachable`). `Range` isn't allowed in `no-cors` requests, so this one
 *    stops as soon as the answer's headers arrive.
 *
 * Nothing here keeps or reports the URL: results carry googlevideo's host name only.
 *
 * @module
 */

import { compareVersions } from '@fxm/platform'
import type { ConnectionState } from './connection'
import { connectionTier, isDetecting } from './explain'

/** How long each request may take, headers and first bytes, in milliseconds. */
export const AUDIO_CHECK_TIMEOUT_MS = 10_000

/** The bytes the check asks for: the first kilobyte. */
export const AUDIO_CHECK_RANGE = 'bytes=0-1023'

/**
 * The first FXM Connect whose googlevideo rule also answers after a redirect to another
 * googlevideo server. Older ones are told to update when the audio is redirected or refused.
 */
export const CONNECT_REDIRECT_FIX_VERSION = '0.2.1'

/**
 * Why the check didn't run:
 *
 * - `app`: the desktop or Android app, which doesn't use FXM Connect;
 * - `no-connect`: a browser without FXM Connect (or with one FXM doesn't use);
 * - `lite`: the Lite tier, where no page can read YouTube audio;
 * - `no-stream`: the song self-test found no stream to check;
 * - `not-googlevideo`: the self-test's stream isn't on googlevideo (the development fakes).
 */
export type AudioCheckSkip = 'app' | 'no-connect' | 'lite' | 'no-stream' | 'not-googlevideo'

/** What the check found. `host` is googlevideo's host name, never the URL. */
export type AudioCheckResult =
  /** The page read the first bytes. `redirectedTo`: the host a redirect led to, when one did. */
  | { readonly kind: 'readable'; readonly host: string; readonly redirectedTo?: string }
  /** googlevideo redirected to another server, whose answer the page couldn't read. */
  | { readonly kind: 'redirected'; readonly host: string }
  /** The server answered, but the browser kept the answer from the page (CORS). */
  | { readonly kind: 'refused'; readonly host: string }
  /** Nothing answered: the request failed even without CORS. */
  | { readonly kind: 'unreachable'; readonly host: string }
  /** A readable answer with a status outside 200–299. */
  | { readonly kind: 'http-error'; readonly host: string; readonly status: number }
  /** A request took longer than `timeoutMs`. */
  | { readonly kind: 'timeout'; readonly host: string; readonly timeoutMs: number }
  /** The check didn't run. */
  | { readonly kind: 'not-tested'; readonly reason: AudioCheckSkip }
  /** The check was stopped. */
  | { readonly kind: 'cancelled' }

/** Options for {@link runAudioCheck}. */
export interface AudioCheckOptions {
  /** The stream URL the song self-test resolved. */
  readonly url: string
  /** The `fetch` to send with. Default: the page's. */
  readonly fetch?: typeof fetch
  /** How long each request may take, in ms. Default {@link AUDIO_CHECK_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Stops the check, which then ends `cancelled`. */
  readonly signal?: AbortSignal
}

/**
 * Whether the check can't run in this connection state, and why; `undefined` when it can (a
 * browser with FXM Connect, in the Full tier) or while detection hasn't decided yet (see
 * {@link audioCheckPending}).
 */
export function audioCheckSkip(
  state: Pick<ConnectionState, 'phase' | 'platform' | 'capabilities' | 'connect'>,
): AudioCheckSkip | undefined {
  if (state.platform !== 'web') return 'app'
  if (audioCheckPending(state)) return undefined
  const tier = connectionTier(state)
  if (tier === 'lite') return 'lite'
  if (tier === 'full' && state.connect?.state === 'present') return undefined
  return 'no-connect'
}

/** Whether detection still runs, so it isn't known yet whether the check can run. */
export function audioCheckPending(state: Pick<ConnectionState, 'phase' | 'connect'>): boolean {
  return isDetecting(state) || state.phase !== 'ready'
}

const GOOGLEVIDEO_HOST = /^(?:[a-z0-9-]{1,63}\.)+googlevideo\.com$/

/**
 * googlevideo's host name in `url`, such as `rr3---sn-abcd.googlevideo.com`, or `undefined` when
 * the URL isn't an `https:` googlevideo URL. Only the host name, so an IP address, a path or a
 * query string never comes out of it.
 */
export function googleVideoHost(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return undefined
    const host = parsed.hostname.toLowerCase()
    return GOOGLEVIDEO_HOST.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

/** A request outlasted its time limit. */
class TimedOut extends Error {
  override readonly name = 'TimedOut'
}

/** The check was stopped. */
class Cancelled extends Error {
  override readonly name = 'Cancelled'
}

/**
 * Runs `request` with its own abort signal, which fires when it takes longer than `timeoutMs` or
 * when `outer` fires, and always once it settled: that stops a body nobody reads. Rejects with
 * {@link TimedOut} or {@link Cancelled} in those cases, whether or not `request` heeds its signal.
 */
async function bounded<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<T> {
  if (outer?.aborted) throw new Cancelled()
  const controller = new AbortController()
  let stop: (error: Error) => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    stop = (error) => {
      reject(error)
      controller.abort(error)
    }
  })
  // Nobody may be listening by the time it settles.
  stopped.catch(() => {})
  const onAbort = () => stop(new Cancelled())
  outer?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => stop(new TimedOut()), timeoutMs)
  try {
    return await Promise.race([request(controller.signal), stopped])
  } catch (error) {
    if (outer?.aborted) throw new Cancelled()
    if (controller.signal.reason instanceof TimedOut) throw new TimedOut()
    throw error
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}

/** Waits for the first bytes of `response`'s body, then lets the rest go. */
async function firstBytes(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (reader === undefined) return
  try {
    await reader.read()
  } finally {
    reader.cancel().catch(() => {})
  }
}

type Settled =
  | { readonly kind: 'readable'; readonly redirectedTo?: string }
  | { readonly kind: 'http-error'; readonly status: number }
  | { readonly kind: 'unreachable' }

/** What a response the page can read says: readable once its first bytes arrive, or an error. */
async function settle(response: Response, host: string): Promise<Settled> {
  if (!response.ok) {
    response.body?.cancel().catch(() => {})
    return { kind: 'http-error', status: response.status }
  }
  try {
    await firstBytes(response)
  } catch {
    // The answer broke off before any audio arrived. (A time limit or a stop wins the race in
    // `bounded` before this is seen.)
    return { kind: 'unreachable' }
  }
  const finalHost = response.redirected ? googleVideoHost(response.url) : undefined
  return finalHost === undefined || finalHost === host
    ? { kind: 'readable' }
    : { kind: 'readable', redirectedTo: finalHost }
}

/** Runs the check on the self-test's stream URL. It never rejects. */
export async function runAudioCheck(options: AudioCheckOptions): Promise<AudioCheckResult> {
  const { url, signal } = options
  const send: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? AUDIO_CHECK_TIMEOUT_MS
  const host = googleVideoHost(url)
  if (host === undefined) return { kind: 'not-tested', reason: 'not-googlevideo' }

  // No cookies, and nothing from the HTTP cache: the answer must come from googlevideo now.
  const base: RequestInit = { method: 'GET', credentials: 'omit', cache: 'no-store' }
  const ranged: RequestInit = { ...base, mode: 'cors', headers: { Range: AUDIO_CHECK_RANGE } }
  const ended = (error: unknown): AudioCheckResult | undefined => {
    if (error instanceof Cancelled) return { kind: 'cancelled' }
    if (error instanceof TimedOut) return { kind: 'timeout', host, timeoutMs }
    return undefined
  }

  let redirected = false
  try {
    const first = await bounded(
      async (requestSignal) => {
        const response = await send(url, { ...ranged, redirect: 'manual', signal: requestSignal })
        if (response.type === 'opaqueredirect') return undefined
        return await settle(response, host)
      },
      timeoutMs,
      signal,
    )
    if (first !== undefined) return { ...first, host }
    redirected = true
  } catch (error) {
    const result = ended(error)
    if (result !== undefined) return result
  }

  if (redirected) {
    try {
      const followed = await bounded(
        async (requestSignal) =>
          settle(await send(url, { ...ranged, redirect: 'follow', signal: requestSignal }), host),
        timeoutMs,
        signal,
      )
      return { ...followed, host }
    } catch (error) {
      return ended(error) ?? { kind: 'redirected', host }
    }
  }

  // The answer couldn't be read: did the server answer at all?
  try {
    await bounded(
      async (requestSignal) => {
        await send(url, { ...base, mode: 'no-cors', signal: requestSignal })
      },
      timeoutMs,
      signal,
    )
    return { kind: 'refused', host }
  } catch (error) {
    return ended(error) ?? { kind: 'unreachable', host }
  }
}

/** Where the check stands on the page: not run yet, running, or done. */
export type AudioCheckState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'done'; readonly result: AudioCheckResult }

/**
 * What the page shows for the check: why it can't run here (`not-tested`), `waiting` (detection
 * still runs, or the self-test hasn't run yet), `checking`, or the result.
 */
export function shownAudioCheck(
  state: Pick<ConnectionState, 'phase' | 'platform' | 'capabilities' | 'connect'>,
  audio: AudioCheckState,
): AudioCheckResult | 'waiting' | 'checking' {
  const skip = audioCheckSkip(state)
  if (skip !== undefined) return { kind: 'not-tested', reason: skip }
  if (audioCheckPending(state) || audio.phase === 'idle') return 'waiting'
  return audio.phase === 'checking' ? 'checking' : audio.result
}

/** The stream a finished self-test ended on, whose URL the check reads. */
export function audioCheckUrl(
  attempts: readonly { readonly option: { readonly url: string } }[],
): string | undefined {
  return attempts.at(-1)?.option.url
}

/** A result in words, for the Diagnostics row and the copied report. */
export interface AudioCheckText {
  /** The outcome, e.g. "Refused (CORS)". */
  readonly title: string
  /** What it means, in one sentence. */
  readonly explanation: string
  /** What to do about it, when anything helps. */
  readonly advice?: string
  /** `good` for readable, `bad` for a failure, `neutral` when nothing was tested. */
  readonly tone: 'good' | 'bad' | 'neutral'
}

/** What to do when FXM Connect can't read the audio. */
export const UPDATE_CONNECT_ADVICE = 'Update FXM Connect to the latest version.'

/** What to say when updating FXM Connect wouldn't help. */
export const HARD_BLOCK_ADVICE =
  'This browser or network stops FXM Connect from reading YouTube audio.'

const BROKEN = "so YouTube downloads and the equalizer don't work"

const SKIPPED: Readonly<Record<AudioCheckSkip, string>> = {
  app: "This check is for FXM Connect in a browser, which the app doesn't need.",
  'no-connect':
    "Without FXM Connect, this browser can't read YouTube audio, so YouTube downloads and the equalizer aren't available here.",
  lite: "In Lite, YouTube songs play, but this browser can't read their audio, so YouTube downloads and the equalizer aren't available here.",
  'no-stream': 'The song self-test found no stream to check.',
  'not-googlevideo': "The song self-test's stream doesn't come from YouTube's audio servers.",
}

/** Whether FXM Connect `version` predates the redirect fix (an unreadable version counts too). */
function beforeRedirectFix(version: string | undefined): boolean {
  if (version === undefined) return true
  const comparison = compareVersions(version, CONNECT_REDIRECT_FIX_VERSION)
  return comparison === undefined || comparison < 0
}

/** What a redirected or refused read calls for: an update, or nothing FXM Connect can do. */
function blockedAdvice(connectVersion: string | undefined): string {
  return beforeRedirectFix(connectVersion) ? UPDATE_CONNECT_ADVICE : HARD_BLOCK_ADVICE
}

/**
 * A result in words. `connectVersion` is FXM Connect's version: one older than
 * {@link CONNECT_REDIRECT_FIX_VERSION} is told to update when the audio is redirected or refused.
 */
export function describeAudioCheck(
  result: AudioCheckResult,
  connectVersion: string | undefined,
): AudioCheckText {
  switch (result.kind) {
    case 'readable':
      return {
        title: 'Readable',
        explanation:
          result.redirectedTo === undefined
            ? 'FXM Connect can read YouTube audio here, so YouTube downloads and the equalizer work.'
            : 'FXM Connect can read YouTube audio here, also after YouTube sent the request on to another server, so YouTube downloads and the equalizer work.',
        tone: 'good',
      }
    case 'redirected':
      return {
        title: 'Redirected to another server and not readable',
        explanation: `YouTube sent the request on to another server, and the browser wouldn't let FXM Connect read the audio from there, ${BROKEN}.`,
        advice: blockedAdvice(connectVersion),
        tone: 'bad',
      }
    case 'refused':
      return {
        title: 'Refused (CORS)',
        explanation: `YouTube's audio server answered, but the browser wouldn't let FXM Connect read the audio, ${BROKEN}.`,
        advice: blockedAdvice(connectVersion),
        tone: 'bad',
      }
    case 'unreachable':
      return {
        title: 'Unreachable',
        explanation: `The browser couldn't get anything from YouTube's audio server on this page, ${BROKEN}.`,
        advice: HARD_BLOCK_ADVICE,
        tone: 'bad',
      }
    case 'http-error':
      return result.status >= 500
        ? {
            title: `HTTP error ${result.status}`,
            explanation: "YouTube's audio server had a problem with the request.",
            advice: 'Try again in a few minutes.',
            tone: 'bad',
          }
        : {
            title: `HTTP error ${result.status}`,
            explanation: "YouTube's audio server refused the request.",
            advice:
              'Run the self-test again. If the error stays, YouTube may be refusing audio to this network.',
            tone: 'bad',
          }
    case 'timeout':
      return {
        title: 'Timed out',
        explanation: `YouTube's audio server didn't answer within ${Math.round(result.timeoutMs / 1000)} s.`,
        advice: 'Check the connection and run the self-test again.',
        tone: 'bad',
      }
    case 'not-tested':
      return { title: 'Not tested', explanation: SKIPPED[result.reason], tone: 'neutral' }
    case 'cancelled':
      return { title: 'Stopped', explanation: 'The check was stopped.', tone: 'neutral' }
  }
}
