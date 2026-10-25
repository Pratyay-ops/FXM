/**
 * Waiting with limits: requests whose deadline holds even when a transport ignores its
 * `AbortSignal`, and waits that give up after a while. Platform transports are custom code (the
 * Lite sandbox, the Android OkHttp plugin), and one stuck request must never hold every YouTube
 * call of the device.
 *
 * Nothing here needs `AbortSignal.any` or `AbortSignal.timeout`, which Safari has only from 17.4
 * and 16 (iOS 16 and the system WebKit of macOS 11, the desktop app's oldest, lack them), nor an
 * abort reason, which it has from 15.4.
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

/** The reason a request that ran out of time aborts with, as `AbortSignal.timeout` gives it. */
function timeoutReason(): DOMException {
  return new DOMException('The operation timed out.', 'TimeoutError')
}

/** Why `signal` aborted: its reason, or an `AbortError` where the engine keeps none. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Waits for `promise`, but rejects with the signal's reason as soon as `signal` aborts, whether
 * or not `promise` settles then. `promise` itself goes on, e.g. for others that share it.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
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
 * Either one aborts the request, and the promise then rejects even when the transport ignores
 * the abort, so a stuck transport cannot hold the call past its deadline: with a `TimeoutError`
 * `DOMException` for the deadline, else with the caller's reason.
 */
export function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TextResponse> {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal?.reason)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(timeoutReason())
  }, timeoutMs)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const exchange = (async () => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    return { response, text: await response.text() }
  })()
  return untilAborted(exchange, controller.signal)
    .catch((error: unknown) => {
      // Older engines abort without a reason, and some transports reject with a bare AbortError.
      throw timedOut && signal?.aborted !== true ? timeoutReason() : error
    })
    .finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    })
}
