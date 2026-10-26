import { vi } from 'vitest'
import { REDUCED_MOTION_QUERY } from '../components/ui/now-playing-marker'

/**
 * Makes the browser say the user asked for reduced motion, as their system setting would, for
 * the rest of the test (the test setup restores `matchMedia` after each test).
 */
export function preferReducedMotion(): void {
  const matchMedia = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const list = matchMedia(query)
    // The real list, so its listeners work, answering `true` for this query only.
    return query === REDUCED_MOTION_QUERY
      ? Object.defineProperty(list, 'matches', { value: true })
      : list
  })
}
