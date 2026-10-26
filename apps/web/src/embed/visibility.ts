/**
 * Whether the player is visible enough for the page that embeds it to start playback through
 * the postMessage API (`api.ts`). Without this rule a site could run the player as a hidden
 * engine behind its own buttons: transparent, a pixel wide or off-screen, so the visitor never
 * sees FXM, and YouTube sees its Lite path used as a free audio backend. The visitor's own
 * clicks inside the player are never checked: a click means they see it.
 *
 * The rule, checked when a command arrives:
 *
 * - at least half of the player is inside the page's viewport (`IntersectionObserver`, whose
 *   implicit root in a cross-origin frame is the top-level viewport);
 * - the player's frame is at least 200 × 80 CSS pixels;
 * - where the browser can tell (Chromium's IntersectionObserver v2, `trackVisibility`), nothing
 *   covers the player and no ancestor makes it transparent, filters it or transforms it beyond
 *   moving it. Firefox and Safari can't tell, so there the first two checks are all there is.
 *
 * @module
 */

/** The rule's numbers. */
export const VISIBILITY_RULE = Object.freeze({
  /** How much of the player must be inside the viewport. */
  minRatio: 0.5,
  /** The smallest frame, in CSS pixels. */
  minWidth: 200,
  minHeight: 80,
  /** How long Chromium may wait between visibility reports: the smallest delay it allows. */
  delayMs: 100,
})

/** Whether the player is visible now. */
export interface VisibilityGate {
  /** Whether the player meets the rule, as of the browser's latest report. */
  visible(): boolean
  /** Stops watching. */
  dispose(): void
}

/** The parts of `window` the gate reads. */
export interface VisibilityWindow {
  readonly IntersectionObserver?: typeof IntersectionObserver
  readonly innerWidth: number
  readonly innerHeight: number
}

/** IntersectionObserver v2's options, which TypeScript's DOM types don't have yet. */
interface TrackingInit extends IntersectionObserverInit {
  readonly trackVisibility?: boolean
  readonly delay?: number
}

/**
 * Watches `target`, the player's root element, in `view`, the player's window. Until the
 * browser's first report, and where it has no `IntersectionObserver`, the player counts as
 * hidden.
 */
export function watchVisibility(target: Element, view: VisibilityWindow): VisibilityGate {
  const Observer = view.IntersectionObserver
  if (Observer === undefined) return { visible: () => false, dispose: () => {} }
  let latest: { readonly ratio: number; readonly unobstructed: boolean | undefined } | undefined
  const init: TrackingInit = {
    threshold: [0, VISIBILITY_RULE.minRatio, 1],
    trackVisibility: true,
    delay: VISIBILITY_RULE.delayMs,
  }
  const observer = new Observer((entries) => {
    const entry = entries.at(-1)
    if (entry === undefined) return
    const { isVisible } = entry as IntersectionObserverEntry & { readonly isVisible?: boolean }
    latest = { ratio: entry.intersectionRatio, unobstructed: isVisible }
  }, init)
  // Chromium reflects `trackVisibility` back; browsers without v2 ignore the option.
  const tracksVisibility = (observer as { readonly trackVisibility?: boolean }).trackVisibility
  observer.observe(target)
  return {
    visible() {
      if (latest === undefined) return false
      if (view.innerWidth < VISIBILITY_RULE.minWidth) return false
      if (view.innerHeight < VISIBILITY_RULE.minHeight) return false
      if (latest.ratio < VISIBILITY_RULE.minRatio) return false
      return tracksVisibility !== true || latest.unobstructed === true
    },
    dispose: () => observer.disconnect(),
  }
}
