/**
 * The message check of a framed sandbox document: where the evaluator document sends its hello,
 * following stage 1.10's rule for FXM's sandbox documents. A document talks only to its parent at
 * the FXM origin. It sets no `frame-ancestors`, which would check every ancestor and break the
 * embed on third-party sites (stage 5.2).
 *
 * The FXM origin is the one the document was served from: the app at
 * `https://fxmusic.pages.dev/app/` frames `https://fxmusic.pages.dev/sandbox/eval.html`. Its
 * `sandbox` policy makes the document's own origin opaque (`self.origin` is `'null'`), but its URL
 * still names where it came from. The hello carries one end of the document's `MessageChannel`,
 * and the document hears requests only on its own end (`document.ts`), so a page on another site
 * that frames it, with or without the `sandbox` attribute, gets neither the hello nor a way in.
 *
 * This is the one touch-point with stage 1.10, which is not merged yet: once it is, its check
 * replaces this function.
 *
 * @module
 */

/** The parts of the document's `window` the check reads. */
export interface FramedWindow {
  /** The window that frames the document; the window itself when it is not framed. */
  readonly parent: unknown
  /** Where the document was served from. */
  readonly location: { readonly href: string }
}

/** The FXM origin a framed document talks to: the origin of the URL it was served from. */
export function trustedParentOrigin(window: FramedWindow): string {
  return new URL(window.location.href).origin
}
