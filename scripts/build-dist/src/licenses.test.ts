import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { scanPage } from './html.ts'
import {
  addPackagesFromBanners,
  addPackagesFromInventory,
  addPackagesFromRegions,
  addPackagesFromSourceMaps,
  type BundledPackage,
  binaryProblems,
  bundlerRuntimeChunks,
  evaluateLicense,
  findInstalledPackage,
  findPackageFrom,
  inlineCodeProblems,
  isGplFamily,
  isWorkboxEntry,
  type LicenceTextReview,
  lgplProblems,
  licenceTextProblems,
  licenseOf,
  licenseProblems,
  MAX_INLINE_BYTES,
  needsLgpl,
  packageDirOf,
  parseLicenseExpression,
  REVIEWED_LICENCE_TEXTS,
  readInventory,
  regionPaths,
  renderNotices,
  repositoryLink,
  VIRTUAL_MODULES,
} from './licenses.ts'
import { installPackage, removeTempDirs, sourceMap, tempDir, writeFiles } from './testing.ts'

afterEach(removeTempDirs)

describe('evaluateLicense', () => {
  it.each([
    'MIT',
    'ISC',
    'Apache-2.0',
    'BSD-3-Clause',
    '0BSD',
    'LGPL-3.0-or-later',
    'LGPL-2.1-only',
    'MPL-2.0',
    '(MIT OR GPL-3.0)',
    'GPL-2.0 OR MIT',
    '(MIT OR Apache-2.0) AND CC0-1.0',
    'Apache-2.0 WITH LLVM-exception',
    'BlueOak-1.0.0',
    'mit',
    'Python-2.0',
    'OFL-1.1',
    '(MIT AND Zlib)',
  ])('accepts %s', (expression) => {
    expect(evaluateLicense(expression)).toEqual({ ok: true })
  })

  it.each([
    ['GPL-3.0', /GPL or AGPL/],
    ['GPL-2.0+', /GPL or AGPL/],
    ['GPL-3.0-or-later', /GPL or AGPL/],
    ['AGPL-3.0-only', /GPL or AGPL/],
    ['GPL-2.0-only WITH Classpath-exception-2.0', /GPL or AGPL/],
    ['MIT AND GPL-2.0', /GPL or AGPL/],
    ['(GPL-3.0 OR AGPL-3.0)', /GPL or AGPL/],
    // Spellings that aren't SPDX ids, but common in package.json files.
    ['GPLv3', /GPL or AGPL/],
    ['GPLv2', /GPL or AGPL/],
    ['AGPLv3', /GPL or AGPL/],
    ['GPL3', /GPL or AGPL/],
    ['GPLV2+', /GPL or AGPL/],
    ['GNU GPL v3', /GPL or AGPL/],
    // Everything outside the accepted list waits for a review.
    ['BSD', /not a licence FXM accepts .*LICENCE_OVERRIDES/],
    ['SSPL-1.0', /not a licence FXM accepts/],
    ['OSL-3.0', /not a licence FXM accepts/],
    ['EUPL-1.2', /not a licence FXM accepts/],
    ['BUSL-1.1', /not a licence FXM accepts/],
    ['CC-BY-NC-4.0', /not a licence FXM accepts/],
    ['MIT WITH Made-up-exception', /not a licence FXM accepts/],
    ['(SSPL-1.0 OR GPL-3.0)', /not a licence FXM accepts/],
    ['UNLICENSED', /not a licence FXM can ship/],
    ['SEE LICENSE IN LICENSE.md', /custom licence/],
    ['LicenseRef-Company-EULA', /custom licence/],
    ['MIT/X11', /not an SPDX expression/],
    ['Apache 2.0', /not an SPDX expression/],
    ['(MIT', /not an SPDX expression/],
  ])('refuses %s', (expression, reason) => {
    const verdict = evaluateLicense(expression)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.reason).toMatch(reason)
  })

  it('refuses a package without a licence', () => {
    expect(evaluateLicense(undefined)).toEqual({
      ok: false,
      reason: 'its package.json declares no licence',
    })
  })

  it('tells GPL from LGPL, in any spelling', () => {
    expect(isGplFamily('GPL-2.0')).toBe(true)
    expect(isGplFamily('AGPL-3.0')).toBe(true)
    expect(isGplFamily('GPLv3-ish')).toBe(true)
    expect(isGplFamily('agplv3')).toBe(true)
    expect(isGplFamily('LGPL-2.1')).toBe(false)
    expect(isGplFamily('LGPLv3')).toBe(false)
  })

  it('accepts any licence but GPL and AGPL once a human reviewed it', () => {
    expect(evaluateLicense('Artistic-2.0', { reviewed: true })).toEqual({ ok: true })
    expect(evaluateLicense('LicenseRef-Reviewed', { reviewed: true })).toEqual({ ok: true })
    expect(evaluateLicense('GPL-3.0-only', { reviewed: true })).toMatchObject({ ok: false })
    expect(evaluateLicense('UNLICENSED', { reviewed: true })).toMatchObject({ ok: false })
  })

  it('parses operators case-insensitively, with AND binding tighter than OR', () => {
    expect(parseLicenseExpression('MIT or Apache-2.0 and BSD-2-Clause')).toEqual({
      type: 'or',
      left: { type: 'license', id: 'MIT' },
      right: {
        type: 'and',
        left: { type: 'license', id: 'Apache-2.0' },
        right: { type: 'license', id: 'BSD-2-Clause' },
      },
    })
  })
})

