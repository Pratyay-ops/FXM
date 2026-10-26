import { describe, expect, it } from 'vitest'
import {
  firstLoadModules,
  keyCost,
  keyFor,
  type Message,
  placement,
  resolveModule,
  runtimeImports,
} from './first-load.ts'
import type { AreaCount } from './inventory.ts'

describe('runtimeImports', () => {
  it('lists what a module loads when it runs, and not types or import()', () => {
    const source = `
      import a from './a'
      import type { B } from './b'
      import { type C } from './c'
      import './d.css'
      export { e } from './e'
      export type { F } from './f'
      export * from './g'
      export const h = () => import('./h')
    `
    expect(runtimeImports(source, 'x.ts')).toEqual(['./a', './c', './d.css', './e', './g'])
    expect(runtimeImports('import { x } from "./x"\nexport const y = <p>{x}</p>', 'y.tsx')).toEqual(
      ['./x'],
    )
  })
})

const files: Record<string, string> = {
  'apps/web/src/main.tsx': [
    "import { App } from './app/app'",
    "import '@fxm/core'",
    "import './styles/index.css'",
    "void import('./lazy')",
  ].join('\n'),
  'apps/web/src/app/app.tsx': "import { x } from '../lib'\nimport type { T } from './types'",
  'apps/web/src/lib/index.ts': "export { y } from './y'",
  'apps/web/src/lib/y.ts': 'export const y = 1',
  'apps/web/src/app/types.ts': 'export type T = 1',
  'apps/web/src/lazy.tsx': 'export {}',
  'apps/web/src/styles/index.css': 'p {}',
}
const read = (path: string) => files[path]

describe('resolveModule', () => {
  it('resolves relative TypeScript modules as the bundler does', () => {
    expect(resolveModule(read, 'apps/web/src/main.tsx', './app/app')).toBe(
      'apps/web/src/app/app.tsx',
    )
    expect(resolveModule(read, 'apps/web/src/app/app.tsx', '../lib')).toBe(
      'apps/web/src/lib/index.ts',
    )
    expect(resolveModule(read, 'apps/web/src/main.tsx', '@fxm/core')).toBeUndefined()
    expect(resolveModule(read, 'apps/web/src/main.tsx', './styles/index.css')).toBeUndefined()
  })
})

describe('firstLoadModules', () => {
  it('follows static imports from the entry', () => {
    expect(firstLoadModules(read)).toEqual([
      'apps/web/src/app/app.tsx',
      'apps/web/src/lib/index.ts',
      'apps/web/src/lib/y.ts',
      'apps/web/src/main.tsx',
    ])
    expect(() => firstLoadModules(read, 'apps/web/src/nope.ts')).toThrow('No module')
  })
})

const area = (name: string, findings: [file: string, text: string, error?: true][]): AreaCount => ({
  app: 'web',
  area: name,
  files: new Set(findings.map(([file]) => file)).size,
  counts: { text: findings.length, attribute: 0, code: 0, error: 0, resource: 0, document: 0 },
  messages: findings.length,
  words: 0,
  findings: findings.map(([file, text, error]) => ({
    category: error ? 'error' : 'text',
    text,
    line: 1,
    file,
  })),
})

describe('placement', () => {
  it('splits messages by the first load, and finds what a namespace per folder pulls in', () => {
    const counts = [
      area('features/library', [
        ['apps/web/src/features/library/format.ts', '{} songs'],
        ['apps/web/src/features/library/library-page.tsx', 'Your library'],
        ['apps/web/src/features/library/library-page.tsx', 'Could not read', true],
      ]),
      area('features/import', [['apps/web/src/features/import/import-page.tsx', 'Import songs']]),
      {
        ...area('pages/index.astro', [['apps/site/src/pages/index.astro', 'Hello there']]),
        app: 'site' as const,
      },
    ]
    const placed = placement(counts, ['apps/web/src/features/library/format.ts'])
    expect(placed.firstLoad.map((message) => message.text)).toEqual(['{} songs'])
    expect(placed.pulledIn.map((message) => message.text)).toEqual(['Your library'])
  })
})

describe('keyFor', () => {
  it('names a message after its first words', () => {
    expect(keyFor('Removed {} from <>the queue</>', 3)).toBe('removedFromThe')
    expect(keyFor('Couldn’t play “Creep”', 2)).toBe('couldntPlay')
    expect(keyFor('{} songs', 3)).toBe('songs')
    expect(keyFor('3 hours', 3)).toBe('message3Hours')
  })
})

describe('keyCost', () => {
  const message = (file: string, text: string, folder = 'features/library'): Message => ({
    area: folder,
    file,
    text,
  })
  const shown = [
    message('a.tsx', 'Your library is empty'),
    message('a.tsx', 'Add songs from search or import a playlist'),
    message('b.tsx', 'Remove from library'),
    message('b.tsx', 'Removed from your library'),
  ]
  const lazy = [
    message('page.tsx', 'Sort by date added, newest first'),
    message('page.tsx', 'Export your library as a backup file'),
  ]

  it('costs nothing without messages', () => {
    expect(keyCost([])).toBe(0)
  })

  it('costs more for keys than positions, and more again for a lazy page’s text', () => {
    const keys = keyCost(shown)
    expect(keys).toBeGreaterThan(0)
    expect(keyCost(shown, shown, 'positions')).toBeLessThan(keys)
    expect(keyCost(shown, [...shown, ...lazy])).toBeGreaterThan(keys + 20)
  })
})
