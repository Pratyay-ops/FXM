/**
 * The readable audio path (stage 7.6): where the desktop app's `<audio>` elements load a
 * googlevideo stream so that Web Audio, and so the equalizer of stage 8.1, can read it.
 *
 * googlevideo sends no CORS headers to other sites, so the webview plays its URLs only as opaque
 * media, which Web Audio turns into silence. The shell serves the same stream under its own URI
 * scheme, `fxm-media:` (`src-tauri/src/media.rs`): Rust fetches the bytes, as it does for the
 * end-of-file probe, and answers with CORS headers for the app. So an element with
 * `crossorigin="anonymous"` that loads {@link readableMediaUrl}'s URL plays a stream Web Audio
 * may read:
 *
 * ```ts
 * const url = readableStreamUrl(stream) // undefined for anything but a googlevideo stream
 * audio.crossOrigin = 'anonymous'
 * audio.src = url ?? stream.url
 * context.createMediaElementSource(audio).connect(equalizer)
 * ```
 *
 * Only the main window may use the scheme, and only for googlevideo stream URLs
 * ({@link isStreamUrl}). The stream is still the one the player chose: its probe (stage 1.4),
 * expiry and recovery rules (stage 2.3) are those of `stream`, and googlevideo's status reaches
 * the element as it is, so a 403 still leads to a new resolution. Free sources need no such path:
 * Internet Archive and Jamendo send CORS headers themselves.
 *
 * On macOS, WebKit plays WebM (Opus) past the Web Audio graph (WebKit bug 276813), whatever the
 * URL: only MP4 (AAC) reaches it there. See the app's README, "The readable audio path".
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'

/** The shell's URI scheme: `fxm-media://localhost/…`, `http://fxm-media.localhost/…` on Windows. */
export const MEDIA_SCHEME = 'fxm-media'

/** The domain every googlevideo stream host is under. */
export const STREAM_DOMAIN = 'googlevideo.com'

/** The path of every googlevideo stream URL. */
export const STREAM_PATH = '/videoplayback'

/**
 * Builds the URL of a custom scheme for a path, as Tauri's `convertFileSrc(path, scheme)` does:
 * `<scheme>://localhost/<encoded path>`, or `http://<scheme>.localhost/<encoded path>` on Windows.
 */
export type ConvertFileSrc = (path: string, scheme: string) => string

/**
 * Tauri's own `convertFileSrc`, which knows how the running webview spells custom schemes, from
 * the script Tauri puts in the app's pages; `undefined` outside the desktop app. Read from the
 * page rather than imported from `@tauri-apps/api`, so a browser never downloads Tauri's
 * bindings (as in `shell.ts`).
 */
export function tauriConvertFileSrc(): ConvertFileSrc | undefined {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } })
    .__TAURI_INTERNALS__
  const convert = internals?.convertFileSrc
  return typeof convert === 'function'
    ? (path, scheme) => String(convert.call(internals, path, scheme))
    : undefined
}

/**
 * Whether `url` is a googlevideo stream URL the shell's scheme serves: HTTPS, a host under
 * {@link STREAM_DOMAIN}, the default port, no user name or password, the path
 * {@link STREAM_PATH}. The same rule as `is_stream_url` in Rust.
 */
export function isStreamUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  const host = parsed.hostname
  return (
    parsed.protocol === 'https:' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === STREAM_PATH &&
    host.endsWith(`.${STREAM_DOMAIN}`) &&
    host.length > STREAM_DOMAIN.length + 1
  )
}

/**
 * The URL under which the shell serves `url` readably, or `undefined` when it isn't a googlevideo
 * stream URL ({@link isStreamUrl}) or the page doesn't run in the desktop app. `convert` is
 * Tauri's `convertFileSrc` ({@link tauriConvertFileSrc}); tests pass their own.
 */
export function readableMediaUrl(
  url: string,
  convert: ConvertFileSrc | undefined = tauriConvertFileSrc(),
): string | undefined {
  return convert !== undefined && isStreamUrl(url) ? convert(url, MEDIA_SCHEME) : undefined
}

/**
 * The readable URL of a stream for a `crossorigin="anonymous"` element, or `undefined` when the
 * stream needs none or can't have one: anything but a progressive googlevideo stream, and
 * anything outside the desktop app.
 */
export function readableStreamUrl(
  stream: Pick<StreamOption, 'url' | 'protocol'>,
  convert: ConvertFileSrc | undefined = tauriConvertFileSrc(),
): string | undefined {
  return stream.protocol === 'progressive' ? readableMediaUrl(stream.url, convert) : undefined
}

/** Whether `url` is one of the shell's readable media URLs, in either form. */
export function isReadableMediaUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return false
  const ownForm = parsed.protocol === `${MEDIA_SCHEME}:` && parsed.hostname === 'localhost'
  const windowsForm =
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.hostname === `${MEDIA_SCHEME}.localhost`
  return ownForm || windowsForm
}
