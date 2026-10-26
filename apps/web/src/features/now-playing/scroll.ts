/**
 * Scrolling helpers for Now playing, the queue and the lyrics.
 *
 * @module
 */

/** Phones: below 768px, where Now playing stacks the panels under the track. */
const PHONE_QUERY = '(max-width: 47.99rem)'

function matches(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches
}

/** `smooth`, or `auto` when the user asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return matches('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth'
}

/** Whether the window has the phone layout. */
export function isPhoneLayout(): boolean {
  return matches(PHONE_QUERY)
}

/**
 * Whether `element` is fully inside the part of the window the bars leave free (the page's
 * scroll padding says how much they cover).
 */
export function isInView(element: Element): boolean {
  const style = getComputedStyle(document.documentElement)
  const top = Number.parseFloat(style.scrollPaddingTop) || 0
  const bottom = Number.parseFloat(style.scrollPaddingBottom) || 0
  const rect = element.getBoundingClientRect()
  return rect.top >= top && rect.bottom <= window.innerHeight - bottom
}
