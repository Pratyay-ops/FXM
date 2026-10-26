/**
 * Renders the sandbox documents `apps/web/sandbox/innertube.html` and `userhost.html` from
 * `../document.ts`: Node strips its types, the erased syntax is tidied away, and the script is
 * inlined into a page whose `<meta>` policy allows exactly that script by hash.
 *
 * `pnpm --filter @fxm/platform sandbox:build` writes the files (`build.ts`), and a test checks
 * that the committed ones are current. Node's type stripping (strip mode) only blanks type
 * syntax out and keeps every other character where it was, so the output is the source minus
 * its types, with no bundler or code generator in between.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { sandboxDocumentPolicy, sha256Source } from '../csp.ts'
import type { SandboxDocumentKind } from '../document.ts'

/** The script's source. */
export const DOCUMENT_SOURCE = fileURLToPath(new URL('../document.ts', import.meta.url))

/** Where the documents live: the folder stage 2.8 publishes at `/sandbox/`. */
export const DOCUMENTS_DIR = fileURLToPath(
  new URL('../../../../../apps/web/sandbox/', import.meta.url),
)

/** Each document's file and title. */
export const SANDBOX_DOCUMENT_FILES: Readonly<
  Record<SandboxDocumentKind, { readonly file: string; readonly title: string }>
> = {
  innertube: { file: 'innertube.html', title: 'FXM sandbox: InnerTube' },
  userhost: { file: 'userhost.html', title: 'FXM sandbox: user hosts' },
}

/** Node's type stripping, without its one-time "experimental feature" warning. */
export function stripTypes(source: string): string {
  const emitWarning = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (text.includes('stripTypeScriptTypes')) return
    ;(emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return stripTypeScriptTypes(source, { mode: 'strip' })
  } finally {
    process.emitWarning = emitWarning
  }
}

const isSpace = (char: string | undefined) => char === ' ' || char === '\t'
const isBlank = (char: string | undefined) => isSpace(char) || char === '\n' || char === '\r'

/** A doc comment that ends the text, followed by one line break and indentation. */
const TRAILING_DOC_COMMENT = /(^|\n)[ \t]*\/\*\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*\n[ \t]*$/

const isWord = (char: string | undefined) => char !== undefined && /[\w$]/.test(char)

/**
 * Removes the type syntax that strip mode blanked out: every run of blanked characters, with
 * the blanks between them, and the doc comment of a declaration that went entirely, such as an
 * interface. A run never takes the line break before or after it, so statements stay on their
 * own lines; it only joins the lines of a type that spanned several, inside one statement.
 */
export function compactStrippedSource(original: string, stripped: string): string {
  if (original.length !== stripped.length) {
    throw new Error('Strip mode must keep every character in place')
  }
  const erased = (index: number) => original[index] !== stripped[index]
  let out = ''
  let index = 0
  while (index < stripped.length) {
    if (!erased(index)) {
      out += stripped[index]
      index += 1
      continue
    }
    let last = index
    let end = index
    while (end < stripped.length && (erased(end) || isBlank(stripped[end]))) {
      if (erased(end)) last = end
      end += 1
    }
    if (/(^|\n)[ \t]*$/.test(out)) out = out.replace(TRAILING_DOC_COMMENT, '$1')
    index = last + 1
    const next = stripped[index]
    if (isSpace(next) && (isSpace(out.at(-1)) || /(^|\n)$/.test(out))) {
      // `private readonly x` → `x`, keeping the indentation before it.
      while (isSpace(stripped[index])) index += 1
    } else if (next === undefined || '\n\r)],;>.'.includes(next)) {
      // `(value as Type)` → `(value)`.
      out = out.replace(/(\S)[ \t]+$/, '$1')
    } else if (isWord(out.at(-1)) && isWord(next)) {
      out += ' '
    }
  }
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * `document.ts` as a script for a classic `<script>` element: types stripped and compacted,
 * `export` dropped from its declarations. Refuses a source that imports values or exports in
 * any other way, which a single inline script could not run.
 */
export function toDocumentScript(source: string): string {
  const compacted = compactStrippedSource(source, stripTypes(source))
  const code = compacted.replace(/^export (?=(?:async )?function\b|const\b|let\b|class\b)/gm, '')
  const statement = /^[ \t]*(import|export)\b.*$/m.exec(code)
  if (statement !== null) {
    throw new Error(`document.ts must stand alone, but it has: ${statement[0].trim()}`)
  }
  if (/<\/script|<!--/i.test(code)) {
    throw new Error('document.ts must not contain "</script" or "<!--", which would end the script')
  }
  return code
}

/** Options for {@link renderSandboxDocument}. */
export interface RenderOptions {
  /** The source of `document.ts`. Default: read from {@link DOCUMENT_SOURCE}. */
  readonly source?: string
}

/** The HTML of a sandbox document. */
export async function renderSandboxDocument(
  kind: SandboxDocumentKind,
  options: RenderOptions = {},
): Promise<string> {
  const source = options.source ?? (await readFile(DOCUMENT_SOURCE, 'utf8'))
  const { title } = SANDBOX_DOCUMENT_FILES[kind]
  const script = [
    '',
    '(() => {',
    "'use strict'",
    '',
    toDocumentScript(source),
    '',
    // Stage 2.8's contract for the documents it publishes (scripts/build-dist/src/later-stages.ts).
    '// Only where the sandbox policy made the origin opaque: Cloudflare Pages also serves this',
    "// document at percent-encoded paths that no header rule matches, with FXM's origin.",
    "if (self.origin === 'null') {",
    `  startSandboxDocument(globalThis, SANDBOX_DOCUMENT_POLICIES.${kind})`,
    '}',
    '})()',
    '    ',
  ].join('\n')
  const meta = sandboxDocumentPolicy(kind, [await sha256Source(script)], { sandbox: false })
  return [
    '<!doctype html>',
    '<!--',
    `  ${title}. Generated from packages/platform/src/sandbox/document.ts by`,
    '  `pnpm --filter @fxm/platform sandbox:build`: edit the source, not this file.',
    '-->',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    `    <meta http-equiv="Content-Security-Policy" content="${meta}" />`,
    `    <title>${title}</title>`,
    '  </head>',
    '  <body>',
    `    <script>${script}</script>`,
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}