describe('licenseOf', () => {
  it('reads the current field and the legacy forms', () => {
    expect(licenseOf({ license: 'MIT' })).toBe('MIT')
    expect(licenseOf({ license: { type: 'ISC' } })).toBe('ISC')
    expect(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT OR Apache-2.0)',
    )
    expect(licenseOf({ licenses: [{ type: 'BSD-2-Clause' }] })).toBe('BSD-2-Clause')
    expect(licenseOf({ licenses: { type: 'MIT' } })).toBe('MIT')
    expect(licenseOf({})).toBeUndefined()
    expect(licenseOf({ license: ' ' })).toBeUndefined()
  })

  it('reads a malformed field as no licence, so the check names the package', () => {
    expect(licenseOf({ license: 42 })).toBeUndefined()
    expect(licenseOf({ license: { type: ['MIT'] } })).toBeUndefined()
    expect(licenseOf({ licenses: ['MIT'] })).toBeUndefined()
    expect(licenseOf({ licenses: [{ type: 'MIT' }, { name: 'x' }] })).toBeUndefined()
    expect(licenseOf({ licenses: 'MIT' })).toBeUndefined()
  })
})

describe('packageDirOf', () => {
  it('finds the package a file belongs to, scoped and nested included', () => {
    const base = `${sep}repo${sep}node_modules${sep}`
    expect(
      packageDirOf(`${base}.pnpm${sep}react@19${sep}node_modules${sep}react${sep}index.js`),
    ).toBe(join(`${base}.pnpm`, 'react@19', 'node_modules', 'react'))
    expect(packageDirOf(`${base}@tanstack${sep}query-core${sep}build${sep}x.js`)).toBe(
      join(base, '@tanstack', 'query-core'),
    )
    expect(packageDirOf(`${base}a${sep}node_modules${sep}b${sep}c.js`)).toBe(
      join(base, 'a', 'node_modules', 'b'),
    )
    expect(packageDirOf(`${sep}repo${sep}src${sep}x.ts`)).toBeUndefined()
    expect(packageDirOf(`${base}@scope`)).toBeUndefined()
  })
})

