/**
 * What the runtime adds to an app's bundle: each entry an app would import, bundled and minified
 * by rolldown (Vite 8's bundler, so the app's build), then compressed as Cloudflare Pages sends it
 * (brotli at quality 4, as stage 8.5a's budgets measure; gzip for comparison). `size.test.ts`
 * holds the budgets; `pnpm --filter @fxm/i18n size` prints the numbers.
 *
 * @module
 */

import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'

const source = (file: string): string =>
  JSON.stringify(fileURLToPath(new URL(`../src/${file}`, import.meta.url)))

/** The runtime as the web app would take it at startup: an instance, negotiation, the document. */
const CORE = `export { createI18n, defineMessages, negotiateLocale, requestedLocales, applyDocumentLocale } from ${source('index.ts')}`

/** The entries measured, as the code of a module that re-exports them. */
export const ENTRIES = {
  /** {@link CORE}: the parser, message formatting, catalogs and fallback, negotiation. */
  core: CORE,
  /** The core plus the React provider and hooks (React itself is the app's already). */
  react: `${CORE}\nexport { I18nProvider, useT, useLocale } from ${source('react.ts')}`,
  /** Every Intl formatter (`createFormatters`, `useFormat`); a chunk that imports one pays less. */
  formatters: `export { createFormatters } from ${source('intl.ts')}`,
  /** The pseudo-locales, which only development builds and Diagnostics load. */
  pseudo: `export { PSEUDO_LOCALES } from ${source('pseudo.ts')}`,
} as const

/** Parts of the core, measured alone for docs/I18N.md's breakdown; they have no budgets. */
export const PARTS = {
  /** The message parser, with its error messages. */
  parser: `export { parseMessage } from ${source('parse.ts')}`,
  /** The parser and message formatting. */
  formatting: `export { parseMessage } from ${source('parse.ts')}\nexport { formatToString, formatToParts } from ${source('format.ts')}`,
  /** What start-up needs of negotiation besides `negotiateLocale`. */
  startup: `export { textDirection, fallbackChain, requestedLocales, applyDocumentLocale } from ${source('negotiate.ts')}`,
  /** All of negotiation. */
  negotiation: `export { textDirection, fallbackChain, requestedLocales, applyDocumentLocale, negotiateLocale } from ${source('negotiate.ts')}`,
  /** One formatter alone, with the number formatter it uses. */
  formatDuration: `export { formatDuration } from ${source('intl.ts')}`,
} as const

/** Sizes of one bundle, in bytes. */
export interface Size {
  readonly minified: number
  readonly gzip: number
  readonly brotli: number
}

/** Bundles `code` (a module) with rolldown, minified, and measures it. */
export async function measure(code: string): Promise<Size> {
  const bundle = await rolldown({
    input: 'entry',
    external: ['react'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'entry',
        resolveId: (id) => (id === 'entry' ? id : null),
        load: (id) => (id === 'entry' ? code : null),
      },
    ],
  })
  try {
    const { output } = await bundle.generate({ format: 'esm', minify: true })
    const bytes = Buffer.from(
      output.map((chunk) => (chunk.type === 'chunk' ? chunk.code : '')).join(''),
    )
    return {
      minified: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      brotli: brotliCompressSync(bytes, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 4,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
      }).length,
    }
  } finally {
    await bundle.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const print = async (entries: Readonly<Record<string, string>>) => {
    for (const [name, code] of Object.entries(entries)) {
      const size = await measure(code)
      process.stdout.write(
        `${name.padEnd(14)} ${String(size.minified).padStart(6)} B minified  ${String(size.gzip).padStart(5)} B gzip  ${String(size.brotli).padStart(5)} B brotli\n`,
      )
    }
  }
  await print(ENTRIES)
  process.stdout.write('\nParts of the core, alone:\n')
  await print(PARTS)
}
