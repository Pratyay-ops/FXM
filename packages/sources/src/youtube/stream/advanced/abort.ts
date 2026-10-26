/**
 * Work shared between callers (one player script fetch, one BotGuard session) runs without any
 * one caller's signal; each caller waits for it with its own.
 *
 * @module
 */

/**
 * Resolves like `work`, or rejects with the signal's reason as soon as `signal` aborts, leaving
 * `work` to run on for whoever else waits for it.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
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