describe('scanning a build', () => {
  it('lists the packages the source maps name, once each, with the parts using them', () => {
    const root = tempDir()
    const react = installPackage(root, { name: 'react', version: '19.0.0', license: 'MIT' })
    const scoped = installPackage(root, {
      name: '@tanstack/query-core',
      version: '5.0.0',
      license: 'MIT',
    })
    writeFiles(root, { 'apps/web/src/main.ts': '', 'apps/site/src/menu.ts': '' })
    const out = join(root, 'out')
    writeFiles(out, {
      ...sourceMap(out, 'app/a.js.map', [react, scoped, join(root, 'apps/web/src/main.ts')]),
      ...sourceMap(out, 'site/b.js.map', [
        react,
        `${join(root, 'apps/site/src/menu.ts')}?astro&type=script`,
      ]),
      'app/virtual.js.map': JSON.stringify({
        version: 3,
        sources: ['\u0000vite/preload-helper.js'],
        mappings: '',
      }),
    })
    const packages = new Map<string, BundledPackage>()
    const app = addPackagesFromSourceMaps(
      [join(out, 'app/a.js.map'), join(out, 'app/virtual.js.map')],
      'app',
      root,
      packages,
    )
    const site = addPackagesFromSourceMaps([join(out, 'site/b.js.map')], 'site', root, packages)
    // The bundler's own runtime needs no package.
    expect(app).toEqual({ generated: ['\u0000vite/preload-helper.js'], unknown: [] })
    expect(site).toEqual({ generated: [], unknown: [] })
    expect(
      [...packages.values()].map((pkg) => [
        pkg.name,
        pkg.version,
        pkg.license,
        [...pkg.usedIn].sort(),
        [...pkg.files],
      ]),
    ).toEqual([
      ['react', '19.0.0', 'MIT', ['app', 'site'], [react]],
      ['@tanstack/query-core', '5.0.0', 'MIT', ['app'], [scoped]],
    ])
  })

  it('maps a plugin’s virtual module to its package, and reports any other source as unknown', () => {
    const root = tempDir()
    // pnpm links a workspace package's dependencies into its own node_modules.
    writeFiles(root, {
      'apps/web/node_modules/vite-plugin-pwa/package.json': JSON.stringify({
        name: 'vite-plugin-pwa',
        version: '2.0.0',
        license: 'MIT',
      }),
      'apps/web/node_modules/vite-plugin-pwa/LICENSE': 'MIT License\n\nCopyright (c) Anthony Fu',
    })
    const out = join(root, 'apps/web/dist')
    const climb = relative(join(out, 'assets'), '/')
    writeFiles(out, {
      'assets/index.js.map': JSON.stringify({
        version: 3,
        sources: [
          `${climb}/@vite-plugin-pwa/virtual:pwa-register`,
          `${climb}/@some-plugin/virtual:client`,
          '../../src/deleted-since.ts',
        ],
        mappings: '',
      }),
    })
    const packages = new Map<string, BundledPackage>()
    const scan = addPackagesFromSourceMaps(
      [join(out, 'assets/index.js.map')],
      'app',
      root,
      packages,
    )
    expect(scan.generated).toEqual([`${climb}/@vite-plugin-pwa/virtual:pwa-register`])
    expect(scan.unknown).toEqual([
      `${climb}/@some-plugin/virtual:client`,
      '../../src/deleted-since.ts',
    ])
    expect([...packages.values()].map((pkg) => [pkg.name, pkg.license, [...pkg.usedIn]])).toEqual([
      ['vite-plugin-pwa', 'MIT', ['app']],
    ])
    expect(VIRTUAL_MODULES.map((module) => module.package)).toEqual(['vite-plugin-pwa'])
  })

  it('fails when a mapped virtual module’s package is not installed', () => {
    const root = tempDir()
    const out = join(root, 'out')
    writeFiles(out, {
      'a.js.map': JSON.stringify({
        version: 3,
        sources: [`${relative(out, '/')}/@vite-plugin-pwa/virtual:pwa-register`],
        mappings: '',
      }),
    })
    expect(() =>
      addPackagesFromSourceMaps([join(out, 'a.js.map')], 'app', root, new Map()),
    ).toThrow(/vite-plugin-pwa's code, but vite-plugin-pwa isn't installed for apps\/web/)
  })

  it('finds a package the way Node does, from a workspace package up to the root', () => {
    const root = tempDir()
    writeFiles(root, {
      'node_modules/hoisted/package.json': '{}',
      'apps/web/node_modules/own/package.json': '{}',
    })
    expect(findPackageFrom(root, 'apps/web', 'own')).toBe(join(root, 'apps/web/node_modules/own'))
    expect(findPackageFrom(root, 'apps/web', 'hoisted')).toBe(join(root, 'node_modules/hoisted'))
    expect(findPackageFrom(root, 'apps/web', 'missing')).toBeUndefined()
  })

  it('accepts Workbox’s generated service worker entry, and nothing that only looks like it', () => {
    const temporary = tempDir()
    const entry = join(temporary, 'f5655c8483f0da7eaf0390bd922862ab', 'sw.js')
    expect(isWorkboxEntry('/out/sw.js.map', entry, temporary)).toBe(true)
    expect(isWorkboxEntry('/out/assets/index.js.map', entry, temporary)).toBe(false)
    expect(isWorkboxEntry('/out/sw.js.map', join(temporary, 'not-hex', 'sw.js'), temporary)).toBe(
      false,
    )
    expect(
      isWorkboxEntry(
        '/out/sw.js.map',
        join('/elsewhere', 'f5655c8483f0da7eaf0390bd922862ab', 'sw.js'),
        temporary,
      ),
    ).toBe(false)

    const root = tempDir()
    const out = join(root, 'out')
    writeFiles(out, {
      'sw.js.map': JSON.stringify({ version: 3, sources: [relative(out, entry)], mappings: '' }),
    })
    expect(
      addPackagesFromSourceMaps([join(out, 'sw.js.map')], 'app', root, new Map(), { temporary }),
    ).toEqual({ generated: [relative(out, entry)], unknown: [] })
  })

  it('skips null sources, and names the files it cannot read', () => {
    const root = tempDir()
    const react = installPackage(root, { name: 'react', version: '19.0.0', license: 'MIT' })
    const out = join(root, 'out')
    writeFiles(out, {
      'a.js.map': JSON.stringify({
        version: 3,
        sources: [null, relative(join(root, 'src'), react)],
        sourceRoot: '../src',
        mappings: '',
      }),
      'b.js.map': JSON.stringify({ version: 3, mappings: '' }),
      'c.js.map': '{',
    })
    const packages = new Map<string, BundledPackage>()
    addPackagesFromSourceMaps([join(out, 'a.js.map')], 'app', root, packages)
    expect([...packages.values()].map((pkg) => pkg.name)).toEqual(['react'])
    expect(() => addPackagesFromSourceMaps([join(out, 'b.js.map')], 'app', root, packages)).toThrow(
      /b\.js\.map is not a source map with a sources list/,
    )
    expect(() => addPackagesFromSourceMaps([join(out, 'c.js.map')], 'app', root, packages)).toThrow(
      /c\.js\.map can't be read/,
    )
  })

  it('reads homepages and names defensively, naming a broken package.json', () => {
    const root = tempDir()
    const base = join(root, 'node_modules')
    writeFiles(base, {
      'odd/package.json': JSON.stringify({
        name: 'odd',
        version: '1.0.0',
        license: 'MIT',
        homepage: { url: 'x' },
        repository: { url: 'git+https://example.com/odd.git' },
      }),
      'odd/index.js': '',
      'list/package.json': '[]',
      'list/index.js': '',
      'nameless/package.json': JSON.stringify({ version: '1.0.0' }),
      'nameless/index.js': '',
    })
    writeFiles(root, {
      ...sourceMap(root, 'out/a.js.map', [join(base, 'odd/index.js')]),
      ...sourceMap(root, 'out/b.js.map', [join(base, 'list/index.js')]),
      ...sourceMap(root, 'out/c.js.map', [join(base, 'nameless/index.js')]),
    })
    const packages = new Map<string, BundledPackage>()
    addPackagesFromSourceMaps([join(root, 'out/a.js.map')], 'app', root, packages)
    expect([...packages.values()][0]?.homepage).toBe('https://example.com/odd')
    expect(() =>
      addPackagesFromSourceMaps([join(root, 'out/b.js.map')], 'app', root, packages),
    ).toThrow(/list[\\/]package\.json is not a JSON object/)
    expect(() =>
      addPackagesFromSourceMaps([join(root, 'out/c.js.map')], 'app', root, packages),
    ).toThrow(/nameless[\\/]package\.json has no name or version/)
  })

  it('fails when a mapped package folder has no package.json', () => {
    const root = tempDir()
    writeFiles(root, { 'node_modules/ghost/index.js': '' })
    writeFiles(root, sourceMap(root, 'out/a.js.map', [join(root, 'node_modules/ghost/index.js')]))
    expect(() =>
      addPackagesFromSourceMaps([join(root, 'out/a.js.map')], 'app', root, new Map()),
    ).toThrow(/has no package\.json/)
  })

  it('adds the packages named in stylesheet banners', () => {
    const root = tempDir()
    installPackage(root, { name: 'tailwindcss', version: '4.3.3', license: 'MIT' })
    writeFiles(root, {
      'out/a.css': '/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\nbody{}',
    })
    const packages = new Map<string, BundledPackage>()
    addPackagesFromBanners([join(root, 'out/a.css')], 'app', root, packages)
    expect([...packages.values()].map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'tailwindcss@4.3.3',
    ])
    writeFiles(root, { 'out/b.css': '/*! missing v1.0.0 | MIT */' })
    expect(() => addPackagesFromBanners([join(root, 'out/b.css')], 'app', root, packages)).toThrow(
      /not installed/,
    )
  })

  it('finds an installed version in pnpm’s layout, with or without a peer suffix', () => {
    const root = tempDir()
    writeFiles(root, {
      'node_modules/.pnpm/react-dom@19.0.0_react@19.0.0/node_modules/react-dom/package.json':
        JSON.stringify({
          name: 'react-dom',
          version: '19.0.0',
        }),
    })
    expect(findInstalledPackage(root, 'react-dom', '19.0.0')).toMatch(
      /react-dom@19\.0\.0_react@19\.0\.0/,
    )
    expect(findInstalledPackage(root, 'react-dom', '19.0.1')).toBeUndefined()
    expect(findInstalledPackage(root, 'react', '19.0.0')).toBeUndefined()
  })
})

