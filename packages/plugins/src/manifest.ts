/**
 * The plugin manifest (`fxm-plugin.json`): who a plugin is, which version, what it adds, the
 * hosts it may contact, where its code is and the SHA-256 of that code, and the oldest FXM that
 * runs it. {@link parseManifest} checks every field of an untrusted manifest and fails closed.
 *
 * ```json
 * {
 *   "fxmPlugin": 1,
 *   "id": "example-radio",
 *   "name": "Example Radio",
 *   "version": "1.2.0",
 *   "minFxmVersion": "0.1.0",
 *   "hosts": ["api.example.org"],
 *   "entry": "plugin.js",
 *   "sha256": "<64 hexadecimal digits>",
 *   "provides": ["search", "album", "resolve"]
 * }
 * ```
 *
 * @module
 */

import { isPluginSourceId, type PluginSourceId } from '@fxm/core'
import { cleanText, PluginError } from './errors'

/** The version of the plugin API this FXM speaks: the manifest's `fxmPlugin`. */
export const PLUGIN_API_VERSION = 1

/** Every {@link PluginOperation}, in the order FXM lists them. */
export const PLUGIN_OPERATIONS = [
  'search',
  'suggest',
  'track',
  'album',
  'artist',
  'playlist',
  'radio',
  'match',
  'resolve',
] as const

/**
 * What a plugin can do, each one handler of its code:
 *
 * - `search`: search its catalog (a source). Every other metadata operation needs it
 * - `suggest`: complete a partial query
 * - `track`, `album`, `artist`, `playlist`: load one entity of its catalog
 * - `radio`: tracks to play after a track or an artist
 * - `match`: find its audio for a track from any source (a resolver). It needs `resolve`
 * - `resolve`: turn one of its audio candidates into stream URLs
 */
export type PluginOperation = (typeof PLUGIN_OPERATIONS)[number]

/** The operations that make a plugin a source of metadata, all of which need `search`. */
export const METADATA_OPERATIONS: readonly PluginOperation[] = [
  'search',
  'suggest',
  'track',
  'album',
  'artist',
  'playlist',
  'radio',
]

/** Size and count limits of a manifest. */
export const MANIFEST_LIMITS = {
  /** The manifest file, in bytes. */
  bytes: 64 * 1024,
  /** Declared hosts. */
  hosts: 16,
  /** The plugin's display name, in characters. */
  name: 60,
  /** Its description. */
  description: 500,
  /** Its author. */
  author: 100,
  /** Its licence. */
  license: 64,
  /** The entry's path. */
  entry: 256,
  /** URLs, such as the home page. */
  url: 2048,
  /** The most requests an hour a manifest may ask for. */
  maxRequestsPerHour: 600,
  /** The requests an hour of a manifest that names none. */
  defaultRequestsPerHour: 120,
} as const

/** A plugin's manifest, as {@link parseManifest} accepts it. */
export interface PluginManifest {
  /** The plugin API version it was written for: {@link PLUGIN_API_VERSION}. */
  readonly fxmPlugin: typeof PLUGIN_API_VERSION
  /**
   * Its name in IDs, like a DNS label: 1 to 63 lower-case ASCII letters, digits and hyphens,
   * neither starting nor ending with a hyphen. Its source is `plugin.<id>` (see `@fxm/core`).
   */
  readonly id: string
  /** Its name for people. */
  readonly name: string
  /** Its version, `major.minor.patch`. An update must have a higher one. */
  readonly version: string
  /** What it does, in a sentence or two. */
  readonly description?: string
  /** Who wrote it. */
  readonly author?: string
  /** Its home page, an HTTPS URL. */
  readonly homepage?: string
  /** Its licence, e.g. an SPDX identifier. */
  readonly license?: string
  /** The oldest FXM version it runs on, `major.minor.patch`. */
  readonly minFxmVersion: string
  /**
   * The only hosts it may contact (and the only hosts of the URLs it hands FXM, such as stream
   * and artwork URLs), each `host` or `host:port`, in lower case, with the default port 443 left
   * out. Over HTTPS only.
   */
  readonly hosts: readonly string[]
  /** Where its code is, relative to the manifest's URL. */
  readonly entry: string
  /** The SHA-256 of its code (the entry's bytes), in lower-case hexadecimal. */
  readonly sha256: string
  /** What it does, in the order of {@link PLUGIN_OPERATIONS}. */
  readonly provides: readonly PluginOperation[]
  /** The most network requests an hour it makes, at most {@link MANIFEST_LIMITS}'s 600. */
  readonly requestsPerHour: number
}

/** A plugin's source ID: `plugin.<id>`. */
export function pluginSourceId(id: string): PluginSourceId {
  return `plugin.${id}`
}

