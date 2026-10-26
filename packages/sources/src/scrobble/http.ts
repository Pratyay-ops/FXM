/**
 * HTTP helpers the scrobble clients share: one request at a time with a pause between them,
 * waits the services ask for, and reading answers whatever their status.
 *
 * @module
 */

/** The longest wait a service's header is taken at its word for: an hour. */
export const MAX_RETRY_AFTER_MS = 3_600_000

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `ms` capped to {@link MAX_RETRY_AFTER_MS}, or `undefined` when it isn't a number. */
function capped(ms: number): number | undefined {
  return Number.isFinite(ms) ? Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS) : undefined
}

/**
 * How long a service asked FXM to wait, in milliseconds, from `Retry-After` (seconds or an
 * HTTP date) or else ListenBrainz's `X-RateLimit-Reset-In` (seconds), capped at an hour.
 * `undefined` when neither header says.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get('retry-after')?.trim() ?? ''
  if (/^\d+(?:\.\d+)?$/u.test(value)) return capped(Number(value) * 1000)
  // An HTTP date names its weekday and month; Date.parse alone also takes strings such as "-1".
  if (/[a-z]/iu.test(value)) {
    const ms = capped(Date.parse(value) - now)
    if (ms !== undefined) return ms
  }
  const resetIn = headers.get('x-ratelimit-reset-in')?.trim() ?? ''
  return /^\d+(?:\.\d+)?$/u.test(resetIn) ? capped(Number(resetIn) * 1000) : undefined
}

/** Settings of a {@link RequestGate}. */
export interface RequestGateOptions {
  /** The pause between the end of one request and the start of the next, in milliseconds. */
  minIntervalMs: number
  /** The longest a request waits for its turn's hold; beyond it, the request fails at once. */
  maxWaitMs: number
  /** The error a request fails with when its hold is longer than `maxWaitMs`. */
  tooLong: (waitMs: number) => Error
}

/**
 * Sends one client's requests one at a time, in order, each at least `minIntervalMs` after the
 * one before it ended, and none before a hold that the service asked for (`holdUntil`). A
 * request whose hold is longer than `maxWaitMs` fails at once instead of waiting.
 */
export class RequestGate {
  private tail: Promise<unknown> = Promise.resolve()
  private lastEndAt = Number.NEGATIVE_INFINITY
  private heldUntil = 0

  constructor(private readonly options: RequestGateOptions) {}

  /** Holds every request back until `at`, in epoch milliseconds. */
  holdUntil(at: number): void {
    if (at > this.heldUntil) this.heldUntil = at
  }

  /** Runs `request` in its turn. A cancelled `signal` takes it out before it starts. */
  run<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const turn = this.tail.then(async () => {
      signal?.throwIfAborted()
      const now = Date.now()
      const heldMs = this.heldUntil - now
      if (heldMs > this.options.maxWaitMs) throw this.options.tooLong(heldMs)
      const waitMs = Math.max(this.lastEndAt + this.options.minIntervalMs, this.heldUntil) - now
      if (waitMs > 0) await sleep(waitMs, signal)
      try {
        return await request()
      } finally {
        this.lastEndAt = Date.now()
      }
    })
    this.tail = turn.catch(() => undefined)
    return turn
  }
}

/** An answer's body as text, or `undefined` when reading it failed. */
export async function bodyText(response: Response): Promise<string | undefined> {
  try {
    return await response.text()
  } catch {
    return undefined
  }
}

/** The JSON in `text`, or `undefined` when there is none. */
export function parseJson(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Whether `error` is the timeout of `fetchWithTimeout`. */
export function timedOut(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError'
}
