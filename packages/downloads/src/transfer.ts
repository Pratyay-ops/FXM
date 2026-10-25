/**
 * Fetching a file with single-range GETs and writing its bytes to storage as they arrive, so a
 * transfer can stop at any moment and continue later from the size of the stored file.
 *
 * A `Range` header with one range (`bytes=start-end`) is CORS-safelisted, so on the web these
 * requests need no preflight; the platform's `fetch` (FXM Connect's rules, or native HTTP on
 * desktop and Android) makes googlevideo's answers readable.
 *
 * @module
 */

import type { Fetch } from '@fxm/core'
import type { DownloadWriter } from './storage'

/** The server answered with an HTTP status that ends this transfer. */
export class DownloadHttpError extends Error {
  /** Always `DownloadHttpError`. */
  override readonly name = 'DownloadHttpError'
  /** The HTTP status. */
  readonly status: number
  /** How long the server asked to wait (`Retry-After`), when it did. */
  readonly retryAfterMs: number | undefined

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * The request failed without an answer (offline, a dropped connection, or on the web a CORS
 * failure, which is what a googlevideo redirect to another host looks like), or the answer broke
 * off before its end.
 */
export class DownloadNetworkError extends Error {
  /** Always `DownloadNetworkError`. */
  override readonly name = 'DownloadNetworkError'
}

/**
 * What can be wrong with an answer, although its status was fine:
 *
 * - `range-mismatch`: it holds other bytes than the ones asked for
 * - `size-changed`: the file's size differs from what an earlier answer said
 * - `validator-changed`: the file's `Last-Modified` or `ETag` differs from an earlier answer's
 * - `beyond-end`: the stored bytes go past the end of the file
 * - `not-media`: the server sent a page or a message instead of the file
 */
export type DownloadProtocolProblem =
  | 'range-mismatch'
  | 'size-changed'
  | 'validator-changed'
  | 'beyond-end'
  | 'not-media'

/** An answer the transfer can't use (see {@link DownloadProtocolProblem}). */
export class DownloadProtocolError extends Error {
  /** Always `DownloadProtocolError`. */
  override readonly name = 'DownloadProtocolError'
  /** What was wrong. */
  readonly problem: DownloadProtocolProblem

  constructor(problem: DownloadProtocolProblem, message: string) {
    super(message)
    this.problem = problem
  }
}

/** What a transfer learned about the file from the server. */
export interface TransferFacts {
  /** The file's size in bytes, once known. */
  total?: number
  /**
   * The file's validator, `last-modified:<date>` or `etag:<tag>`, when readable. Only validators
   * of the same kind are compared: different servers may send different headers.
   */
  validator?: string
}

/** Options for {@link transfer}. */
export interface TransferOptions {
  /** The platform's `fetch` (`ProviderContext.fetch`). */
  fetch: Fetch
  /** The file's URL. */
  url: string
  /** Extra request headers the stream needs (`StreamOption.requestHeaders`). */
  headers?: Readonly<Record<string, string>>
  /** Where the bytes go. The transfer neither flushes nor closes it. */
  writer: DownloadWriter
  /** How many bytes of the file the writer already holds: the transfer continues from there. */
  start: number
  /** The file's size, when an earlier answer told it. */
  total?: number
  /** The validator an earlier answer sent (see {@link TransferFacts.validator}). */
  validator?: string
  /** The most bytes to ask for in one request. */
  chunkBytes: number
  /** How many received bytes to collect before each write. Default: 256 KiB. */
  writeBytes?: number
  /** Stops the transfer. */
  signal: AbortSignal
  /** Called after each write with the number of bytes stored and the size, when known. */
  onProgress?: (bytes: number, total: number | undefined) => void
  /** Called when an answer tells something new about the file (its size, its validator). */
  onFacts?: (facts: TransferFacts) => void
}

/** What a finished transfer stored. */
export interface TransferResult extends TransferFacts {
  /** The file's size, which is also the number of bytes stored. */
  total: number
}

/** The default for {@link TransferOptions.writeBytes}. */
export const DEFAULT_WRITE_BYTES = 256 * 1024

/** `Content-Range` of a 206 answer, or of a 416 answer (`bytes *\/total`). */
interface ContentRange {
  start?: number
  end?: number
  total?: number
}

/** Reads a `Content-Range` header, or `undefined` when it is missing, unreadable or malformed. */
export function parseContentRange(header: string | null): ContentRange | undefined {
  if (header === null) return undefined
  const match = /^\s*bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)\s*$/i.exec(header)
  if (match === null) return undefined
  const [, from, to, size] = match
  const range: ContentRange = {}
  if (from !== undefined && to !== undefined) {
    range.start = Number(from)
    range.end = Number(to)
    if (range.end < range.start) return undefined
  }
  if (size !== undefined && size !== '*') range.total = Number(size)
  if (range.total !== undefined && range.end !== undefined && range.end >= range.total) {
    return undefined
  }
  return range
}