/** Whether `id` is a well-formed plugin ID (see {@link PluginManifest.id}). */
export function isPluginId(id: unknown): id is string {
  return typeof id === 'string' && isPluginSourceId(pluginSourceId(id))
}

/** `major.minor.patch`, each part a whole number without leading zeros. */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u

/** The parts of a version, or `undefined` when it is not `major.minor.patch`. */
export function parseVersion(value: unknown): readonly [number, number, number] | undefined {
  if (typeof value !== 'string') return undefined
  const match = VERSION.exec(value)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Orders two versions: negative when `a` is lower than `b`, positive when higher, 0 when equal.
 *
 * @throws RangeError when either is not `major.minor.patch`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) {
    throw new RangeError(`Not a version: ${left === undefined ? a : b}`)
  }
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

/** One label of a host name. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

/**
 * Names that point into the user's own network or device, which no plugin may declare: a plugin
 * runs for the user, so it must not reach their router or printer.
 */
const LOCAL_NAMES = ['localhost', 'local', 'internal', 'lan', 'home', 'corp', 'intranet', 'private']

/**
 * A declared host in its one spelling (`host` or `host:port`, lower case, without the default
 * port 443), or `undefined` when it is not one a plugin may declare: an IP address, a single
 * label, a name in the user's own network (`localhost`, `.local`, `.home.arpa` and the like), a
 * wildcard, Unicode (use the `xn--` form, so lookalike letters can't hide a host) or a port
 * outside 1–65535.
 */
export function normalizeHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  const colon = text.lastIndexOf(':')
  const name = colon === -1 ? text : text.slice(0, colon)
  const portText = colon === -1 ? undefined : text.slice(colon + 1)
  let port: number | undefined
  if (portText !== undefined) {
    if (!/^[1-9]\d{0,4}$/u.test(portText)) return undefined
    port = Number(portText)
    if (port > 65_535) return undefined
  }
  if (name.length === 0 || name.length > 253) return undefined
  const labels = name.split('.')
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined
  const top = labels.at(-1) ?? ''
  // An all-digit top label is an IPv4 address or not a name at all.
  if (/^\d+$/u.test(top)) return undefined
  if (LOCAL_NAMES.includes(top) || name.endsWith('.home.arpa')) return undefined
  return port === undefined || port === 443 ? name : `${name}:${port}`
}

/** The host of an `https:` URL in a manifest's spelling, or `undefined` for any other URL. */
export function hostOfUrl(url: URL): string | undefined {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
  return normalizeHost(url.host)
}

/** Whether `url` is an `https:` URL without credentials on one of `hosts`. */
export function isDeclaredUrl(hosts: readonly string[], url: string | URL): boolean {
  let parsed: URL
  try {
    parsed = typeof url === 'string' ? new URL(url) : url
  } catch {
    return false
  }
  const host = hostOfUrl(parsed)
  return host !== undefined && hosts.includes(host)
}

/** An HTTPS URL without credentials, as its `href`, or `undefined`. */
export function httpsUrl(value: unknown, max: number = MANIFEST_LIMITS.url): string | undefined {
  if (typeof value !== 'string' || value.length > max) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
  return url.href
}

/** A relative path for `entry`: no scheme, no `//` host, no backslash, no control character. */
function isRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MANIFEST_LIMITS.entry &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(value) &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
    !/[\u0000-\u001f\u007f\s]/u.test(value)
  )
}

function invalid(message: string): PluginError {
  return new PluginError('invalid-manifest', message)
}

/** A cleaned optional text field, or `undefined` when absent. */
function optionalText(
  record: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(`"${key}" must be text`)
  const text = cleanText(value, max)
  return text === '' ? undefined : text
}

/**
 * Checks an untrusted manifest, such as the JSON of a downloaded `fxm-plugin.json`, and returns
 * it in its one spelling: hosts normalized, operations de-duplicated and ordered, texts cleaned,
 * the request rate filled in. Fields FXM doesn't know are ignored.
 *
 * @throws PluginError `invalid-manifest` for anything it doesn't accept (the message names the
 * field), `unsupported-api` for a manifest written for another plugin API version.
 */
