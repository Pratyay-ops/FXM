import { useLayoutEffect } from 'react'
import { useWindowControlsOverlay } from './window-controls-overlay'

/** The inset variables `useTitleBar` sets on <html>, in pixels. */
const INSET_PROPERTIES = { left: '--titlebar-left', right: '--titlebar-right' } as const

/**
 * Makes the top bar the title bar of an installed desktop window in Window Controls Overlay
 * mode, where the browser leaves the title bar to the page and draws only the window buttons
 * over it: on the left on macOS, on the right on Windows, Linux and ChromeOS.
 *
 * While the overlay shows, <html> gets `data-titlebar` ("overlay", plus "left" or "right" for
 * the side with the window buttons) and the insets `--titlebar-left` and `--titlebar-right`.
 * styles/index.css then lets the top bar and the sidebar's logo row drag the window (their links,
 * buttons and the search box stay clickable), keeps their content clear of the window buttons,
 * and keeps the skip link below them. When the user switches the overlay off, all of it goes and
 * the browser's own title bar comes back.
 */
export function useTitleBar(): void {
  const insets = useWindowControlsOverlay()

  useLayoutEffect(() => {
    if (insets === undefined) return
    const root = document.documentElement
    root.dataset.titlebar = ['overlay', insets.left > 0 && 'left', insets.right > 0 && 'right']
      .filter(Boolean)
      .join(' ')
    root.style.setProperty(INSET_PROPERTIES.left, `${insets.left}px`)
    root.style.setProperty(INSET_PROPERTIES.right, `${insets.right}px`)
    return () => {
      delete root.dataset.titlebar
      root.style.removeProperty(INSET_PROPERTIES.left)
      root.style.removeProperty(INSET_PROPERTIES.right)
    }
  }, [insets])
}