/** `Retry-After` in milliseconds: seconds, or an HTTP date; `undefined` when absent or bad. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function validatorOf(headers: Pick<Headers, 'get'>): string | undefined {
  const lastModified = headers.get('last-modified')
  if (lastModified !== null && lastModified.trim() !== '') {
    return `last-modified:${lastModified.trim()}`
  }
  const etag = headers.get('etag')
  return etag !== null && etag.trim() !== '' ? `etag:${etag.trim()}` : undefined
}

/** Whether two validators say the file changed: only validators of the same kind compare. */
function validatorChanged(known: string | undefined, seen: string | undefined): boolean {
  if (known === undefined || seen === undefined) return false
  const kind = (validator: string) => validator.slice(0, validator.indexOf(':'))
  return kind(known) === kind(seen) && known !== seen
}

function lengthOf(headers: Pick<Headers, 'get'>): number | undefined {
  const header = headers.get('content-length')
  if (header === null || !/^\s*\d+\s*$/.test(header)) return undefined
  return Number(header)
}

/** Whether the answer is a page or a message rather than a media file. */
function isNotMedia(headers: Pick<Headers, 'get'>): boolean {
  const type = headers.get('content-type')?.toLowerCase().trim() ?? ''
  return type.startsWith('text/') || type.startsWith('application/json')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the server'
  }
}

function abortReason(signal: AbortSignal, error: unknown): unknown {
  return signal.reason ?? error
}

/** Copies `parts` into one array of `length` bytes. */
function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0]
  const bytes = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

async function request(options: TransferOptions, range: string): Promise<Response> {
  try {
    return await options.fetch(options.url, {
      method: 'GET',
      headers: { ...options.headers, Range: range },
      signal: options.signal,
      // The file goes to storage; a copy in the HTTP cache would only take space twice.
      cache: 'no-store',
    })
  } catch (error) {
    if (options.signal.aborted) throw abortReason(options.signal, error)
    throw new DownloadNetworkError(`Couldn't reach ${hostOf(options.url)}`, { cause: error })
  }
}

/**
 * Writes the body of `response` to the writer: body bytes before `skip` are dropped (they are
 * stored already), and the first byte kept goes to file position `skip` plus `at - skip`, i.e.
 * the body is a slice of the file starting at `at - skip`. Returns how many body bytes arrived.
 */
async function pipe(
  response: Response,
  options: TransferOptions,
  at: number,
  skip: number,
  total: number | undefined,
): Promise<number> {
  const { writer, signal } = options
  const writeBytes = options.writeBytes ?? DEFAULT_WRITE_BYTES
  let received = 0
  let position = at
  const pending: Uint8Array[] = []
  let pendingBytes = 0
  const write = async () => {
    if (pendingBytes === 0) return
    const bytes = concat(pending, pendingBytes)
    pending.length = 0
    pendingBytes = 0
    await writer.write(position, bytes)
    position += bytes.length
    options.onProgress?.(position, total)
  }
  const take = async (chunk: Uint8Array) => {
    const from = received
    received += chunk.length
    if (received <= skip) return
    const piece = from < skip ? chunk.subarray(skip - from) : chunk
    pending.push(piece)
    pendingBytes += piece.length
    if (pendingBytes >= writeBytes) await write()
  }
  const body = response.body
  if (body === null || typeof body.getReader !== 'function') {
    let buffer: ArrayBuffer
    try {
      buffer = await response.arrayBuffer()
    } catch (error) {
      if (signal.aborted) throw abortReason(signal, error)
      throw new DownloadNetworkError('The answer broke off', { cause: error })
    }
    await take(new Uint8Array(buffer))
    await write()
    return received
  }
  const reader = body.getReader()
  let done = false
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        if (signal.aborted) throw abortReason(signal, error)
        throw new DownloadNetworkError('The answer broke off', { cause: error })
      }
      if (chunk.done) break
      await take(chunk.value)
    }
    done = true
    await write()
  } finally {
    if (!done) {
      // What arrived before a failure or an abort is kept, so a resume continues after it.
      // The failure itself is what the caller hears about.
      await write().catch(() => {})
      await reader.cancel().catch(() => {})
    }
  }
  return received
}

