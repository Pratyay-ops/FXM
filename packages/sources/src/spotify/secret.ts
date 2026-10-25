/**
 * The TOTP secret behind Spotify's anonymous web-player tokens. FXM never ships it: a
 * {@link SecretProvider} fetches it at run time from a configurable source (by default the
 * community-maintained JSON files listed in `spotify-config.json`, or a URL or JSON the user
 * enters) and keeps it in memory only, for a limited time.
 *
 * The published JSON lists numbered secrets, each a list of numbers (or a string of the same
 * character codes). The newest version is used: its numbers become the HMAC key as described at
 * {@link deriveTotpKey}, and its number is sent as `totpVer`.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import { redact, SpotifyError } from './errors'
import { eitherSignal } from './signals'

/** A secret ready for the TOTP: its version and the derived HMAC-SHA1 key. */
export interface TotpSecret {
  /** The secret's version number, sent as `totpVer`. */
  readonly version: number
  /** The HMAC-SHA1 key. */
  readonly key: Uint8Array<ArrayBuffer>
}

/**
 * Where a secret comes from: a URL of a JSON file (fetched with GET, no credentials), or JSON
 * text the user pasted.
 */
export type SecretSource = { readonly url: string } | { readonly json: string }

/** Loads and caches the TOTP secret. */
export interface SecretProvider {
  /**
   * The current secret: the cached one while it is fresh, else a newly loaded one. `refresh`
   * skips the cache, e.g. after the token endpoint refused a TOTP. Concurrent calls share one load.
   *
   * @throws SpotifyError `Unavailable` (`secret-unavailable`) when no source yields a secret.
   */
  get(ctx: ProviderContext, options?: { refresh?: boolean }): Promise<TotpSecret>
  /** Replaces the sources, e.g. from Settings, and forgets the cached secret. */
  setSources(sources: readonly SecretSource[]): void
  /** Forgets the cached secret. */
  clear(): void
}

/** Options for {@link createSecretProvider}. */
export interface SecretProviderOptions {
  /** The sources, tried in order until one yields a secret. */
  sources: readonly SecretSource[]
  /** How long a loaded secret stays fresh. Default 6 hours. */
  ttlMs?: number
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  now?: () => number
  /**
   * The `fetch` for URL sources. Default: `ctx.fetch`. The web app can pass one that reaches the
   * secret host through its user-host sandbox document.
   */
  fetch?: ProviderContext['fetch']
}

/** The newest secret found in a secret JSON document. */
export interface ParsedSecret {
  /** Its version number. */
  version: number
  /** Its numbers (character codes), not yet derived into a key. */
  secret: number[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toCodes(secret: unknown): number[] | undefined {
  if (typeof secret === 'string') {
    return secret.length > 0 ? Array.from(secret, (char) => char.charCodeAt(0)) : undefined
  }
  if (!Array.isArray(secret) || secret.length === 0) return undefined
  const valid = secret.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
  return valid ? (secret as number[]) : undefined
}

function toVersion(value: unknown): number | undefined {
  const version = typeof value === 'string' && /^\d{1,9}$/u.test(value) ? Number(value) : value
  return Number.isSafeInteger(version) && (version as number) > 0 ? (version as number) : undefined
}

/**
 * Finds the newest secret in a secret JSON document. Three shapes are accepted:
 *
 * - a map from version to numbers: `{ "<version>": [<numbers>], … }`
 * - a list of entries: `[{ "version": <version>, "secret": [<numbers>] | "<text>" }, …]`
 * - one entry: `{ "version": <version>, "secret": … }`
 *
 * Entries that are malformed are skipped.
 *
 * @throws SpotifyError `Unavailable` (`secret-unavailable`) when the document holds no usable
 * secret. The message never contains secret material.
 */
export function parseSecretJson(value: unknown): ParsedSecret {
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
  let best: ParsedSecret | undefined
  for (const entry of entries) {
    const version = toVersion(entry.version)
    const secret = toCodes(entry.secret)
    if (version !== undefined && secret !== undefined && (!best || version > best.version)) {
      best = { version, secret }
    }
  }
  if (!best) {
    throw new SpotifyError('Unavailable', 'secret-unavailable', 'The secret JSON holds no secret')
  }
  return best
}

/**
 * Derives the HMAC-SHA1 key from a published secret, the way Spotify's web player does (the
 * community-documented transform, checked against the live token endpoint on 2026-10-25): every
 * number is XORed with `(index % 33) + 9`, the results are written in decimal and concatenated,
 * and the UTF-8 bytes of that text are the key.
 */
export function deriveTotpKey(secret: readonly number[]): Uint8Array<ArrayBuffer> {
  const text = secret.map((code, index) => code ^ ((index % 33) + 9)).join('')
  return new TextEncoder().encode(text)
}

const HOUR = 3_600_000

/** Creates a {@link SecretProvider} over the given sources. */
export function createSecretProvider(options: SecretProviderOptions): SecretProvider {
  const ttlMs = options.ttlMs ?? 6 * HOUR
  const timeoutMs = options.timeoutMs ?? 15_000
  const now = options.now ?? Date.now
  let sources = [...options.sources]
  let cached: { secret: TotpSecret; expiresAt: number } | undefined
  let loading: Promise<TotpSecret> | undefined
  let generation = 0

  async function readSource(source: SecretSource, ctx: ProviderContext): Promise<unknown> {
    if ('json' in source) {
      try {
        return JSON.parse(source.json)
      } catch {
        throw new Error('the pasted secret is not JSON')
      }
    }
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
      if (timeout.aborted) throw new Error(`${hostOf(source.url)} timed out`)
      throw new Error(`${hostOf(source.url)} unreachable (${redact(messageOf(error))})`)
    }
    if (!response.ok) throw new Error(`${hostOf(source.url)} answered HTTP ${response.status}`)
    try {
      return await response.json()
    } catch {
      throw new Error(`${hostOf(source.url)} did not send JSON`)
    }
  }

  async function load(ctx: ProviderContext): Promise<TotpSecret> {
    const failures: string[] = []
    for (const source of sources) {
      try {
        const parsed = parseSecretJson(await readSource(source, ctx))
        return { version: parsed.version, key: deriveTotpKey(parsed.secret) }
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason
        failures.push(messageOf(error))
      }
    }
    const detail = failures.length > 0 ? failures.join('; ') : 'no source is configured'
    throw new SpotifyError(
      'Unavailable',
      'secret-unavailable',
      `Could not load the Spotify TOTP secret: ${detail}`,
    )
  }

  function start(ctx: ProviderContext): Promise<TotpSecret> {
    const started = generation
    const promise = load(ctx).then((secret) => {
      if (started === generation) cached = { secret, expiresAt: now() + ttlMs }
      return secret
    })
    loading = promise
    const settle = () => {
      if (loading === promise) loading = undefined
    }
    promise.then(settle, settle)
    return promise
  }

  return {
    async get(ctx, { refresh = false } = {}) {
      if (!refresh && cached && now() < cached.expiresAt) return cached.secret
      const shared = loading
      if (shared) {
        try {
          return await shared
        } catch (error) {
          // Every failure of a load is a SpotifyError, except the abort of the caller that
          // started it. That abort is not ours: load again for this caller.
          if (error instanceof SpotifyError || ctx.signal?.aborted) throw error
        }
      }
      return start(ctx)
    },
    setSources(next) {
      sources = [...next]
      generation += 1
      cached = undefined
      loading = undefined
    },
    clear() {
      generation += 1
      cached = undefined
      loading = undefined
    },
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the secret source'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
