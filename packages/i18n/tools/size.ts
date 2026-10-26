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
  for (const [name, code] of Object.entries(ENTRIES)) {
    const size = await measure(code)
    process.stdout.write(
      `${name.padEnd(10)} ${String(size.minified).padStart(6)} B minified  ${String(size.gzip).padStart(5)} B gzip  ${String(size.brotli).padStart(5)} B brotli\n`,
    )
  }
}
