/**
 * The TOTP secret behind Spotify's anonymous web-player tokens. FXM never ships it: a
 * {@link SpotifySecretProvider} fetches it at run time from a configurable source (by default the
 * community-maintained JSON files listed in `spotify-config.json`, or a URL or JSON the user
 * enters) and keeps it in memory only, for a limited time.
 *
 * The published JSON lists numbered secrets, each a list of numbers (or a string of the same
 * character codes). The newest version is used: its numbers become the HMAC key as described at
 * {@link deriveSpotifyTotpKey}, and its number is sent as `totpVer`.
 *
 * A secret source is third-party data, so it is bounded: at most 64 KiB of JSON, secrets of at
 * most 256 numbers, versions of at most four digits (what FXM Connect's bridge forwards), a 5 s
 * timeout, no credentials, `https:` only, and no `localhost` or IP-address hosts.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import { checkHttpsUrl } from './config'
import { messageOf, redact, SpotifyError } from './errors'
import { eitherSignal } from './signals'

/** A secret ready for the TOTP: its version and the derived HMAC-SHA1 key. */
export interface SpotifyTotpSecret {
  /** The secret's version number, sent as `totpVer`. */
  readonly version: number
  /** The HMAC-SHA1 key. */
  readonly key: Uint8Array<ArrayBuffer>
}

/**
 * Where a secret comes from: an `https:` URL of a JSON file (fetched with GET, no credentials),
 * or JSON text the user pasted. Build one from what the user typed with
 * {@link parseSpotifySecretSource}.
 */
export type SpotifySecretSource = { readonly url: string } | { readonly json: string }

/** Options for {@link SpotifySecretProvider.get}. */
export interface SpotifySecretLoadOptions {
  /** Skip the cache and load again, e.g. after the token endpoint refused a TOTP. */
  refresh?: boolean
  /** The secret the token endpoint refused. A source that still serves it is skipped. */
  refused?: SpotifyTotpSecret
}

/** Loads and caches the TOTP secret. */
export interface SpotifySecretProvider {
  /**
   * The current secret: the cached one while it is fresh, else a newly loaded one. When a reload
   * after the cache lifetime fails, the last good secret is kept (it works until Spotify refuses
   * it) and the reload is tried again later. Concurrent calls share one load.
   *
   * @throws SpotifyError `secret-unavailable` when no source yields a secret, `secret-rejected`
   * when every source that answers still serves the `refused` secret.
   */
  get(ctx: ProviderContext, options?: SpotifySecretLoadOptions): Promise<SpotifyTotpSecret>
  /**
   * Replaces the sources, e.g. from Settings, and forgets the cached secret.
   *
   * @throws TypeError when a source is not valid (see {@link parseSpotifySecretSource}).
   */
  setSources(sources: readonly SpotifySecretSource[]): void
  /** Forgets the cached secret. */
  clear(): void
}

/** Options for {@link createSpotifySecretProvider}. */
export interface SpotifySecretProviderOptions {
  /** The sources, tried in order until one yields a secret. */
  sources: readonly SpotifySecretSource[]
  /** How long a loaded secret stays fresh. Default 6 hours. */
  ttlMs?: number
  /**
   * After a reload past the lifetime failed, how long the last good secret is used before the
   * next reload. Default 5 minutes.
   */
  retryMs?: number
  /** Per-request timeout, including reading the body. Default 5 s. */
  timeoutMs?: number
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  now?: () => number
  /**
   * The `fetch` for URL sources. Default: `ctx.fetch`. The web app passes one that fetches
   * through its sandboxed user-host document, so the secret host stays out of the app's CSP.
   */
  fetch?: ProviderContext['fetch']
}

/** The newest secret found in a secret JSON document. */
export interface ParsedSpotifySecret {
  /** Its version number, 1 to 9999. */
  version: number
  /** Its numbers (character codes), not yet derived into a key. */
  secret: number[]
}

/** The most bytes of secret JSON read from a source, or characters accepted when pasted. */
export const MAX_SECRET_JSON_BYTES = 64 * 1024
/** The most numbers (or characters) one secret may have. */
const MAX_SECRET_LENGTH = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toCodes(secret: unknown): number[] | undefined {
  if (typeof secret === 'string') {
    if (secret.length === 0 || secret.length > MAX_SECRET_LENGTH) return undefined
    return Array.from(secret, (char) => char.charCodeAt(0))
  }
  if (!Array.isArray(secret) || secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
    return undefined
  }
  const valid = secret.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
  return valid ? (secret as number[]) : undefined
}

/** A version FXM Connect's bridge forwards: 1 to 4 digits. */
function toVersion(value: unknown): number | undefined {
  const version = typeof value === 'string' && /^\d{1,4}$/u.test(value) ? Number(value) : value
  return Number.isInteger(version) && (version as number) >= 1 && (version as number) <= 9999
    ? (version as number)
    : undefined
}