describe('the bundle inventory', () => {
  it('adds the packages of stylesheets, assets and imports with a query, not plain scripts', () => {
    const root = tempDir()
    const css = installPackage(root, { name: 'nice-css', version: '1.0.0', license: 'MIT' })
    const font = installPackage(root, {
      name: '@fonts/inter',
      version: '5.0.0',
      license: 'OFL-1.1',
    })
    const wasm = installPackage(root, { name: 'codec', version: '2.0.0', license: 'Apache-2.0' })
    const script = installPackage(root, { name: 'script-only', version: '1.0.0', license: 'MIT' })
    const packages = new Map<string, BundledPackage>()
    const origins = addPackagesFromInventory(
      [
        {
          environment: 'client',
          modules: [
            css.replace(/index\.js$/, 'style.css'),
            script,
            `${wasm.replace(/index\.js$/, 'codec.wasm')}?url`,
            '\0virtual:module',
            join(root, 'apps/web/src/main.ts'),
          ],
          assets: [
            {
              fileName: 'assets/inter.woff2',
              sources: [font.replace(/index\.js$/, 'inter.woff2')],
            },
            { fileName: 'assets/codec.wasm', sources: [wasm.replace(/index\.js$/, 'codec.wasm')] },
            { fileName: 'assets/logo.svg', sources: [join(root, 'apps/web/src/logo.svg')] },
          ],
        },
      ],
      'app',
      packages,
    )
    expect([...packages.values()].map((pkg) => `${pkg.name} ${pkg.license}`).sort()).toEqual([
      '@fonts/inter OFL-1.1',
      'codec Apache-2.0',
      'nice-css MIT',
    ])
    expect(Object.fromEntries(origins)).toEqual({
      'assets/inter.woff2': 'package',
      'assets/codec.wasm': 'package',
      'assets/logo.svg': 'own',
    })
  })

  it('reads one entry per line and refuses anything else', () => {
    const dir = tempDir()
    const entry = { environment: 'client', modules: ['/a.css'], assets: [] }
    writeFiles(dir, {
      'ok.jsonl': `${JSON.stringify(entry)}\n${JSON.stringify({ ...entry, environment: 'ssr' })}\n`,
      'bad.jsonl': `${JSON.stringify({ environment: 'client', modules: [1], assets: [] })}\n`,
    })
    expect(readInventory(join(dir, 'ok.jsonl')).map((item) => item.environment)).toEqual([
      'client',
      'ssr',
    ])
    expect(readInventory(join(dir, 'missing.jsonl'))).toEqual([])
    expect(() => readInventory(join(dir, 'bad.jsonl'))).toThrow(/line 1: not an inventory entry/)
  })

  it("reads each chunk's modules, and finds the chunks that hold only the bundler's runtime", () => {
    const dir = tempDir()
    const chunks = [
      { fileName: 'assets/index.js', modules: ['/repo/apps/web/src/main.ts'] },
      { fileName: 'assets/rolldown-runtime.js', modules: ['\0rolldown/runtime.js'] },
      {
        fileName: 'assets/preload-helper.js',
        modules: ['\0vite/preload-helper.js', '\0vite/modulepreload-polyfill.js'],
      },
      { fileName: 'assets/empty.js', modules: [] },
    ]
    const entry = { environment: 'client', modules: [], assets: [], chunks }
    writeFiles(dir, {
      'ok.jsonl': `${JSON.stringify(entry)}\n`,
      'bad.jsonl': `${JSON.stringify({ ...entry, chunks: [{ fileName: 'a.js', modules: [1] }] })}\n`,
    })
    const entries = readInventory(join(dir, 'ok.jsonl'))
    expect(entries[0]?.chunks).toEqual(chunks)
    expect(Object.fromEntries(bundlerRuntimeChunks(entries))).toEqual({
      'assets/rolldown-runtime.js': ['\0rolldown/runtime.js'],
      'assets/preload-helper.js': ['\0vite/preload-helper.js', '\0vite/modulepreload-polyfill.js'],
    })
    expect(() => readInventory(join(dir, 'bad.jsonl'))).toThrow(/line 1: not an inventory entry/)
  })
})

