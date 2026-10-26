import { useEffect, useState } from 'react'

/**
 * `value`, once it has stopped changing for `delayMs`. The first render returns `initial`, which
 * defaults to `value`: a page opened from a link or with Back then shows its results without
 * waiting. Pass another `initial` (such as an empty query) to make the first value wait too.
 */
export function useDebouncedValue<T>(value: T, delayMs: number, initial: T = value): T {
  const [debounced, setDebounced] = useState(initial)
  useEffect(() => {
    if (Object.is(value, debounced)) return
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, debounced, delayMs])
  return debounced
}