/**
 * Finds the newest secret in a secret JSON document. Three shapes are accepted:
 *
 * - a map from version to numbers: `{ "<version>": [<numbers>], … }`
 * - a list of entries: `[{ "version": <version>, "secret": [<numbers>] | "<text>" }, …]`
 * - one entry: `{ "version": <version>, "secret": … }`
 *
 * Entries that are malformed are skipped, as are secrets longer than 256 numbers and versions
 * outside 1 to 9999.
 *
 * @throws SpotifyError `secret-unavailable` when the document holds no usable secret. The
 * message never contains secret material.
 */
export function parseSpotifySecretJson(value: unknown): ParsedSpotifySecret {
  const entries: Array<{ version: unknown; secret: unknown }> = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isRecord(entry)) entries.push({ version: entry.version, secret: entry.secret })
    }
  } else if (isRecord(value) && 'version' in value && 'secret' in value) {
    entries.push({ version: value.version, secret: value.secret })
  } else if (isRecord(value)) {
    for (const [version, secret] of Object.entries(value)) entries.push({ version, secret })
  }
  let best: ParsedSpotifySecret | undefined
  for (const entry of entries) {
    const version = toVersion(entry.version)
    const secret = toCodes(entry.secret)
    if (version !== undefined && secret !== undefined && (!best || version > best.version)) {
      best = { version, secret }
    }
  }
  if (!best) throw new SpotifyError('secret-unavailable', 'The secret JSON holds no secret')
  return best
}

/**
 * Derives the HMAC-SHA1 key from a published secret, the way Spotify's web player does (the
 * community-documented transform, checked against the live token endpoint on 2026-10-25): every
 * number is XORed with `(index % 33) + 9`, the results are written in decimal and concatenated,
 * and the UTF-8 bytes of that text are the key.
 */
export function deriveSpotifyTotpKey(secret: readonly number[]): Uint8Array<ArrayBuffer> {
  const text = secret.map((code, index) => code ^ ((index % 33) + 9)).join('')
  return new TextEncoder().encode(text)
}

/**
 * Checks a secret source, e.g. one restored from settings, and returns a normalized copy: a URL
 * must be `https:` on a public host (no `localhost`, no IP address) without a user name or
 * password; pasted JSON must hold a usable secret and be at most 64 KiB.
 *
 * @throws TypeError, with a message Settings can show, when the source is not valid.
 */
export function checkSpotifySecretSource(source: SpotifySecretSource): SpotifySecretSource {
  const value: unknown = source
  if (isRecord(value) && typeof value.url === 'string') {
    return Object.freeze({
      url: checkHttpsUrl(value.url, 'The secret source', { publicHost: true }),
    })
  }
  if (isRecord(value) && typeof value.json === 'string') {
    const text = value.json.trim()
    if (text.length > MAX_SECRET_JSON_BYTES) throw new TypeError('The pasted secret is too long')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new TypeError('The pasted secret is not JSON')
    }
    try {
      parseSpotifySecretJson(parsed)
    } catch {
      throw new TypeError('The pasted secret JSON holds no usable secret')
    }
    return Object.freeze({ json: text })
  }
  throw new TypeError('A secret source is a URL or the pasted secret JSON')
}

/**
 * Turns what the user typed in Settings → Spotify → Secret source into a source: JSON (text that
 * starts with `{` or `[`) or a URL, checked as {@link checkSpotifySecretSource} does. Call it
 * before saving the setting, so a bad source is refused when it is entered.
 *
 * @throws TypeError, with a message Settings can show, when the text is neither.
 */
