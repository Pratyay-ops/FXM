/**
 * Waiting with limits: requests whose deadline holds even when a transport ignores its
 * `AbortSignal`, and waits that give up after a while. Platform transports are custom code (the
 * Lite sandbox, the Android OkHttp plugin), and one stuck request must never hold every YouTube
 * call of the device.
 *
 * @module
 */

/** A response with its body read as text. */
export interface TextResponse {
  /** The response; its body is already read. */
  readonly response: Response
  /** The body. */
  readonly text: string
}

/**
 * Waits for `promise`, but rejects with the signal's reason as soon as `signal` aborts, whether
 * or not `promise` settles then. `promise` itself goes on, e.g. for others that share it.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * The value of `promise`, or `fallback` when it takes longer than `ms`. A rejection counts as
 * `fallback` too, so the result never rejects.
 */
export function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/**
 * Calls `fetchImpl` and reads the body as text, within `timeoutMs` and until `signal` aborts.
 * Either one aborts the request, and the promise then rejects with the abort's reason (a
 * `TimeoutError` `DOMException` for the deadline) even when the transport ignores the abort, so a
 * stuck transport cannot hold the call past its deadline.
 */
export function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TextResponse> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const exchange = (async () => {
    const response = await fetchImpl(url, { ...init, signal: combined })
    return { response, text: await response.text() }
  })()
  return untilAborted(exchange, combined)
}
