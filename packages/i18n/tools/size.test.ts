import { describe, expect, it } from 'vitest'
import { ENTRIES, measure } from './size.ts'

/**
 * Brotli bytes each entry may weigh, about 10 % over what it weighed when set (2026-10-26:
 * core 3,745, react 4,066, formatters 1,179, pseudo 600), as stage 8.5a's budgets leave. The web
 * app's entry chunk has 150,000 bytes and used 137,475, so every byte here is one the first load
 * pays. If an entry grows past its budget, look at what grew; raise the number only on purpose,
 * here and in docs/I18N.md ("Bundle size").
 */
const BUDGETS: Readonly<Record<keyof typeof ENTRIES, number>> = {
  core: 4_100,
  react: 4_500,
  formatters: 1_300,
  pseudo: 700,
}

describe('bundle size', () => {
  it.each(Object.keys(ENTRIES) as (keyof typeof ENTRIES)[])(
    'keeps %s within its budget',
    async (name) => {
      const size = await measure(ENTRIES[name])
      expect(size.brotli, `${name}: ${JSON.stringify(size)}`).toBeLessThanOrEqual(BUDGETS[name])
    },
  )

  it('leaves React out of the bundle', async () => {
    const size = await measure(ENTRIES.react)
    // React itself would add tens of kilobytes; the bindings add a few hundred bytes.
    expect(size.minified).toBeLessThan(12_000)
  })
})
