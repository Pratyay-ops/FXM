/**
 * Abort-signal helpers that also work in older webviews: `AbortSignal.any` arrived in Safari 17.4
 * and Chrome 116, while the Tauri app runs in the system WebKit of older macOS releases too.
 *
 * @module
 */

/**
 * A signal that aborts when either `first` or `second` does, with that signal's reason:
 * `AbortSignal.any` where the platform has it, the same by hand where it does not.
 */
export function eitherSignal(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (!first) return second
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second])
  const controller = new AbortController()
  for (const signal of [first, second]) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
  }
  const onAbort = (event: Event) => {
    const source = event.target as AbortSignal
    first.removeEventListener('abort', onAbort)
    second.removeEventListener('abort', onAbort)
    controller.abort(source.reason)
  }
  first.addEventListener('abort', onAbort)
  second.addEventListener('abort', onAbort)
  return controller.signal
}
