/**
 * The code the share dialog copies: an `<iframe>` of the embeddable player (stage 5.2), and the
 * player's own address.
 *
 * @module
 */

import {
  EMBED_HEIGHTS,
  type EmbedOptions,
  type EmbedTarget,
  embedUrl,
  FXM_PUBLIC_ORIGIN,
} from '../../embed/target'

/**
 * The origin a shared player is served from. FXM Connect works only on FXM's public origin, so
 * shared code points there, from wherever the app runs: a local dev server's code still works
 * for everyone. A preview of FXM's site (`develop.fxmusic.pages.dev`) shares its own players,
 * so a preview can be tried end to end.
 */
export function shareOrigin(appOrigin: string): string {
  try {
    const app = new URL(appOrigin)
    const fxm = new URL(FXM_PUBLIC_ORIGIN).hostname
    if (app.protocol === 'https:' && (app.hostname === fxm || app.hostname.endsWith(`.${fxm}`))) {
      return app.origin
    }
  } catch {
    // Not a URL: share from the public origin.
  }
  return FXM_PUBLIC_ORIGIN
}

/** `text` for an HTML attribute value in double quotes. */
export function escapeAttribute(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** What the share dialog offers to copy. */
export interface EmbedCode {
  /** The player's address. */
  readonly url: string
  /** The `<iframe>` element to paste into a page. */
  readonly html: string
  /** Its height in CSS pixels, for the layout and kind. */
  readonly height: number
}

/**
 * The embed code for `target` in `options`, served from `origin`. The iframe takes the page's
 * width and the layout's height, may autoplay when the page asks it to through the postMessage
 * API (`allow="autoplay"`), and loads only when it scrolls near the screen. Its title names the
 * player for screen readers. Untrusted metadata, such as the title, is escaped.
 */
export function embedCode(
  target: EmbedTarget,
  options: EmbedOptions,
  title: string,
  origin: string,
): EmbedCode {
  const url = embedUrl(origin, target, options)
  const height = EMBED_HEIGHTS[options.layout][target.kind]
  const attributes = [
    `title="${escapeAttribute(`FXM player: ${title}`)}"`,
    `src="${escapeAttribute(url)}"`,
    'width="100%"',
    `height="${height}"`,
    'style="border:0;border-radius:12px"',
    'allow="autoplay"',
    'loading="lazy"',
  ]
  return { url, html: `<iframe ${attributes.join(' ')}></iframe>`, height }
}
