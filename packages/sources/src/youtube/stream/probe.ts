/**
 * The end-of-file probe: before a stream URL is accepted where its bytes can be read (FXM
 * Connect, the desktop app, the Android app), FXM fetches the last 64 KiB of the file with one
 * ranged GET. YouTube caps the URLs of most of its clients: they answer 403 somewhere between
 * about 0.4 and 2 MiB, so a probe past a fixed offset would miss some, while the end of the file
 * catches them all.
 *
 * The `Range` header holds a single `bytes=first-last` range, which the Fetch standard counts as
 * CORS-safelisted, so the probe needs no preflight. (A suffix range, `bytes=-65536`, would not
 * be safelisted, which is why the probe asks for the file's length first when it doesn't know
 * it.)
 *
 * @module
 */

import type { FullLengthCheck, ProviderContext } from '@fxm/core'

/** How much of the end of the file the probe reads. */
export const PROBE_BYTES = 65_536

/** What a probe found. */
export interface ProbeResult {
  /**
   * `verified` when the last bytes arrived in full, `capped` when googlevideo refused them with
   * 403, and `unverified` when the probe could not tell (a network failure, which includes a
   * CORS failure after a googlevideo redirect, an unreadable answer or another status).
   */
  readonly fullLength: FullLengthCheck
  /** The file's length in bytes, when the probe knew or learned it. */
  readonly contentLength?: number
  /** What happened, for diagnostics, e.g. `206`, `HTTP 403` or `network error`. */
  readonly detail: string
}

/** Options for {@link probeEndOfFile}. */
export interface ProbeOptions {
  /** The file's length, if known (adaptive formats say; muxed ones don't). */
  readonly contentLength?: number
  /** How long each request may take, in milliseconds. */
  readonly timeoutMs: number
}

/** A `Content-Range: bytes first-last/length` header. */
function parseContentRange(header: string | null) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(header?.trim() ?? '')
  if (match === null) return undefined
  return { first: Number(match[1]), last: Number(match[2]), length: Number(match[3]) }
}

/**
 * Sends one ranged GET and hands the response to `read`. The request is cancelled once `read`
 * returns, so an answer that ignores the range is never downloaded in full.
 */
async function ranged<T>(
  ctx: ProviderContext,
  url: string,
  first: number,
  last: number,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const done = new AbortController()
  const signals = [done.signal, AbortSignal.timeout(timeoutMs)]
  if (ctx.signal !== undefined) signals.push(ctx.signal)
  try {
    const response = await ctx.fetch(url, {
      method: 'GET',
      headers: { Range: `bytes=${first}-${last}` },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.any(signals),
    })
    return await read(response)
  } finally {
    done.abort()
  }
}

/** The outcome of a failed request: the caller's cancellation is rethrown. */
function failure(error: unknown, ctx: ProviderContext): ProbeResult {
  if (ctx.signal?.aborted === true) throw ctx.signal.reason
  const timeout = error instanceof Error && error.name === 'TimeoutError'
  return { fullLength: 'unverified', detail: timeout ? 'timed out' : 'network error' }
}

/** Asks for the first byte, to learn the file's length from `Content-Range`. */
async function lengthOf(ctx: ProviderContext, url: string, timeoutMs: number) {
  return ranged(ctx, url, 0, 0, timeoutMs, async (response) => {
    if (response.status === 403) return { capped: true, detail: 'HTTP 403' } as const
    const range = parseContentRange(response.headers.get('content-range'))
    if (response.status !== 206 || range === undefined) {
      return { capped: false, detail: `HTTP ${response.status} without a length` } as const
    }
    return { capped: false, length: range.length, detail: '206' } as const
  })
}

/**
 * Fetches the last {@link PROBE_BYTES} of the file at `url` (the whole file when it is
 * smaller) and says whether the URL serves the file in full. When the length is unknown, it
 * first asks for one byte to learn it from `Content-Range`. It never throws, except to pass on
 * the caller's cancellation (`ctx.signal`).
 */
export async function probeEndOfFile(
  ctx: ProviderContext,
  url: string,
  options: ProbeOptions,
): Promise<ProbeResult> {
  let length = options.contentLength
  try {
    if (length === undefined) {
      const answer = await lengthOf(ctx, url, options.timeoutMs)
      if (answer.capped) return { fullLength: 'capped', detail: answer.detail }
      if (answer.length === undefined) return { fullLength: 'unverified', detail: answer.detail }
      length = answer.length
    }
    const known = length
    const first = Math.max(0, known - PROBE_BYTES)
    const last = known - 1
    return await ranged(ctx, url, first, last, options.timeoutMs, async (response) => {
      const detail = `HTTP ${response.status}`
      if (response.status === 403) return { fullLength: 'capped', contentLength: known, detail }
      if (response.status !== 206) return { fullLength: 'unverified', contentLength: known, detail }
      const range = parseContentRange(response.headers.get('content-range'))
      if (
        range !== undefined &&
        (range.first !== first || range.last !== last || range.length !== known)
      ) {
        return { fullLength: 'unverified', contentLength: known, detail: 'another range' }
      }
      const bytes = (await response.arrayBuffer()).byteLength
      return bytes === last - first + 1
        ? { fullLength: 'verified', contentLength: known, detail: '206' }
        : { fullLength: 'unverified', contentLength: known, detail: `${bytes} bytes` }
    })
  } catch (error) {
    return { ...failure(error, ctx), ...(length === undefined ? {} : { contentLength: length }) }
  }
}