export function parseManifest(value: unknown): PluginManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('The manifest is not a JSON object')
  }
  const record = value as Record<string, unknown>

  const api = record.fxmPlugin
  if (api !== PLUGIN_API_VERSION) {
    if (typeof api === 'number' && Number.isInteger(api) && api > PLUGIN_API_VERSION) {
      throw new PluginError(
        'unsupported-api',
        `The plugin was written for version ${api} of FXM's plugin API; this FXM speaks version ${PLUGIN_API_VERSION}`,
      )
    }
    throw invalid(`"fxmPlugin" must be ${PLUGIN_API_VERSION}`)
  }

  const { id } = record
  if (!isPluginId(id)) {
    throw invalid(
      '"id" must be 1 to 63 lower-case letters, digits and hyphens, without a hyphen at either end',
    )
  }

  if (typeof record.name !== 'string') throw invalid('"name" must be text')
  const name = cleanText(record.name, MANIFEST_LIMITS.name)
  if (name === '') throw invalid('"name" must not be empty')

  const { version, minFxmVersion } = record
  if (typeof version !== 'string' || parseVersion(version) === undefined) {
    throw invalid('"version" must be major.minor.patch, such as 1.0.0')
  }
  if (typeof minFxmVersion !== 'string' || parseVersion(minFxmVersion) === undefined) {
    throw invalid('"minFxmVersion" must be major.minor.patch, such as 0.1.0')
  }

  const description = optionalText(record, 'description', MANIFEST_LIMITS.description)
  const author = optionalText(record, 'author', MANIFEST_LIMITS.author)
  const license = optionalText(record, 'license', MANIFEST_LIMITS.license)
  let homepage: string | undefined
  if (record.homepage !== undefined) {
    homepage = httpsUrl(record.homepage)
    if (homepage === undefined) throw invalid('"homepage" must be an https:// address')
  }

  const rawHosts = record.hosts ?? []
  if (!Array.isArray(rawHosts)) throw invalid('"hosts" must be a list of host names')
  if (rawHosts.length > MANIFEST_LIMITS.hosts) {
    throw invalid(`"hosts" may list at most ${MANIFEST_LIMITS.hosts} hosts`)
  }
  const hosts: string[] = []
  for (const entry of rawHosts) {
    const host = normalizeHost(entry)
    if (host === undefined) {
      throw invalid(
        `"hosts" has ${JSON.stringify(cleanText(String(entry), 80))}, which is not a public host name (host or host:port)`,
      )
    }
    if (!hosts.includes(host)) hosts.push(host)
  }

  const { entry } = record
  if (typeof entry !== 'string' || !isRelativePath(entry)) {
    throw invalid('"entry" must be the relative path of the code, such as plugin.js')
  }

  const { sha256 } = record
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(sha256)) {
    throw invalid('"sha256" must be the SHA-256 of the code, in 64 hexadecimal digits')
  }

  const rawProvides = record.provides
  if (!Array.isArray(rawProvides) || rawProvides.length === 0) {
    throw invalid('"provides" must list what the plugin does, such as ["search", "resolve"]')
  }
  for (const operation of rawProvides) {
    if (!(PLUGIN_OPERATIONS as readonly unknown[]).includes(operation)) {
      throw invalid(
        `"provides" has ${JSON.stringify(cleanText(String(operation), 40))}: it may list ${PLUGIN_OPERATIONS.join(', ')}`,
      )
    }
  }
  const provides = PLUGIN_OPERATIONS.filter((operation) => rawProvides.includes(operation))
  const metadata = provides.filter((operation) => METADATA_OPERATIONS.includes(operation))
  if (metadata.length > 0 && !provides.includes('search')) {
    throw invalid(`"provides" lists ${metadata.join(', ')} but not "search", which they need`)
  }
  if (provides.includes('match') && !provides.includes('resolve')) {
    throw invalid('"provides" lists "match" but not "resolve", which it needs')
  }

  const rate = record.requestsPerHour ?? MANIFEST_LIMITS.defaultRequestsPerHour
  if (
    typeof rate !== 'number' ||
    !Number.isInteger(rate) ||
    rate < 1 ||
    rate > MANIFEST_LIMITS.maxRequestsPerHour
  ) {
    throw invalid(
      `"requestsPerHour" must be a whole number from 1 to ${MANIFEST_LIMITS.maxRequestsPerHour}`,
    )
  }

  return {
    fxmPlugin: PLUGIN_API_VERSION,
    id,
    name,
    version,
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(license === undefined ? {} : { license }),
    minFxmVersion,
    hosts,
    entry,
    sha256: sha256.toLowerCase(),
    provides,
    requestsPerHour: rate,
  }
}

/**
 * Checks that this FXM can run a plugin: its plugin API version (already checked by
 * {@link parseManifest}) and its oldest FXM version.
 *
 * @throws PluginError `needs-newer-fxm` when `appVersion` is older than `minFxmVersion`.
 */
export function checkCompatible(manifest: PluginManifest, appVersion: string): void {
  if (parseVersion(appVersion) === undefined) {
    throw new RangeError(`Not a version: ${appVersion}`)
  }
  if (compareVersions(appVersion, manifest.minFxmVersion) < 0) {
    throw new PluginError(
      'needs-newer-fxm',
      `${manifest.name} needs FXM ${manifest.minFxmVersion} or later; this is FXM ${appVersion}`,
    )
  }
}
