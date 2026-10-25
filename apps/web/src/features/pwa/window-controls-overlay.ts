import { useSyncExternalStore } from 'react'

/** Chromium's Window Controls Overlay API, which TypeScript's DOM types don't include. */
export interface WindowControlsOverlay extends EventTarget {
  /** Whether the page draws the title bar right now (the user can switch it off). */
  readonly visible: boolean
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

function subscribe(onChange: () => void): () => void {
  const overlay = windowControlsOverlay()
  overlay?.addEventListener('geometrychange', onChange)
  return () => overlay?.removeEventListener('geometrychange', onChange)
}

const isVisible = () => windowControlsOverlay()?.visible ?? false

/**
 * Whether the installed desktop window currently leaves its title bar to the page (Window
 * Controls Overlay, asked for in the manifest's `display_override`). It follows the user's
 * switch in the window's title bar.
 */
export function useWindowControlsOverlay(): boolean {
  return useSyncExternalStore(subscribe, isVisible, () => false)
}