describe('code without source maps', () => {
  it('refuses WebAssembly from no package unless its hash was reviewed', () => {
    const dir = tempDir()
    writeFiles(dir, { 'a.wasm': 'from a package', 'b.wasm': 'copied into public/', 'c.js': '' })
    const origins = new Map([['a.wasm', 'package' as const]])
    const hash = createHash('sha256').update('copied into public/').digest('hex')
    expect(binaryProblems('app', dir, ['a.wasm', 'b.wasm', 'c.js'], origins)).toEqual([
      `app ships b.wasm, WebAssembly from no npm package: review its licence and add its SHA-256 (${hash}) to REVIEWED_BINARIES in src/licenses.ts`,
    ])
    expect(binaryProblems('app', dir, ['b.wasm'], origins, { [hash]: {} })).toEqual([])
  })

  it('refuses inline code with licence notices, or as large as a bundle', () => {
    expect(
      inlineCodeProblems('sandbox', 'eval.html', "addEventListener('message', () => {})"),
    ).toEqual([])
    expect(inlineCodeProblems('sandbox', 'eval.html', '/*! lib v1.0.0 | MIT */ run()')[0]).toMatch(
      /inlines code with a licence notice \("\/\*!"\)/,
    )
    expect(inlineCodeProblems('sandbox', 'eval.html', '/** @license MIT */')[0]).toMatch(/@license/)
    expect(inlineCodeProblems('sandbox', 'eval.html', 'x'.repeat(MAX_INLINE_BYTES + 1))[0]).toMatch(
      /inlines 65537 bytes of code/,
    )
  })
})

