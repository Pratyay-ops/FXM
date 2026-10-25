import { useEffect, useState } from 'react'

/**
 * `value`, once it has stopped changing for `delayMs`. The first render returns `value` at once,
 * so a page opened from a link or with Back shows its results without waiting.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    if (Object.is(value, debounced)) return
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, debounced, delayMs])
  return debounced
}
