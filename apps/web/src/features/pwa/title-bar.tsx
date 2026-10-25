import { useLayoutEffect } from 'react'
import { documentTitle } from '../../components/layout/route-meta'
import { LogoMark } from '../../components/ui/logo'
import { useWindowControlsOverlay } from './window-controls-overlay'

/**
 * The title bar of an installed desktop window in Window Controls Overlay mode, where the
 * browser leaves the title bar to the page and draws only the window buttons over it.
 *
 * A thin strip along the top, in the page's colours, shows the mark and the window title, and
 * drags the window. Its content keeps to the free part of the title bar
 * (`env(titlebar-area-*)`, see `.titlebar-area` in styles/index.css), clear of the window
 * buttons on either side. While it shows, `data-titlebar` on <html> sets `--titlebar-height`,
 * which `--safe-top` adds to the top inset: the top bar and the sidebar move down below it.
 * When the user switches the overlay off, the strip goes and the browser's title bar returns.
 */
export function TitleBar({ title }: { title: string | undefined }) {
  const overlay = useWindowControlsOverlay()

  useLayoutEffect(() => {
    if (!overlay) return
    const root = document.documentElement
    root.dataset.titlebar = 'overlay'
    return () => {
      delete root.dataset.titlebar
    }
  }, [overlay])

  if (!overlay) return null
  return (
    // The operating system shows the window title already; this is its visual twin.
    <div
      aria-hidden="true"
      className="titlebar fixed inset-x-0 top-0 z-50 h-(--titlebar-height) border-b border-border bg-background select-none"
    >
      <div className="titlebar-area flex h-full items-center gap-2 px-3 text-xs font-semibold text-text-muted">
        <LogoMark className="size-4" />
        <span className="truncate">{documentTitle(title)}</span>
      </div>
    </div>
  )
}
