/**
 * Moves focus somewhere stable before the control that has it goes away (the update toast's
 * "Not now", an install button whose offer is used up), so keyboard and screen reader users keep
 * their place instead of landing on <body>.
 *
 * Focuses `target` when it is still in the page and takes focus; otherwise the page's main
 * content (`#main`, which the skip link focuses too), without scrolling to it.
 */
export function moveFocus(target?: Element | null): void {
  if (target instanceof HTMLElement && target.isConnected && target !== document.body) {
    target.focus()
    if (document.activeElement === target) return
  }
  document.getElementById('main')?.focus({ preventScroll: true })
}
