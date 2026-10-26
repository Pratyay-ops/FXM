/**
 * Getting a plugin: only from an address or a file the user picks. FXM ships no plugins, keeps
 * no catalogue and knows no default address.
 *
 * - **From an address** ({@link downloadPlugin}): an `https://` URL of a manifest
 *   (`fxm-plugin.json`), whose `entry` is fetched from the same origin, or of a plugin file. The
 *   address must serve the file itself: redirects are not followed.
 * - **From a file** ({@link readPluginFile}): a plugin file, which holds the manifest and the code
 *   in one JSON document ({@link createPluginFile}):
 *
 *   ```json
 *   { "fxmPluginFile": 1, "manifest": { "fxmPlugin": 1, "id": "…", … }, "code": "fxm.register({…})" }
 *   ```
 *
 * Either way the manifest is checked ({@link parseManifest}), the code's SHA-256 must be the one
 * the manifest declares, and the plugin must run on this FXM version. Nothing is installed
 * here: the result is what the install dialog shows for the user to approve.
 *
 * @module
 */

import { APP_VERSION } from '@fxm/core'
import { codeText, verifyChecksum } from './checksum'
import { cleanText, isPluginError, PluginError } from './errors'
import {
  checkCompatible,
  hostOfUrl,
  MANIFEST_LIMITS,
  type PluginManifest,
  parseManifest,
} from './manifest'

/** The version of the plugin file format: its `fxmPluginFile`. */
export const PLUGIN_FILE_FORMAT = 1

/** Size limits of what is downloaded or read. */
export const PACKAGE_LIMITS = {
  /** A plugin's code, in bytes. */
  code: 1024 * 1024,
  /** A plugin file, in bytes. */
  file: 1024 * 1024 + 256 * 1024,
  /** A manifest, in bytes. */
  manifest: MANIFEST_LIMITS.bytes,
} as const

/** How long one download may take, in milliseconds. */
export const DOWNLOAD_TIMEOUT_MS = 30_000

/** Where a plugin came from. */
export type PluginOrigin =
  /** The address the user entered: a manifest's or a plugin file's. Updates come from there. */
  | { readonly kind: 'url'; readonly url: string }
  /** The name of the file the user picked. Updates come from a newer file. */
  | { readonly kind: 'file'; readonly name: string }

/** A plugin, checked and ready to show for approval. */
export interface PluginPackage {
  /** Its manifest. */
  readonly manifest: PluginManifest
  /** Its code, whose SHA-256 is the manifest's. */
  readonly code: string
  /** Where it came from. */
  readonly origin: PluginOrigin
}

/** A `fetch` for downloads: a plain `GET` of an `https://` URL. */
export type DownloadFetch = (
  url: string,
  init: { readonly method: 'GET'; readonly signal?: AbortSignal },
) => Promise<Response>

/** Options for {@link downloadPlugin} and {@link readPluginFile}. */
export interface PackageOptions {
  /** This FXM's version. Default: `APP_VERSION` of `@fxm/core`. */
  readonly appVersion?: string
  /** Cancels the download. */
  readonly signal?: AbortSignal
}

/** A plugin file's text for a manifest and its code. */
export function createPluginFile(manifest: PluginManifest | object, code: string): string {
  return `${JSON.stringify({ fxmPluginFile: PLUGIN_FILE_FORMAT, manifest, code }, null, 2)}\n`
}

/** Checks a manifest and its code, and that the plugin runs here. */
function checked(
  rawManifest: unknown,
  code: string | Uint8Array,
  origin: PluginOrigin,
  appVersion: string,
): PluginPackage {
  const manifest = parseManifest(rawManifest)
  const bytes = typeof code === 'string' ? new TextEncoder().encode(code) : code
  if (bytes.byteLength > PACKAGE_LIMITS.code) {
    throw new PluginError(
      'too-large',
      `The plugin code is larger than ${PACKAGE_LIMITS.code / 1024} KiB`,
    )
  }
  verifyChecksum(bytes, manifest.sha256)
  checkCompatible(manifest, appVersion)
  return { manifest, code: typeof code === 'string' ? code : codeText(code), origin }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new PluginError('invalid-file', `${what} is not JSON`, { cause: error })
  }
}

/** The manifest and code of a plugin file's JSON, or `undefined` when it is not one. */
function pluginFileParts(value: unknown): { manifest: unknown; code: string } | undefined {
  if (typeof value !== 'object' || value === null || !('fxmPluginFile' in value)) return undefined
  const file = value as { fxmPluginFile: unknown; manifest?: unknown; code?: unknown }
  if (file.fxmPluginFile !== PLUGIN_FILE_FORMAT) {
    throw new PluginError(
      'unsupported-api',
      `The plugin file is in format ${cleanText(String(file.fxmPluginFile), 20)}, which this FXM doesn't read`,
    )
  }
  if (typeof file.code !== 'string') {
    throw new PluginError('invalid-file', 'The plugin file has no code')
  }
  return { manifest: file.manifest, code: file.code }
}

