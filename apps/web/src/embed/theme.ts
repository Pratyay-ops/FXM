import type { EmbedTheme } from './target'

/** The parts of the page {@link applyEmbedTheme} uses. */
export interface ThemeTarget {
  /** `<html>`, whose `data-theme` switches the design tokens (dark unless `light`). */
  readonly root: HTMLElement
  /** `window.matchMedia`, for `auto`. Absent where the browser has none. */
  readonly matchMedia?: (query: string) => MediaQueryList
}

/**
 * Applies the address's theme: dark (the design tokens' default), light, or `auto`, which
 * follows the visitor's system setting and keeps following it. Returns a function that stops
 * following.
 */
export function applyEmbedTheme(
  theme: EmbedTheme,
  target: ThemeTarget = {
    root: document.documentElement,
    ...(typeof window.matchMedia === 'function'
      ? { matchMedia: (query: string) => window.matchMedia(query) }
      : {}),
  },
): () => void {
  const set = (light: boolean) => {
    if (light) target.root.dataset.theme = 'light'
    else delete target.root.dataset.theme
  }
  if (theme !== 'auto' || target.matchMedia === undefined) {
    set(theme === 'light')
    return () => {}
  }
  const query = target.matchMedia('(prefers-color-scheme: light)')
  set(query.matches)
  const onChange = (event: MediaQueryListEvent) => set(event.matches)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
