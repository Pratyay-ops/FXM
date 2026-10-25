import { describe, expect, it } from 'vitest'
import {
  buildEvaluatorDocument,
  EVALUATOR_DOCUMENT_FILE,
  evaluatorHeaderPolicy,
  renderEvaluatorDocument,
  scriptHashOf,
} from './build'

/** Node's `fs`, without Node's types (this package type-checks with the DOM library only). */
const fs = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
    }
  }
).process.getBuiltinModule('node:fs')

const committed = fs.readFileSync(
  new URL(`../../../../${EVALUATOR_DOCUMENT_FILE}`, import.meta.url),
  'utf8',
)

/** The policies and the inline script of an HTML document. */
function partsOf(html: string) {
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/u.exec(html)?.[1]
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1])
  return { meta, scripts }
}

describe('the evaluator document', () => {
  it('is up to date: run `pnpm --filter @fxm/platform build:evaluator` after changing its sources', async () => {
    const built = await buildEvaluatorDocument()
    expect(committed).toBe(built.html)
  }, 60_000)

  it('runs only its one inline script, allowed by hash, and allows no connections', async () => {
    const { meta, scripts } = partsOf(committed)
    expect(scripts).toHaveLength(1)
    const hash = await scriptHashOf(scripts[0] ?? '')
    expect(meta).toBe(
      `default-src 'none'; script-src ${hash} 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'`,
    )
    expect(committed).not.toMatch(/<script[^>]*\bsrc=/u)
    expect(committed).not.toContain("'unsafe-inline'")
  })

  it('is served with sandbox allow-scripts in front of the same policy', async () => {
    const build = await renderEvaluatorDocument('console.log(1)')
    expect(build.headerPolicy).toBe(evaluatorHeaderPolicy(build.scriptHash))
    expect(build.headerPolicy.startsWith('sandbox allow-scripts; ')).toBe(true)
    expect(build.headerPolicy).toContain("connect-src 'none'")
  })

  it('computes the hash browsers compare the script with', async () => {
    // printf 'console.log(1)' | openssl dgst -sha256 -binary | base64
    expect(await scriptHashOf('console.log(1)')).toBe(
      "'sha256-CihokcEcBW4atb/CW/XWsvWwbTjqwQlE9nj9ii5ww5M='",
    )
  })

  it('refuses a script that would end the inline element early', async () => {
    await expect(renderEvaluatorDocument('"</script>"')).rejects.toThrow('</script')
  })
})