export function parseSpotifySecretSource(text: string): SpotifySecretSource {
  const trimmed = String(text).trim()
  if (trimmed === '') throw new TypeError('Enter a URL or the secret JSON')
  return checkSpotifySecretSource(/^[[{]/u.test(trimmed) ? { json: trimmed } : { url: trimmed })
}

/** Whether two secrets are the same version with the same key. */
export function sameSpotifySecret(a: SpotifyTotpSecret, b: SpotifyTotpSecret): boolean {
  return (
    a.version === b.version &&
    a.key.length === b.key.length &&
    a.key.every((byte, index) => byte === b.key[index])
  )
}

class TooLarge extends Error {}

/** Reads a body as text, refusing more than `maxBytes`, also when no length is declared. */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) {
    await discard(response)
    throw new TooLarge()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new TooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Nothing to release.
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Creates a {@link SpotifySecretProvider} over the given sources.
 *
 * @throws TypeError when a source is not valid (see {@link checkSpotifySecretSource}).
 */
export function createSpotifySecretProvider(
  options: SpotifySecretProviderOptions,
): SpotifySecretProvider {
  const ttlMs = options.ttlMs ?? 6 * HOUR
  const retryMs = options.retryMs ?? 5 * MINUTE
  const timeoutMs = options.timeoutMs ?? 5_000
  const now = options.now ?? Date.now
  let sources = options.sources.map(checkSpotifySecretSource)
  let cached: { secret: SpotifyTotpSecret; expiresAt: number } | undefined
  /** While a stale secret is used after a failed reload: when to try the sources again. */
  let retryAt = 0
  let loading: { promise: Promise<SpotifyTotpSecret>; refresh: boolean } | undefined
  let generation = 0

  async function readSource(source: SpotifySecretSource, ctx: ProviderContext): Promise<unknown> {
    if ('json' in source) return JSON.parse(source.json)
    const host = hostOf(source.url)
    const fetchImpl = options.fetch ?? ctx.fetch
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = eitherSignal(ctx.signal, timeout)
    let response: Response
    try {
      response = await fetchImpl(source.url, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        signal,
      })
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      if (timeout.aborted) throw new Error(`${host} timed out`)
      throw new Error(`${host} unreachable (${redact(messageOf(error))})`)
    }
    if (!response.ok) {
      await discard(response)
      throw new Error(`${host} answered HTTP ${response.status}`)
    }
    let text: string
    try {
      text = await readLimitedText(response, MAX_SECRET_JSON_BYTES)
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      if (error instanceof TooLarge) throw new Error(`${host} sent more than 64 KiB`)
      if (timeout.aborted) throw new Error(`${host} timed out`)
      throw new Error(`${host}: the answer could not be read`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${host} did not send JSON`)
    }
  }

  async function load(
    ctx: ProviderContext,
    refused: SpotifyTotpSecret | undefined,
  ): Promise<SpotifyTotpSecret> {
    const failures: string[] = []
    let refusedAgain = false
    for (const source of sources) {
      try {
        const parsed = parseSpotifySecretJson(await readSource(source, ctx))
        const secret = { version: parsed.version, key: deriveSpotifyTotpKey(parsed.secret) }
        if (refused && sameSpotifySecret(secret, refused)) {
          refusedAgain = true
          failures.push(`${describe(source)} still serves the refused secret`)
          continue
        }
        return secret
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason
        failures.push(messageOf(error))
      }
    }
    const detail = failures.length > 0 ? failures.join('; ') : 'no source is configured'
    if (refusedAgain) {
      throw new SpotifyError('secret-rejected', `No other Spotify TOTP secret found: ${detail}`)
    }
    throw new SpotifyError(
      'secret-unavailable',
      `Could not load the Spotify TOTP secret: ${detail}`,
    )
  }

  function start(
    ctx: ProviderContext,
    refresh: boolean,
    refused: SpotifyTotpSecret | undefined,
  ): Promise<SpotifyTotpSecret> {
    // A refresh supersedes loads that started before it: they may still return the refused
    // secret, so they must not overwrite the refresh's answer in the cache.
    if (refresh) generation += 1
    const started = generation
    // A secret Spotify refused is not kept, not even as a fallback.
    if (refused && cached && sameSpotifySecret(cached.secret, refused)) cached = undefined
    const stale = refresh ? undefined : cached?.secret
    const promise = load(ctx, refused).then(
      (secret) => {
        if (started === generation) {
          cached = { secret, expiresAt: now() + ttlMs }
          retryAt = 0
        }
        return secret
      },
      (error: unknown) => {
        // The last good secret still works until Spotify refuses it: keep it, and try the
        // sources again later instead of on every call.
        if (stale && started === generation && !ctx.signal?.aborted) {
          retryAt = now() + retryMs
          return stale
        }
        throw error
      },
    )
    const entry = { promise, refresh }
    loading = entry
    const settle = () => {
      if (loading === entry) loading = undefined
    }
    promise.then(settle, settle)
    return promise
  }

  return {
    async get(ctx, { refresh = false, refused } = {}) {
      const time = now()
      if (!refresh && cached && (time < cached.expiresAt || time < retryAt)) return cached.secret
      const shared = loading
      // A refresh never takes the answer of a load that started before the refusal.
      if (shared && (shared.refresh || !refresh)) {
        try {
          return await shared.promise
        } catch (error) {
          // Every failure of a load is a SpotifyError, except the abort of the caller that
          // started it. That abort is not ours: load again for this caller.
          if (error instanceof SpotifyError || ctx.signal?.aborted) throw error
        }
      }
      return start(ctx, refresh, refused)
    },
    setSources(next) {
      sources = next.map(checkSpotifySecretSource)
      generation += 1
      cached = undefined
      loading = undefined
      retryAt = 0
    },
    clear() {
      generation += 1
      cached = undefined
      loading = undefined
      retryAt = 0
    },
  }
}

function describe(source: SpotifySecretSource): string {
  return 'url' in source ? hostOf(source.url) : 'the pasted secret'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the secret source'
  }
}
