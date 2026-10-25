/** Options for {@link fetchWithTimeout}. */
export interface TimeoutInit extends RequestInit {
  /** Abort the request after this many milliseconds. */
  timeoutMs: number
}

/** The reason a timed-out request aborts with, as `AbortSignal.timeout` gives it. */
function timeoutReason(): DOMException {
  return new DOMException('The operation timed out.', 'TimeoutError')
}

/**
 * Calls `fetchImpl` and aborts the request after `init.timeoutMs`, while still
 * honouring any `signal` the caller passed.
 *
 * Providers never use the global `fetch` directly: the platform injects it
 * (gateway Worker, Android native HTTP, Node), so it is a parameter here.
 *
 * Where `AbortSignal.timeout` or `AbortSignal.any` is missing (Safari before 16 and before 17.4:
 * iOS 16, and the system WebKit of macOS 11, the desktop app's oldest), it links an
 * `AbortController` to the caller's signal and a timer instead. Either way the timeout covers
 * reading the body too, and it rejects with a `TimeoutError`.
 */
export function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: TimeoutInit,
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init
  const native = typeof AbortSignal.timeout === 'function'
  if (native && (!signal || typeof AbortSignal.any === 'function')) {
    const timeout = AbortSignal.timeout(timeoutMs)
    return fetchImpl(input, {
      ...rest,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  }
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => {
    clearTimeout(timer)
    controller.abort(signal?.reason)
  }
  // The timer outlives the response on purpose, so that it also stops a body that never ends.
  const timer = setTimeout(() => {
    timedOut = true
    signal?.removeEventListener('abort', onAbort)
    controller.abort(timeoutReason())
  }, timeoutMs)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return fetchImpl(input, { ...rest, signal: controller.signal }).catch((error: unknown) => {
    // Older engines reject with a generic AbortError whatever the reason.
    throw timedOut && !signal?.aborted ? timeoutReason() : error
  })
}
