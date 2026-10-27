/**
 * Which streams a page can read the bytes of through a media element, so the equalizer (Web
 * Audio) can process them: `crossorigin="anonymous"` media whose server sends CORS headers for
 * the page, and the page's own `blob:` and same-origin URLs. Everything else plays as an opaque
 * resource, which Web Audio would turn into silence.
 *
 * @module
 */

import type { NetworkCapabilities, Platform, StreamOption } from '@fxm/core'

/** Where the app runs, as {@link isMediaReadable} needs to know it. */
export interface MediaReadabilityContext {
  /** The app FXM runs in. */
  readonly platform: Platform
  /** What the platform reaches; `mediaBytes` says whether FXM Connect reads googlevideo. */
  readonly capabilities: Pick<NetworkCapabilities, 'mediaBytes'>
}

/** The page's own origin, or `undefined` outside a page. */
function pageOrigin(): string | undefined {
  try {
    return globalThis.location?.origin
  } catch {
    return undefined
  }
}

/**
 * Whether the page reads `url` like its own: a `blob:` or `data:` URL (local files, downloads),
 * or a URL of the page's origin. The direct audio engine's default rule.
 */
export function isLocalMediaUrl(url: string, origin = pageOrigin()): boolean {
  if (url.startsWith('blob:') || url.startsWith('data:')) return true
  if (origin === undefined || origin === 'null') return false
  try {
    return new URL(url, origin).origin === origin
  } catch {
    return false
  }
}

/**
 * Hosts whose media FXM measured to come with CORS headers any page can use (2026-10-25, see the
 * sources' READMEs): Internet Archive's download and storage hosts (`Access-Control-Allow-Origin:
 * *`) and Jamendo's audio storage (the request's origin echoed).
 */
function corsMediaHost(host: string): boolean {
  return (
    host === 'archive.org' ||
    host.endsWith('.archive.org') ||
    host === 'storage.jamendo.com' ||
    host.endsWith('.storage.jamendo.com')
  )
}

/**
 * Whether the page can read the bytes of `stream` through a `crossorigin` media element:
 *
 * - its own `blob:`, `data:` and same-origin URLs, on every platform;
 * - Internet Archive and Jamendo, which send CORS headers to any page;
 * - googlevideo only in a browser with FXM Connect (`platform` `web` with `mediaBytes`), whose
 *   rules add CORS for the FXM origin. Not in the Lite tier or without FXM Connect, and not in the
 *   desktop app, whose webview loads googlevideo without CORS (it reads bytes through Rust only,
 *   until stage 7.6 gives the equalizer a readable path), nor in the Android app's WebView;
 * - nothing else: an unknown host (a plugin's, a user's Invidious instance) is assumed opaque.
 */
export function isMediaReadable(
  stream: Pick<StreamOption, 'url'>,
  context: MediaReadabilityContext,
  origin = pageOrigin(),
): boolean {
  const { url } = stream
  if (isLocalMediaUrl(url, origin)) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  if (host.endsWith('.googlevideo.com')) {
    return context.platform === 'web' && context.capabilities.mediaBytes
  }
  return corsMediaHost(host)
}

/**
 * What {@link checkMediaRead} found about reading a stream's bytes through CORS:
 *
 * - `readable`: the bytes came (whatever the HTTP status: a 403 is the URL's problem, not the
 *   browser's);
 * - `redirected`: the server redirected the request, and the browser refused to read the answer
 *   after the redirect. On googlevideo that is a cross-host redirect (`cms_redirect=yes`) with an
 *   FXM Connect older than 0.2.1, whose header doesn't match the `Origin: null` the browser sends
 *   after it;
 * - `refused`: the browser refused the read itself: the answer carried no CORS header for the page
 *   (FXM Connect's rules didn't apply to it), or the request failed outright;
 * - `timed-out`: no answer within the time allowed;
 * - `failed`: the request couldn't be sent at all (for example the platform has no route there).
 */
export type MediaReadVerdict = 'readable' | 'redirected' | 'refused' | 'timed-out' | 'failed'

/** The result of {@link checkMediaRead}. */
export interface MediaReadCheck {
  readonly verdict: MediaReadVerdict
  /** The HTTP status, when the bytes came. */
  readonly status?: number
}

/** Options for {@link checkMediaRead}. */
export interface MediaReadOptions {
  /** The page's (or platform's) `fetch`. */
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>
  /** Cancels the check; it then rejects with the signal's reason. */
  readonly signal?: AbortSignal
  /** How long each request may take, in milliseconds. Default: 10 s. */
  readonly timeoutMs?: number
}

/** The default for {@link MediaReadOptions.timeoutMs}. */
export const MEDIA_READ_TIMEOUT_MS = 10_000

/**
 * Finds out whether the page can read the bytes at `url` through CORS, and if not, why, with at
 * most two one-byte ranged GETs (`Range: bytes=0-0`, CORS-safelisted, so no preflight), without
 * credentials or the HTTP cache:
 *
 * 1. the request as a download sends it, following redirects: an answer means `readable`;
 * 2. when the browser refused that one, the same request with `redirect: 'manual'`: an
 *    `opaqueredirect` answer means the first answer was a redirect whose own CORS check passed,
 *    so the read failed after it (`redirected`); another refusal means `refused`.
 *
 * It never throws, except to pass on the caller's cancellation (`signal`).
 */
export async function checkMediaRead(
  url: string,
  options: MediaReadOptions,
): Promise<MediaReadCheck> {
  const timeoutMs = options.timeoutMs ?? MEDIA_READ_TIMEOUT_MS
  const attempt = async (
    redirect: RequestRedirect,
  ): Promise<Response | 'refused' | 'timed-out' | 'failed'> => {
    const done = new AbortController()
    const signals = [done.signal, AbortSignal.timeout(timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)
    try {
      const response = await options.fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect,
        signal: AbortSignal.any(signals),
      })
      await response.body?.cancel().catch(() => {})
      return response
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason
      if (error instanceof Error && error.name === 'TimeoutError') return 'timed-out'
      // A refused CORS read, like any network failure, rejects with a plain TypeError.
      return error instanceof TypeError ? 'refused' : 'failed'
    } finally {
      done.abort()
    }
  }
  const followed = await attempt('follow')
  if (typeof followed !== 'string') return { verdict: 'readable', status: followed.status }
  if (followed !== 'refused') return { verdict: followed }
  const manual = await attempt('manual')
  if (typeof manual === 'string') return { verdict: manual === 'refused' ? 'refused' : manual }
  if (manual.type === 'opaqueredirect') return { verdict: 'redirected' }
  // The second try read it: a redirect that happens only sometimes, or a passing failure.
  return { verdict: 'readable', status: manual.status }
}