describe('sandbox documents', () => {
  it('reads the module markers of an unminified bundle', () => {
    const script = [
      '(function() {',
      '//#region src/evaluator/messages.ts',
      '\tconst a = 1',
      '//#endregion',
      '\t//#region ../../node_modules/.pnpm/x@1.0.0/node_modules/x/dist/a.js  ',
      '})()',
    ].join('\n')
    expect(regionPaths(script)).toEqual([
      'src/evaluator/messages.ts',
      '../../node_modules/.pnpm/x@1.0.0/node_modules/x/dist/a.js',
    ])
  })

  it('attributes the packages their inline scripts bundle, and names markers it can’t find', () => {
    const root = tempDir()
    const main = installPackage(root, {
      name: 'bgutils-js',
      version: '4.0.3',
      license: 'MIT',
      files: { 'dist/core/BotGuardClient.js': '', LICENSE: 'MIT License' },
    })
    expect(main).toContain(join('node_modules', '.pnpm', 'bgutils-js@4.0.3'))
    const script = [
      '//#region src/evaluator/protocol.ts',
      '//#region ../../node_modules/.pnpm/bgutils-js@4.0.3/node_modules/bgutils-js/dist/core/BotGuardClient.js',
      '//#region ../../node_modules/.pnpm/gone@1.0.0/node_modules/gone/index.js',
    ].join('\n')
    const packages = new Map<string, BundledPackage>()
    expect(addPackagesFromRegions([script], 'sandbox', 'eval.html', root, packages)).toEqual([
      `sandbox: eval.html bundles ../../node_modules/.pnpm/gone@1.0.0/node_modules/gone/index.js, which make dist can't find in ${join(root, 'node_modules')}`,
    ])
    const [bgutils] = [...packages.values()]
    expect(bgutils?.name).toBe('bgutils-js')
    expect([...(bgutils?.usedIn ?? [])]).toEqual(['sandbox'])
    expect([...(bgutils?.files ?? [])]).toEqual([
      join(
        root,
        'node_modules/.pnpm/bgutils-js@4.0.3/node_modules/bgutils-js/dist/core/BotGuardClient.js',
      ),
    ])
  })

  it('finds bgutils-js in the evaluator document the repository ships', () => {
    // 1.11's eval.html has no source map: its bundler's region markers are all that shows the
    // packages in it. Built minified, it would keep none, and bgutils-js would silently drop out
    // of the notices while the document still passed inlineCodeProblems.
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const page = scanPage(readFileSync(join(root, 'apps/web/sandbox/eval.html'), 'utf8'))
    expect(page.inlineScripts).toHaveLength(1)
    const [script = ''] = page.inlineScripts
    expect(inlineCodeProblems('sandbox', 'eval.html', script)).toEqual([])
    const packages = new Map<string, BundledPackage>()
    expect(addPackagesFromRegions([script], 'sandbox', 'eval.html', root, packages)).toEqual([])
    expect([...packages.values()].map((pkg) => pkg.name)).toEqual(['bgutils-js'])
  })
})

/** A bundled package for the checks below, installed under root. */
function bundled(
  root: string,
  name: string,
  license: string | undefined,
  files: Record<string, string> = {},
  usedIn = ['app'],
): BundledPackage {
  const main = installPackage(root, {
    name,
    version: '1.0.0',
    ...(license ? { license } : {}),
    files,
  })
  const dir = join(main, '..')
  return {
    name,
    version: '1.0.0',
    dir,
    license,
    reviewed: false,
    homepage: `https://example.com/${name}`,
    usedIn: new Set(usedIn),
    files: new Set(Object.keys(files).map((file) => join(dir, file))),
  }
}

describe('licence texts', () => {
  /** A review of version 0.9.0, as REVIEWED_LICENCE_TEXTS records one. */
  const review = (fields: Partial<LicenceTextReview> = {}): LicenceTextReview => ({
    version: '0.9.0',
    expression: 'MIT OR Apache-2.0',
    license: 'Apache-2.0',
    notices: [],
    reason: 'test',
    ...fields,
  })

  it('needs a licence file, or a review naming a licence the package offers', () => {
    const root = tempDir()
    const packages = [
      bundled(root, 'with-licence', 'MIT', { LICENSE_MIT: 'MIT License' }),
      bundled(root, 'spdx-only', 'MIT OR Apache-2.0', {
        'LICENSE.spdx': 'PackageLicenseDeclared: MIT',
      }),
      bundled(root, 'reviewed', 'MIT OR Apache-2.0'),
      bundled(root, 'wrongly-reviewed', 'MIT'),
    ]
    expect(
      licenceTextProblems(packages, {
        reviewed: review(),
        'wrongly-reviewed': review({ expression: 'MIT' }),
      }),
    ).toEqual([
      'spdx-only@1.0.0 (in app) ships no licence text: check what covers it (its licence is MIT OR Apache-2.0) and record that in REVIEWED_LICENCE_TEXTS in src/licenses.ts',
      "wrongly-reviewed@1.0.0 (in app): REVIEWED_LICENCE_TEXTS names Apache-2.0, which its licence (MIT) doesn't offer",
    ])
  })

  it('takes a later version while the review’s facts hold, and asks again when one changes', () => {
    const root = tempDir()
    const google =
      '// Copyright 2008 Google Inc.  All rights reserved.\n//\n// Redistribution and use in source and binary forms, with or without\n// modification, are permitted provided that the following conditions are met.\nexport {}\n'
    const buf =
      '// Copyright 2021-2026 Buf Technologies, Inc.\n// Licensed under the Apache License, Version 2.0\nexport {}\n'
    const reviewedNotices = [
      'Copyright 2008 Google Inc.',
      'Redistribution and use in source and binary forms, with or without modification',
    ]
    const both = '(Apache-2.0 AND BSD-3-Clause)'
    const packages = [
      // Version 1.0.0 of a package reviewed in 0.9.0: the same licence, in another spelling.
      bundled(root, 'same', both, { 'wire/varint.js': google, 'index.js': buf }),
      bundled(root, 'relicensed', 'MIT', { 'index.js': buf }),
      bundled(root, 'lost-notice', both, { 'index.js': buf }),
    ]
    const reviews = {
      same: review({ expression: 'Apache-2.0 and BSD-3-Clause', notices: reviewedNotices }),
      relicensed: review(),
      'lost-notice': review({ expression: both, notices: reviewedNotices }),
    }
    const again =
      'check what covers it and update its entry in REVIEWED_LICENCE_TEXTS (src/licenses.ts)'
    expect(licenceTextProblems(packages, reviews)).toEqual([
      `relicensed@1.0.0 (in app): its licence is MIT, but REVIEWED_LICENCE_TEXTS reviewed MIT OR Apache-2.0 (version 0.9.0): ${again}`,
      `lost-notice@1.0.0 (in app): its files no longer say "Copyright 2008 Google Inc.", which the review of version 0.9.0 in REVIEWED_LICENCE_TEXTS relies on: ${again}`,
      `lost-notice@1.0.0 (in app): its files no longer say "Redistribution and use in source and binary forms, with or without modification", which the review of version 0.9.0 in REVIEWED_LICENCE_TEXTS relies on: ${again}`,
    ])
  })

  it('records what each reviewed package’s notices must keep saying', () => {
    for (const [name, entry] of Object.entries(REVIEWED_LICENCE_TEXTS)) {
      // Keyed by package name alone: a version bump with the same facts needs no new review.
      expect(name).toMatch(/^(?:@[\w.-]+\/)?[\w.-]+$/)
      expect(entry.notices.length, name).toBeGreaterThan(0)
      expect(() => parseLicenseExpression(entry.expression), name).not.toThrow()
    }
  })
})

