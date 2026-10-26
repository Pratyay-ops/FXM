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
 *   desktop app, whose webview loads googlevideo without CORS (it reads bytes through Rust only:
 *   stage 7.6's `fxm-media:` scheme serves them readably, but the app doesn't play through it
 *   yet), nor in the Android app's WebView;
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