/**
 * Reads a plugin file the user picked.
 *
 * @throws PluginError `too-large`, `invalid-file`, or whatever the checks find
 * (`invalid-manifest`, `checksum-mismatch`, `needs-newer-fxm`, …).
 */
export function readPluginFile(
  text: string,
  name: string,
  options: PackageOptions = {},
): PluginPackage {
  if (new TextEncoder().encode(text).byteLength > PACKAGE_LIMITS.file) {
    throw new PluginError(
      'too-large',
      `A plugin file may be at most ${Math.round(PACKAGE_LIMITS.file / 1024)} KiB`,
    )
  }
  const parts = pluginFileParts(parseJson(text, 'The file'))
  if (parts === undefined) {
    throw new PluginError(
      'invalid-file',
      'The file is not an FXM plugin file (a manifest alone needs its code: add the plugin from its address instead)',
    )
  }
  return checked(
    parts.manifest,
    parts.code,
    { kind: 'file', name: cleanText(name, 200) },
    options.appVersion ?? APP_VERSION,
  )
}

/**
 * The address a plugin is added from, as a URL, or `undefined` when it is not one FXM downloads
 * from: `https:` only, without credentials, on a public host name.
 */
export function pluginAddress(text: string): URL | undefined {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return undefined
  }
  return hostOfUrl(url) === undefined ? undefined : url
}

/** Reads a body up to `maxBytes`, or fails with `too-large`. */
async function readBytes(response: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new PluginError('too-large', `${what} is larger than ${Math.round(maxBytes / 1024)} KiB`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new PluginError(
        'too-large',
        `${what} is larger than ${Math.round(maxBytes / 1024)} KiB`,
      )
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** GETs `url` and reads its body, or fails with `download-failed` or `too-large`. */
async function download(
  fetch: DownloadFetch,
  url: URL,
  maxBytes: number,
  what: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(url.href, { method: 'GET', signal: controller.signal })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new PluginError('download-failed', `FXM couldn't download ${what} from ${url.host}`, {
        cause: error,
      })
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new PluginError(
        'download-failed',
        `${url.host} answered ${response.status} for ${what}`,
      )
    }
    try {
      return await readBytes(response, maxBytes, what)
    } catch (error) {
      if (isPluginError(error)) throw error
      if (signal?.aborted) throw signal.reason
      throw new PluginError('download-failed', `The download of ${what} broke off`, {
        cause: error,
      })
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** The hosts {@link downloadPlugin} contacts for an address: its own, only. */
export function downloadHosts(address: URL): string[] {
  const host = hostOfUrl(address)
  return host === undefined ? [] : [host]
}

/**
 * Downloads a plugin from an address the user entered: a manifest, whose code it then fetches
 * from the manifest's `entry` on the same origin, or a plugin file. Every request is a plain
 * `GET` through `fetch`, which the app gives: the platform's, with the address's host allowed for
 * the download (see {@link downloadHosts}).
 *
 * @throws PluginError `invalid-file` for an address FXM doesn't download from or a body that is
 * no plugin, `download-failed`, `too-large`, or whatever the checks find; the signal's reason
 * when it aborts.
 */
export async function downloadPlugin(
  address: string,
  fetch: DownloadFetch,
  options: PackageOptions = {},
): Promise<PluginPackage> {
  const url = pluginAddress(address)
  if (url === undefined) {
    throw new PluginError(
      'invalid-file',
      'Plugins come only from https:// addresses on public host names',
    )
  }
  const appVersion = options.appVersion ?? APP_VERSION
  const origin: PluginOrigin = { kind: 'url', url: url.href }
  const first = await download(fetch, url, PACKAGE_LIMITS.file, 'the plugin', options.signal)
  const value = parseJson(new TextDecoder().decode(first), 'The download')
  const parts = pluginFileParts(value)
  if (parts !== undefined) return checked(parts.manifest, parts.code, origin, appVersion)
  if (first.byteLength > PACKAGE_LIMITS.manifest) {
    throw new PluginError(
      'too-large',
      `A manifest may be at most ${Math.round(PACKAGE_LIMITS.manifest / 1024)} KiB`,
    )
  }
  // Check the manifest before fetching anything it names.
  const manifest = parseManifest(value)
  const entry = new URL(manifest.entry, url)
  if (entry.origin !== url.origin) {
    throw new PluginError(
      'invalid-manifest',
      `The manifest's entry must be on ${url.host}, where the manifest is`,
    )
  }
  const code = await download(fetch, entry, PACKAGE_LIMITS.code, 'its code', options.signal)
  return checked(value, code, origin, appVersion)
}
