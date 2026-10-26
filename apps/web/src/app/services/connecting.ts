/**
 * The first moments of a page with FXM Connect. Its content script marks `<html>` before FXM's
 * code runs, but answers FXM's ping only once its service worker is up, which can take a second
 * or two. Until then the pages would show the Free tier and offer to install FXM Connect, which
 * is right there. So `main.tsx` calls {@link markConnecting} before the first render: while the
 * marker is on the page, the sources registry says it is detecting, and the pages say they are
 * connecting instead. The composition root ends that as soon as FXM Connect answers
 * (`followDetection` in `app-services.ts`), and the grace period at the latest: an FXM Connect
 * that never answers is as good as none.
 *
 * A module of its own with nothing heavy in it: it is part of the app's first bundle, while the
 * rest of the composition root loads beside the first render.
 *
 * @module
 */

import type { Sources } from '../../features/search/sources'

/**
 * FXM Connect's marker on `<html>`: `CONNECT_MARKER_ATTRIBUTE` of `@fxm/platform`, spelled out
 * so that this module doesn't pull the platform's FXM Connect client into the first bundle (a
 * test keeps the two the same).
 */
export const MARKER_ATTRIBUTE = 'data-fxm-connect'

/** How long the pages wait for FXM Connect's answer at most, from the page's start. */
export const CONNECT_GRACE_MS = 5000

/** Whether FXM Connect's marker is on `page`. */
export function connectMarkerPresent(page: Document): boolean {
  return page.documentElement?.hasAttribute(MARKER_ATTRIBUTE) === true
}

/**
 * Marks `sources` as detecting while FXM Connect's marker is on `page`, for `graceMs` at most.
 * Returns a function that ends it early.
 */
export function markConnecting(
  sources: Pick<Sources, 'setDetecting'>,
  page: Document = document,
  graceMs = CONNECT_GRACE_MS,
): () => void {
  if (!connectMarkerPresent(page)) return () => {}
  sources.setDetecting(true)
  const timer = setTimeout(() => sources.setDetecting(false), graceMs)
  return () => {
    clearTimeout(timer)
    sources.setDetecting(false)
  }
}
