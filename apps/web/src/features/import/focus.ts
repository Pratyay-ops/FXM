/**
 * Keyboard focus on the import pages. An action that removes or replaces the button it was
 * started from (a card's Retry, a review decision, the preview's Start) moves focus somewhere
 * that makes sense, so it never falls back to the top of the document. So does a button that
 * goes away by itself while it has focus, such as Pause once its import finishes.
 *
 * @module
 */

import { type RefCallback, useCallback, useLayoutEffect, useRef } from 'react'

/** How long {@link focusWhenReady} waits for its target to appear, in milliseconds. */
const WAIT_MS = 3000

/** The `id` of an import card's title. */
export function importTitleId(id: string): string {
  return `import-title-${id}`
}

/**
 * Focuses the element `find` returns once it is in the page: the live queries that render it may
 * take a moment after the action. With `scroll`, it is scrolled to the middle of the window too.
 * After a few seconds without it, focus goes to the page's main region.
 */
export function focusWhenReady(
  find: () => HTMLElement | null,
  { scroll = false }: { scroll?: boolean } = {},
): void {
  const deadline = Date.now() + WAIT_MS
  const attempt = () => {
    const target = find()
    if (target !== null) {
      target.focus({ preventScroll: scroll })
      if (scroll) target.scrollIntoView?.({ block: 'center' })
      return
    }
    if (Date.now() < deadline) setTimeout(attempt, 50)
    else document.getElementById('main')?.focus()
  }
  setTimeout(attempt, 0)
}

/** Focuses the title of import `id`'s card or page once it is there. */
export function focusImportTitle(id: string, options?: { scroll?: boolean }): void {
  focusWhenReady(() => document.getElementById(importTitleId(id)), options)
}

/** Whether focus fell to the page: on its body, or on an element that left it. */
function focusIsLost(): boolean {
  const active = document.activeElement
  return active === null || active === document.body || !active.isConnected
}

/**
 * A ref for the buttons of import `id` that can go away while they have focus, such as Pause
 * once the import finishes, or Resume when another tab runs or cancels the import: focus then
 * moves to the import's title. Nothing moves when the whole card or page goes away with them, or
 * when something else took the focus meanwhile.
 */
export function useFocusTitleWhenGone(id: string): RefCallback<HTMLElement> {
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback(
    (button: HTMLElement | null) => {
      if (button === null) return
      return () => {
        // React detaches a ref before it takes the element out, so it still has focus here.
        if (document.activeElement !== button) return
        setTimeout(() => {
          if (mounted.current && focusIsLost()) focusImportTitle(id)
        }, 0)
      }
    },
    [id],
  )
}
