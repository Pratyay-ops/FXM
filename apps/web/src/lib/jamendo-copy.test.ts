// @vitest-environment node
// Reads the app's sources: no DOM.
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync, Visitor } from 'vite'
import { describe, expect, it } from 'vitest'

/**
 * A build without Jamendo's client_id must never present Jamendo as available (lib/free-sources.ts,
 * scripts/build-dist/README.md, "Jamendo"), so copy that names the free sources takes them from
 * freeSources(). This test keeps that true whatever copy later stages add: no string or JSX text
 * of the app's own code may name Jamendo outside these files, each of which names it only where a
 * build without it never shows it.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  // The switch, and the names freeSources() gives a build that offers Jamendo.
  'lib/free-sources.ts': ['Internet Archive and Jamendo', 'Internet Archive or Jamendo'],
  // The provider's name, registered only in a build with a client_id.
  'app/services/app-services.ts': ['Jamendo'],
  // Source labels, shown only next to Jamendo's own songs.
  'features/search/sources.ts': ['Jamendo'],
  'features/now-playing/stream-label.ts': ['Jamendo'],
  'embed/view.ts': ['Jamendo'],
}

/** The development fakes and test helpers, which no production build includes. */
const FAKES = /(?:^|\/)(?:test|testing|dev-fakes|fake-[\w-]+)(?:\/|\.tsx?$)/

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** The app's own code under src/, without tests and type declarations, relative to src/. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split(sep).join('/'))
    .filter((file) => /\.tsx?$/.test(file) && !/\.(?:test\.tsx?|d\.ts)$/.test(file))
    .sort()
}

/** The text of every string, template and JSX text in a file's code: what it can show. */
function textsOf(file: string, code = readFileSync(join(SRC, file), 'utf8')): string[] {
  const result = parseSync(file, code)
  if (result.errors.length > 0) {
    throw new Error(`${file} doesn't parse: ${result.errors[0]?.message ?? 'unknown error'}`)
  }
  const texts: string[] = []
  new Visitor({
    Literal(node) {
      if (typeof node.value === 'string') texts.push(node.value)
    },
    TemplateElement(node) {
      texts.push(node.value.cooked ?? node.value.raw)
    },
    JSXText(node) {
      texts.push(node.value)
    },
  }).visit(result.program)
  return texts
}

describe('Jamendo in the app’s copy', () => {
  it('is named only where a build without its client_id never shows it', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(100)
    const found: string[] = []
    for (const file of files) {
      if (FAKES.test(file)) continue
      for (const text of textsOf(file)) {
        if (text.includes('Jamendo') && !ALLOWED[file]?.includes(text)) {
          found.push(`${file}: ${JSON.stringify(text)}`)
        }
      }
    }
    // Copy that names the free sources takes them from freeSources() (lib/free-sources.ts).
    expect(found).toEqual([])
  })

  it('finds the names in strings, templates and JSX text, and nowhere else', () => {
    const file = 'features/example.tsx'
    const code = `
      // Jamendo, in a comment
      const createJamendoSource = () => 'jamendo'
      const a = \`Internet Archive and \${'Jamendo'}\`
      const b = <p title="Jamendo">Free music from Jamendo</p>
    `
    expect(textsOf(file, code).filter((text) => text.includes('Jamendo'))).toEqual([
      'Jamendo',
      'Jamendo',
      'Free music from Jamendo',
    ])
    expect(FAKES.test('features/search/dev-fakes.ts')).toBe(true)
    expect(FAKES.test('embed/testing/fake-provider.ts')).toBe(true)
    expect(FAKES.test('features/search/fake-catalog.ts')).toBe(true)
    expect(FAKES.test('features/settings/options.ts')).toBe(false)
  })
})