/**
 * Downloads the rest of a file into `options.writer`, from `options.start`, one bounded range
 * at a time. Each answer's bytes are written as they arrive, so after a failure or an abort the
 * writer holds every byte that came, and a later transfer continues from its size.
 *
 * - A `206` answer is checked against the range asked for, and its `Content-Range`, when
 *   readable, gives the file's size. Without it (a server that doesn't expose the header to
 *   pages), the end is where the server says there is nothing more: a `416` answer, or an empty
 *   one, to the range after the last byte. A chunk shorter than asked for is not enough, since a
 *   server may cap its answers.
 * - A `200` answer means the server ignored the range and sends the whole file: the bytes
 *   already stored are skipped, the rest written.
 * - Other statuses reject with a {@link DownloadHttpError}; a request without an answer, or an
 *   answer that breaks off, with a {@link DownloadNetworkError}; an answer that doesn't fit the
 *   file with a {@link DownloadProtocolError}. A storage failure rejects as the storage threw it.
 * - Aborting rejects with the signal's reason.
 */
export async function transfer(options: TransferOptions): Promise<TransferResult> {
  const { signal, chunkBytes } = options
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError(`chunkBytes must be a positive integer, not ${chunkBytes}`)
  }
  let offset = options.start
  let total = options.total
  let validator = options.validator
  const learned = (facts: TransferFacts) => {
    if (facts.total !== undefined || facts.validator !== undefined) options.onFacts?.(facts)
  }
  const result = (): TransferResult =>
    validator === undefined ? { total: offset } : { total: offset, validator }
  for (;;) {
    if (total !== undefined && offset >= total) {
      if (offset > total) {
        throw new DownloadProtocolError(
          'beyond-end',
          `${offset} bytes stored of a ${total}-byte file`,
        )
      }
      return result()
    }
    signal.throwIfAborted()
    const end = total === undefined ? offset + chunkBytes : Math.min(offset + chunkBytes, total)
    const response = await request(options, `bytes=${offset}-${end - 1}`)
    const { headers, status } = response
    const seen = validatorOf(headers)
    if (validatorChanged(validator, seen)) {
      await response.body?.cancel().catch(() => {})
      throw new DownloadProtocolError('validator-changed', 'The file changed on the server')
    }
    if (seen !== undefined && seen !== validator) {
      validator = seen
      learned({ validator })
    }
    const range = parseContentRange(headers.get('content-range'))
    if (status === 416) {
      await response.body?.cancel().catch(() => {})
      const size = range?.total ?? total
      if (size === undefined ? offset > 0 : size === offset) {
        if (total === undefined) learned({ total: offset })
        total = offset
        continue
      }
      if (size !== undefined && offset > size) {
        throw new DownloadProtocolError(
          'beyond-end',
          `${offset} bytes stored of a ${size}-byte file`,
        )
      }
      throw new DownloadHttpError(416, `${hostOf(options.url)} refused the range`)
    }
    if (status !== 200 && status !== 206) {
      await response.body?.cancel().catch(() => {})
      const retryAfter = parseRetryAfter(headers.get('retry-after'))
      throw new DownloadHttpError(status, `${hostOf(options.url)} answered ${status}`, retryAfter)
    }
    if (isNotMedia(headers)) {
      await response.body?.cancel().catch(() => {})
      throw new DownloadProtocolError('not-media', `${hostOf(options.url)} sent a page, not a file`)
    }
    const length = lengthOf(headers)
    if (status === 200) {
      // The whole file, whatever the range said.
      if (total !== undefined && length !== undefined && length !== total) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadProtocolError('size-changed', `The file is ${length} bytes, not ${total}`)
      }
      const size = length ?? total
      const received = await pipe(response, options, offset, offset, size)
      offset = Math.max(offset, received)
      if (size !== undefined && received < size) {
        throw new DownloadNetworkError(`The answer broke off after ${received} of ${size} bytes`)
      }
      if (total === undefined) learned({ total: offset })
      total = offset
      continue
    }
    // 206: the range asked for, or the part of it the file has.
    if (range?.start !== undefined && range.start !== offset) {
      await response.body?.cancel().catch(() => {})
      throw new DownloadProtocolError(
        'range-mismatch',
        `Asked for bytes from ${offset}, got bytes from ${range.start}`,
      )
    }
    if (range?.total !== undefined && range.total !== total) {
      if (total !== undefined) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadProtocolError(
          'size-changed',
          `The file is ${range.total} bytes, not ${total}`,
        )
      }
      total = range.total
      learned({ total })
    }
    const expected =
      range?.start !== undefined && range.end !== undefined ? range.end - range.start + 1 : length
    const received = await pipe(response, options, offset, 0, total)
    offset += received
    if (expected !== undefined && received < expected) {
      throw new DownloadNetworkError(`The answer broke off after ${received} of ${expected} bytes`)
    }
    // Without a readable size, a chunk shorter than asked for only suggests the end: a server
    // may also cap its answers. The next range confirms it with a 416 (see above) or nothing,
    // or brings the rest.
    if (total === undefined && received === 0) {
      total = offset
      learned({ total })
    }
  }
}
