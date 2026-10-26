/**
 * Files on the device, in the Android app's WebView (stage 6.4): offline copies in the app's own
 * storage and the device's music. Capacitor's local server serves a device file at a URL of the
 * page's own origin (`convertFileSrc` in Capacitor's Android bridge):
 *
 * - `file:///path` at `<origin>/_capacitor_file_/path`;
 * - `content://authority/path` at `<origin>/_capacitor_content_/authority/path`.
 *
 * Streams of device files carry that URL, so the direct audio engine's `<audio>` element plays
 * them through the WebView, and the native engine hands Media3 the `file:` or `content:` URI
 * behind it ({@link deviceFileUri}), which it reads from the device itself.
 *
 * @module
 */

/** Where Capacitor's local server serves `file:` URIs. */
const FILE_PREFIX = '/_capacitor_file_'

/** Where Capacitor's local server serves `content:` URIs. */
const CONTENT_PREFIX = '/_capacitor_content_'

/** The page's origin, e.g. `https://localhost` in the Android app; `undefined` outside a page. */
export function pageOrigin(global: object = globalThis): string | undefined {
  const origin = (global as { location?: { origin?: unknown } }).location?.origin
  return typeof origin === 'string' && origin !== '' && origin !== 'null' ? origin : undefined
}

/** Whether `url` is a device file's own URI: `file:///…` or `content://…`. */
function isDeviceUri(url: string): boolean {
  return /^file:\/\/\/[^?#]+$/.test(url) || /^content:\/\/[^/?#]+\/[^?#]+$/.test(url)
}

/**
 * The URL the WebView serves the device file `uri` (`file:///…` or `content://…`) at, as
 * Capacitor's `convertFileSrc` makes it, for the page's `origin` (`null`: no page); `undefined`
 * for any other URI, or without an origin.
 */
export function webViewFileUrl(
  uri: string,
  origin: string | null = pageOrigin() ?? null,
): string | undefined {
  if (origin === null || !isDeviceUri(uri)) return undefined
  return uri.startsWith('file:')
    ? `${origin}${FILE_PREFIX}${uri.slice('file://'.length)}`
    : `${origin}${CONTENT_PREFIX}${uri.slice('content:/'.length)}`
}

/**
 * The device file `url` names: the `file:` or `content:` URI behind a WebView URL of the page's
 * own `origin` ({@link webViewFileUrl}), or such a URI itself; `undefined` for anything else,
 * e.g. a stream on the network.
 */
export function deviceFileUri(
  url: string,
  origin: string | null = pageOrigin() ?? null,
): string | undefined {
  if (isDeviceUri(url)) return url
  if (origin === null || !url.startsWith(`${origin}/`)) return undefined
  const path = url.slice(origin.length)
  let uri: string | undefined
  if (path.startsWith(`${FILE_PREFIX}/`)) uri = `file://${path.slice(FILE_PREFIX.length)}`
  else if (path.startsWith(`${CONTENT_PREFIX}/`))
    uri = `content:/${path.slice(CONTENT_PREFIX.length)}`
  return uri !== undefined && isDeviceUri(uri) ? uri : undefined
}
