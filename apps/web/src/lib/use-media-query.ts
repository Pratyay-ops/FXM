import { useCallback, useSyncExternalStore } from 'react'

function mediaQueryList(query: string): MediaQueryList | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : undefined
}

/** Whether a CSS media query matches, updated live. `false` where `matchMedia` is missing. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaQueryList(query)
      list?.addEventListener('change', onChange)
      return () => list?.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => mediaQueryList(query)?.matches ?? false,
    () => false,
  )
}
