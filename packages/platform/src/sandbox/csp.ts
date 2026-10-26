/**
 * The Content-Security-Policies of the sandbox documents (docs/PLAN.md, the header table of
 * stage 2.8), and the hashes that allow their inline scripts.
 *
 * Each document is served with its policy as a header, which starts with `sandbox allow-scripts`
 * and so makes the document opaque however it is loaded. The same policy without `sandbox`
 * (which a `<meta>` policy may not carry) is also inside each document, so it holds even where
 * a server sends no header, such as a dev server.
 *
 * This module imports only `document.ts`, with its extension, so `tools/render.ts` can run it
 * in Node directly.
 *
 * @module
 */

import { SANDBOX_INNERTUBE_HOSTS, type SandboxDocumentKind } from './document.ts'

/** What each document may connect to: InnerTube's three hosts, or any HTTPS host. */
export const SANDBOX_CONNECT_SOURCES: Readonly<Record<SandboxDocumentKind, readonly string[]>> = {
  innertube: SANDBOX_INNERTUBE_HOSTS.map((host) => `https://${host}`),
  userhost: ['https:'],
}

/** Options for {@link sandboxDocumentPolicy}. */
export interface SandboxPolicyOptions {
  /**
   * Whether the policy starts with `sandbox allow-scripts`, as the header does. Default `true`;
   * `false` for the `<meta>` copy inside the document.
   */
  readonly sandbox?: boolean
}

/**
 * A sandbox document's policy, allowing the inline scripts with these `'sha256-…'` sources:
 *
 * - `innertube`: `sandbox allow-scripts; default-src 'none'; script-src 'sha256-…';
 *   connect-src https://www.youtube.com https://music.youtube.com
 *   https://youtubei.googleapis.com; base-uri 'none'; form-action 'none'`
 * - `userhost`: the same with `connect-src https:`
 *
 * No `frame-ancestors`: it checks every ancestor, so it would break Lite inside the embeddable
 * player on other sites (stage 5.2).
 */
export function sandboxDocumentPolicy(
  kind: SandboxDocumentKind,
  scriptSources: readonly string[],
  options: SandboxPolicyOptions = {},
): string {
  if (scriptSources.length === 0) throw new Error('A sandbox document needs its script allowed')
  for (const source of scriptSources) {
    if (!/^'sha256-[A-Za-z0-9+/]+={0,2}'$/.test(source)) {
      throw new Error(`Not a 'sha256-…' source: ${source}`)
    }
  }
  return [
    ...(options.sandbox === false ? [] : ['sandbox allow-scripts']),
    "default-src 'none'",
    `script-src ${scriptSources.join(' ')}`,
    `connect-src ${SANDBOX_CONNECT_SOURCES[kind].join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** Line endings as the HTML parser leaves them, which is what a browser hashes. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** `'sha256-…'`: the CSP source that allows an inline script with exactly this text. */
export async function sha256Source(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeNewlines(text))
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return `'sha256-${btoa(binary)}'`
}

/**
 * The text of every inline `<script>` (one without `src`) in a document, in order. Enough HTML
 * for the sandbox documents, which FXM generates; not a general parser.
 */
export function inlineScripts(html: string): string[] {
  const scripts: string[] = []
  const tag = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  for (const match of normalizeNewlines(html).matchAll(tag)) {
    const attributes = match[1] ?? ''
    if (!/\ssrc\s*=/i.test(attributes)) scripts.push(match[2] ?? '')
  }
  return scripts
}

/** The `Content-Security-Policy` header a sandbox document is served with. */
export async function sandboxDocumentHeader(
  kind: SandboxDocumentKind,
  html: string,
): Promise<string> {
  const sources = await Promise.all(inlineScripts(html).map(sha256Source))
  return sandboxDocumentPolicy(kind, sources)
}
