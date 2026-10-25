/**
 * GET requests that read the whole body as text, for providers that must look at an answer
 * before parsing it (Last.fm, ListenBrainz, the Cover Art Archive and iTunes Search), through the
 * injected `fetch` only. `json.ts` has `getJson` for services whose answers are always JSON.
 *
 * Every request goes out with `credentials: 'omit'`, a timeout that covers the body, and a cap
 * on the body's size. The helpers return the status for the provider to read, because the
 * services mean different things by the same status: a Cover Art Archive 404 is "no artwork", a
 * Last.fm page that answers 200 with HTML is a bot check.
 *
 * @module
 */

import { FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from './index'
import { asObject } from './json'

/**
 * Milliseconds to wait from a `Retry-After` header (delay seconds or an HTTP date), or a fallback,
 * capped at an hour: the free sources' helper.
 */
export { retryAfterMs } from './json'

/** The value of `key` on a JSON object, or `undefined` when `value` is not one. */
export function field(value: unknown, key: string): unknown {
  return asObject(value)?.[key]
}

/** Options for {@link getText}. */
export interface GetOptions {
  /** The service's name, for error messages, e.g. `Cover Art Archive`. */
  service: string
  /** Abort the request, body included, after this many milliseconds. */
  timeoutMs: number
  /** Fail with `Parse` when the body is longer than this many bytes. */
  maxBytes: number
}

/** A response with its whole body read as text. */
export interface TextResponse {
  /** The HTTP status. */
  status: number
  /** The response headers. */
  headers: Headers
  /** The media type, lower case and without parameters, e.g. `application/json`. */
  contentType: string
  /** The body, decoded as UTF-8. */
  text: string
}

/**
 * Sends a `GET` with `ctx.fetch` and reads the whole body as text. No headers are set, so a
 * browser never needs a CORS preflight for it, and `credentials: 'omit'` keeps cookies out.
 *
 * Rejects with the signal's reason when `ctx.signal` aborts, with a `Network` `FxmError` when the
 * request fails, breaks off or takes longer than `timeoutMs`, and with a `Parse` one when the body
 * is longer than `maxBytes`. Every status, errors included, resolves.
 */
export async function getText(
  ctx: ProviderContext,
  url: string,
  options: GetOptions,
): Promise<TextResponse> {
  const { signal } = ctx
  try {
    const response = await fetchWithTimeout(ctx.fetch, url, {
      method: 'GET',
      credentials: 'omit',
      timeoutMs: options.timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await readText(response, options)
    signal?.throwIfAborted()
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0] ?? ''
    return {
      status: response.status,
      headers: response.headers,
      contentType: contentType.trim().toLowerCase(),
      text,
    }
  } catch (error) {
    throw failure(error, signal, options)
  }
}

/** Reads a body as UTF-8 text, cancelling it once it passes `maxBytes`. */
async function readText(response: Response, options: GetOptions): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    bytes += value.byteLength
    if (bytes > options.maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new FxmError(
        'Parse',
        `${options.service} answered with more than ${options.maxBytes} bytes`,
      )
    }
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * What a failed request rejects with: the signal's reason when the caller cancelled it, an
 * `FxmError` as it is, otherwise a `Network` error that names a timeout when that is what
 * stopped it.
 */
function failure(error: unknown, signal: AbortSignal | undefined, options: GetOptions): unknown {
  if (signal?.aborted) return signal.reason
  if (isFxmError(error)) return error
  const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
  const message = timedOut
    ? `${options.service} did not answer within ${options.timeoutMs} ms`
    : `${options.service} could not be reached`
  return new FxmError('Network', message, { cause: error })
}

/** The JSON in a response's body, or a `Parse` `FxmError` that names `service`. */
export function parseJson(response: TextResponse, service: string): unknown {
  try {
    return JSON.parse(response.text)
  } catch (error) {
    throw new FxmError('Parse', `${service} answered with invalid JSON`, { cause: error })
  }
}

/**
 * Seconds of freshness from a `Cache-Control` header's `max-age`, as milliseconds, or `undefined`
 * when there is none. `no-store` and `no-cache` count as zero.
 */
export function maxAgeMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const directives = header.toLowerCase()
  if (/(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/u.test(directives)) return 0
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/u.exec(directives)
  return match?.[1] === undefined ? undefined : Number(match[1]) * 1000
}

/** A rejection with `RateLimited`, saying how long to wait. */
export function rateLimited(service: string, waitMs: number): FxmError {
  return new FxmError('RateLimited', `${service} asked FXM to slow down`, {
    retryAfterMs: Math.max(0, Math.round(waitMs)),
  })
}
