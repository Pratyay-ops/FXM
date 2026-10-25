/** Options for {@link fetchWithTimeout}. */
export interface TimeoutInit extends RequestInit {
  /** Abort the request after this many milliseconds. */
  timeoutMs: number
}

/**
 * Calls `fetchImpl` and aborts the request after `init.timeoutMs`, while still
 * honouring any `signal` the caller passed.
 *
 * Providers never use the global `fetch` directly: the platform injects it
 * (gateway Worker, Android native HTTP, Node), so it is a parameter here.
 */
export function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: TimeoutInit,
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init
  const timeout = AbortSignal.timeout(timeoutMs)
  return fetchImpl(input, {
    ...rest,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
}