describe('LGPL code', () => {
  it('needs the LGPL only when the licence leaves no other way', () => {
    expect(needsLgpl('LGPL-3.0-only')).toBe(true)
    expect(needsLgpl('LGPL-2.1-or-later')).toBe(true)
    expect(needsLgpl('MIT AND LGPL-2.1')).toBe(true)
    expect(needsLgpl('(MIT OR LGPL-3.0)')).toBe(false)
    expect(needsLgpl('MIT')).toBe(false)
    expect(needsLgpl(undefined)).toBe(false)
    expect(needsLgpl('Artistic-2.0 OR LGPL-3.0')).toBe(true)
    expect(needsLgpl('Artistic-2.0 OR LGPL-3.0', { reviewed: true })).toBe(false)
  })

  it('must sit in chunks of its own, next to the bundler’s runtime at most', () => {
    const root = tempDir()
    const lgpl = bundled(root, 'lgpl-lib', 'LGPL-3.0-only', {}, ['app', 'embed', 'sandbox'])
    const mit = bundled(root, 'mit-lib', 'MIT')
    const module = (pkg: BundledPackage) => join(pkg.dir, 'index.js')
    const chunks = {
      app: [
        { fileName: 'assets/lgpl-lib.js', modules: [module(lgpl), '\0rolldown/runtime.js'] },
        { fileName: 'assets/index.js', modules: [module(mit), join(root, 'apps/web/src/main.ts')] },
      ],
      embed: [
        {
          fileName: 'assets/index.js',
          modules: [`${module(lgpl)}?commonjs-es-import`, module(mit)],
        },
      ],
    }
    expect(lgplProblems([lgpl, mit], (part) => chunks[part as keyof typeof chunks])).toEqual([
      `lgpl-lib@1.0.0 (in embed) is under the LGPL, so it must sit in chunks of its own, but assets/index.js also holds 1 other module(s), such as ${module(mit)}: give it a chunk of its own (manualChunks)`,
      'lgpl-lib@1.0.0 (in sandbox) is under the LGPL, so it must sit in chunks of its own, but no chunk of the sandbox build shows where it is',
    ])
  })
})

describe('repository links', () => {
  it.each([
    ['jshttp/content-type', 'https://github.com/jshttp/content-type'],
    ['github:Borewit/music-metadata', 'https://github.com/Borewit/music-metadata'],
    ['gitlab:group/project', 'https://gitlab.com/group/project'],
    ['bitbucket:team/repo', 'https://bitbucket.org/team/repo'],
    ['gist:11081aaa281', 'https://gist.github.com/11081aaa281'],
    ['git://github.com/feross/ieee754.git', 'https://github.com/feross/ieee754'],
    ['git+https://github.com/debug-js/debug.git', 'https://github.com/debug-js/debug'],
    ['git+ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo'],
    [
      'https://github.com/tauri-apps/plugins-workspace',
      'https://github.com/tauri-apps/plugins-workspace',
    ],
    ['https://example.com/project/', 'https://example.com/project'],
    ['not a url', 'not a url'],
  ])('turns %s into %s', (repository, link) => {
    expect(repositoryLink(repository)).toBe(link)
  })

  it('links a package that has no homepage to its repository', () => {
    const root = tempDir()
    writeFiles(root, {
      'node_modules/ms/package.json': JSON.stringify({
        name: 'ms',
        version: '2.1.3',
        license: 'MIT',
        repository: 'vercel/ms',
      }),
      'node_modules/ms/index.js': '',
    })
    writeFiles(root, sourceMap(root, 'out/a.js.map', [join(root, 'node_modules/ms/index.js')]))
    const packages = new Map<string, BundledPackage>()
    addPackagesFromSourceMaps([join(root, 'out/a.js.map')], 'app', root, packages)
    expect([...packages.values()][0]?.homepage).toBe('https://github.com/vercel/ms')
  })
})

