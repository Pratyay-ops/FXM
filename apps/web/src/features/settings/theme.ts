import { useLayoutEffect } from 'react'
import { useMediaQuery } from '../../lib/use-media-query'
import { type ThemePreference, useSettingsStore } from './settings-store'

export type ResolvedTheme = 'dark' | 'light'

export const PREFERS_LIGHT_QUERY = '(prefers-color-scheme: light)'

/**
 * Turns the theme setting into the theme to show. index.html repeats this logic in
 * a tiny inline script that runs before the first paint; keep the two in step.
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersLight: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersLight ? 'light' : 'dark'
  return preference
}

/**
 * Applies a theme: `data-theme` on <html> switches the color tokens and native
 * controls (see styles/tokens.css), and the browser UI color follows the background.
 */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement) {
  root.dataset.theme = theme
  const background = getComputedStyle(root).getPropertyValue('--color-background').trim()
  const meta = root.ownerDocument.querySelector('meta[name="theme-color"]')
  if (meta && background) meta.setAttribute('content', background)
}

/** Keeps the page theme in sync with the setting and, for "system", with the OS. */
export function useThemeSync(): ResolvedTheme {
  const preference = useSettingsStore((state) => state.theme)
  const systemPrefersLight = useMediaQuery(PREFERS_LIGHT_QUERY)
  const theme = resolveTheme(preference, systemPrefersLight)
  useLayoutEffect(() => applyTheme(theme), [theme])
  return theme
}
