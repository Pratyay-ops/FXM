/**
 * The message checks of a framed sandbox document: which messages the evaluator document accepts
 * and where it replies, following stage 1.10's rule for FXM's sandbox documents. A document
 * accepts a message only when it comes from its parent window and from the FXM origin, and it
 * replies only to that origin. It sets no `frame-ancestors`, which would check every ancestor and
 * break the embed on third-party sites (stage 5.2).
 *
 * The FXM origin is the one the document was served from: the app at
 * `https://fxm-music.pages.dev/app/` frames `https://fxm-music.pages.dev/sandbox/eval.html`. Its
 * `sandbox` policy makes the document's own origin opaque (`self.origin` is `'null'`), but its URL
 * still names where it came from, so a page on another site that frames it, with or without the
 * `sandbox` attribute, has its messages ignored.
 *
 * This is the one touch-point with stage 1.10, which is not merged yet: once it is, its checks
 * replace these two functions.
 *
 * @module
 */

/** The parts of the document's `window` the checks read. */
export interface FramedWindow {
  /** The window that frames the document; the window itself when it is not framed. */
  readonly parent: unknown
  /** Where the document was served from. */
  readonly location: { readonly href: string }
}

/** The parts of a `MessageEvent` the checks read. */
export interface IncomingMessage {
  /** The window that sent the message. */
  readonly source: unknown
  /** The sender's origin, `'null'` for an opaque one. */
  readonly origin: string
}

/** The FXM origin a framed document trusts: the origin of the URL it was served from. */
export function trustedParentOrigin(window: FramedWindow): string {
  return new URL(window.location.href).origin
}

/**
 * Whether a framed document may act on `event`: the document is framed, the message comes from
 * its parent window, and from the FXM origin ({@link trustedParentOrigin}).
 */
export function isTrustedParentMessage(event: IncomingMessage, window: FramedWindow): boolean {
  if (window.parent === window || event.source !== window.parent) return false
  const origin = trustedParentOrigin(window)
  return origin !== 'null' && event.origin === origin
}