describe('licence problems and notices', () => {
  function packages(root: string): BundledPackage[] {
    return [
      bundled(root, 'zeta', 'MIT', { LICENSE: 'MIT License\n\nCopyright (c) Zeta' }),
      bundled(root, 'alpha', 'Apache-2.0', {
        'LICENSE.txt': 'Apache License',
        NOTICE: 'Alpha notice',
      }),
      bundled(
        root,
        'mixed',
        'MIT',
        {
          'LICENSE-MIT': 'MIT License\n\nCopyright (c) Mixed Authors',
          // Its own header adds nothing; the code it took from elsewhere keeps its notice.
          'index.js': '// Copyright 2020 Mixed Authors\nexport {}\n',
          'vendor/varint.js':
            '// Copyright 2008 Google Inc.  All rights reserved.\n// Redistribution and use in source and binary forms…\nexport {}\n',
        },
        ['app', 'sandbox'],
      ),
      bundled(root, 'bare', 'MIT OR Apache-2.0', {
        'LICENSE.spdx': 'PackageLicenseDeclared: MIT',
        'index.js':
          "import { x } from './x.js';\n// Copyright 2019 Bare Contributors\n// SPDX-License-Identifier: MIT\n",
      }),
    ]
  }

  const options = {
    repositoryUrl: 'https://github.com/Pratyay-ops/FXM',
    apacheLicense: () => '  Apache License\n  Version 2.0, January 2004  ',
    reviewed: {
      bare: {
        version: '1.0.0',
        expression: 'MIT OR Apache-2.0',
        license: 'Apache-2.0',
        notices: ['Copyright 2019 Bare Contributors'],
        reason: 'test',
      },
    },
  } as const

  it('lists only the packages FXM may not ship', () => {
    const root = tempDir()
    const gpl = { ...(packages(root)[0] as BundledPackage), name: 'copyleft', license: 'GPL-3.0' }
    expect(licenseProblems([...packages(root), gpl])).toEqual([
      'copyleft@1.0.0 (in app): GPL-3.0 is GPL or AGPL, which FXM must not ship (ARCHITECTURE.md §17)',
    ])
  })

  it('writes every package with its licence files and its files’ notices, sorted by name', () => {
    const root = tempDir()
    const text = renderNotices(packages(root), options)
    expect(text).toContain(
      'FXM is open source under the Apache License 2.0: https://github.com/Pratyay-ops/FXM\nIts web app and sandbox documents include code from the open-source packages below, each under its own licence.',
    )
    expect(text.indexOf('alpha 1.0.0')).toBeLessThan(text.indexOf('bare 1.0.0'))
    expect(text.indexOf('mixed 1.0.0')).toBeLessThan(text.indexOf('zeta 1.0.0'))
    expect(text).toContain(
      'alpha 1.0.0\nLicence: Apache-2.0\nUsed in: app\nhttps://example.com/alpha',
    )
    expect(text).toContain('--- LICENSE.txt\n\nApache License\n\n--- NOTICE\n\nAlpha notice')
    expect(text).toContain('MIT License\n\nCopyright (c) Zeta')
    expect(text).toContain(
      'mixed 1.0.0\nLicence: MIT\nUsed in: app, sandbox\nhttps://example.com/mixed\n\nMIT License\n\nCopyright (c) Mixed Authors\n\n--- Notices in its files\n\nCopyright 2008 Google Inc.  All rights reserved.\nRedistribution and use in source and binary forms…\n\n====',
    )
    // No licence text of its own: the reviewed licence, whose text ends the file, and its notices.
    expect(text).toContain(
      'bare 1.0.0\nLicence: MIT OR Apache-2.0\nUsed in: app\nhttps://example.com/bare\n\nThe package ships no licence text. FXM uses it under the Apache License 2.0, whose text ends this file, with the notices of its files below.\n\n--- Notices in its files\n\nCopyright 2019 Bare Contributors\nSPDX-License-Identifier: MIT\n',
    )
    expect(text).not.toContain('PackageLicenseDeclared')
    expect(
      text.endsWith('The Apache License 2.0\n\nApache License\n  Version 2.0, January 2004\n'),
    ).toBe(true)
  })

  it('names only the parts that hold packages, and adds no licence nobody needs', () => {
    const root = tempDir()
    const [zeta] = packages(root)
    const embedded = { ...(zeta as BundledPackage), usedIn: new Set(['embed', 'site']) }
    const text = renderNotices([embedded], options)
    expect(text).toContain('Its website and embeddable player include code from')
    expect(text).not.toContain('The Apache License 2.0\n\n')
  })

  it('says so when nothing third-party is bundled', () => {
    expect(renderNotices([], options)).toContain('This build includes no third-party packages.')
  })
})
