import { describe, expect, it } from 'vitest'
import { type AreaCount, areaOf, markdown, scanFile } from './inventory.ts'

describe('areaOf', () => {
  it.each([
    ['apps/web/src/features/library/library-page.tsx', 'web', 'features/library'],
    ['apps/web/src/features/library/ui/dialog.tsx', 'web', 'features/library'],
    ['apps/web/src/components/layout/top-bar.tsx', 'web', 'components/layout'],
    ['apps/web/src/embed/view.ts', 'web', 'embed'],
    ['apps/web/embed/main.ts', 'web', 'embed'],
    ['apps/web/src/main.tsx', 'web', 'app'],
    ['apps/web/src/app/errors.tsx', 'web', 'app'],
    ['apps/web/index.html', 'web', 'index.html'],
    ['apps/web/pwa/manifest.ts', 'web', 'pwa (manifest)'],
    ['apps/site/src/pages/privacy.astro', 'site', 'pages/privacy.astro'],
    ['apps/site/src/components/demos/FeedDemo.astro', 'site', 'components/FeedDemo.astro'],
    ['apps/site/src/lib/tiers.ts', 'site', 'lib/tiers.ts'],
    ['apps/extension/src/options/options.html', 'extension', 'options page'],
    ['apps/extension/src/manifest.ts', 'extension', 'manifest'],
    ['apps/extension/store/listing/description.md', 'extension', 'store listing'],
    ['apps/desktop/src-tauri/src/tray.rs', 'desktop', 'Rust shell'],
    ['apps/desktop/src-tauri/tauri.conf.json', 'desktop', 'installer text'],
    ['apps/mobile/android/fxm-http/src/main/res/values/strings.xml', 'mobile', 'Android resources'],
    [
      'apps/mobile/android/app/src/main/java/io/github/pratyayops/fxm/MainActivity.java',
      'mobile',
      'Kotlin and Java',
    ],
  ])('puts %s in %s %s', (path, app, area) => {
    expect(areaOf(path)).toEqual({ app, area })
  })

  it.each([
    'apps/web/src/features/library/library-page.test.tsx',
    'apps/web/src/features/search/fake-catalog.ts',
    'apps/web/src/features/search/dev-fakes.ts',
    'apps/web/src/features/home/testing.tsx',
    'apps/web/src/features/sync/testing/fake-github.ts',
    'apps/web/src/test/render.tsx',
    'apps/web/src/features/sync/README.md',
    'apps/web/e2e/smoke.spec.ts',
    'apps/web/sandbox/innertube.html',
    'apps/web/vite.config.ts',
    'apps/site/src/lib/build-check.ts',
    'apps/site/src/integrations/build-check.ts',
    'apps/extension/store/listing/reviewer-notes.txt',
    'apps/extension/store/amo.ts',
    'apps/desktop/smoke/steps.ts',
    'apps/mobile/android/fxm-http/src/test/kotlin/io/github/pratyayops/fxm/http/HostsTest.kt',
    'apps/web/node_modules/react/index.js',
  ])('leaves out %s', (path) => {
    expect(areaOf(path)).toBeUndefined()
  })
})

describe('scanFile', () => {
  it('reads each kind of file with its scanner', () => {
    expect(scanFile('a.tsx', '<p>Two words</p>').map((f) => f.category)).toEqual(['text'])
    expect(scanFile('a.astro', '<p>Two words</p>').map((f) => f.category)).toEqual(['text'])
    expect(scanFile('a.rs', 'const A: &str = "Two words";').map((f) => f.category)).toEqual([
      'code',
    ])
    expect(
      scanFile('apps/extension/store/listing/summary.txt', 'Two words').map((f) => f.category),
    ).toEqual(['document'])
    expect(scanFile('notes.md', 'Two words')).toEqual([])
    const config = JSON.stringify({
      productName: 'FXM',
      bundle: { shortDescription: 'A music player' },
    })
    expect(scanFile('apps/desktop/src-tauri/tauri.conf.json', config)).toEqual([
      { category: 'code', text: 'A music player', line: 1 },
    ])
  })
})

describe('markdown', () => {
  it('prints a table per app and the totals', () => {
    const entry = (
      app: AreaCount['app'],
      area: string,
      text: number,
      error: number,
    ): AreaCount => ({
      app,
      area,
      files: 1,
      counts: { text, attribute: 0, code: 0, error, resource: 0, document: 0 },
      messages: text,
      words: text * 3,
      findings: [],
    })
    const table = markdown([
      entry('web', 'features/home', 2, 1),
      entry('site', 'pages/404.astro', 1, 0),
    ])
    expect(table).toContain('### web')
    expect(table).toContain('| `features/home` | 1 | 2 | 0 | 0 | 1 | 0 | 2 | 6 |')
    expect(table).toContain('| **Total** | 2 | 3 | 0 | 0 | 1 | 0 | 3 | 9 |')
  })
})
