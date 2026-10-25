import { useMemo, useSyncExternalStore } from 'react'

/** Chromium's Window Controls Overlay API, which TypeScript's DOM types don't include. */
export interface WindowControlsOverlay extends EventTarget {
  /** Whether the page draws the title bar right now (the user can switch it off). */
  readonly visible: boolean
  /** The part of the title bar the window buttons leave free, in the viewport's CSS pixels. */
  getTitlebarAreaRect(): DOMRect
}

/** `navigator.windowControlsOverlay`, where the browser has it (Chromium on desktop). */
export function windowControlsOverlay(
  nav: Navigator | undefined = globalThis.navigator,
): WindowControlsOverlay | undefined {
  const overlay = (nav as (Navigator & { windowControlsOverlay?: unknown }) | undefined)
    ?.windowControlsOverlay
  return typeof overlay === 'object' && overlay !== null && 'visible' in overlay
    ? (overlay as WindowControlsOverlay)
    : undefined
}

/**
 * How much of the title bar the window buttons take, in CSS pixels: from the left edge (macOS)
 * and from the right edge (Windows, Linux, ChromeOS). The other side is 0.
 */
export interface TitlebarInsets {
  left: number
  right: number
}

/** The insets for the free part of the title bar (`area`) in a viewport `viewportWidth` wide. */
export function titlebarInsets(area: DOMRectReadOnly, viewportWidth: number): TitlebarInsets {
  return {
    left: Math.max(0, Math.round(area.x)),
    right: Math.max(0, Math.round(viewportWidth - area.x - area.width)),
  }
}

function subscribe(onChange: () => void): () => void {
  const overlay = windowControlsOverlay()
  overlay?.addEventListener('geometrychange', onChange)
  window.addEventListener('resize', onChange)
  return () => {
    overlay?.removeEventListener('geometrychange', onChange)
    window.removeEventListener('resize', onChange)
  }
}

/** The insets as text ("left right"), so React sees a change only when a number changes. */
function snapshot(): string {
  const overlay = windowControlsOverlay()
  if (!overlay?.visible) return ''
  const { left, right } = titlebarInsets(overlay.getTitlebarAreaRect(), window.innerWidth)
  return `${left} ${right}`
}

/**
 * Where the window buttons are while the installed desktop window leaves its title bar to the
 * page (Window Controls Overlay, asked for in the manifest's `display_override`), or
 * `undefined` while it doesn't. It follows the user's switch in the window's title bar and the
 * window's size.
 */
export function useWindowControlsOverlay(): TitlebarInsets | undefined {
  const value = useSyncExternalStore(subscribe, snapshot, () => '')
  return useMemo(() => {
    if (!value) return undefined
    const [left = 0, right = 0] = value.split(' ').map(Number)
    return { left, right }
  }, [value])
}
