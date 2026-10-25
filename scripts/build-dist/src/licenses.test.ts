import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addPackagesFromBanners,
  addPackagesFromInventory,
  addPackagesFromSourceMaps,
  type BundledPackage,
  binaryProblems,
  evaluateLicense,
  findInstalledPackage,
  inlineCodeProblems,
  isGplFamily,
  licenseOf,
  licenseProblems,
  MAX_INLINE_BYTES,
  packageDirOf,
  parseLicenseExpression,
  readInventory,
  renderNotices,
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
    const unattributed = [
      ...addPackagesFromSourceMaps(
        [join(out, 'app/a.js.map'), join(out, 'app/virtual.js.map')],
        'app',
        root,
        packages,
      ),
      ...addPackagesFromSourceMaps([join(out, 'site/b.js.map')], 'site', root, packages),
    ]
    expect(unattributed).toEqual(['\u0000vite/preload-helper.js'])
    expect(
      [...packages.values()].map((pkg) => [
        pkg.name,
        pkg.version,
        pkg.license,
        [...pkg.usedIn].sort(),
      ]),
    ).toEqual([
      ['react', '19.0.0', 'MIT', ['app', 'site']],
      ['@tanstack/query-core', '5.0.0', 'MIT', ['app']],
    ])
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

describe('licence problems and notices', () => {
  function packages(root: string): BundledPackage[] {
    const make = (name: string, license: string | undefined, files: Record<string, string>) => {
      const main = installPackage(root, {
        name,
        version: '1.0.0',
        ...(license ? { license } : {}),
        files,
      })
      return {
        name,
        version: '1.0.0',
        dir: join(main, '..'),
        license,
        reviewed: false,
        homepage: `https://example.com/${name}`,
        usedIn: new Set(['app']),
      }
    }
    return [
      make('zeta', 'MIT', { LICENSE: 'MIT License\n\nCopyright (c) Zeta' }),
      make('alpha', 'Apache-2.0', { 'LICENSE.txt': 'Apache License', NOTICE: 'Alpha notice' }),
      make('bare', 'ISC', {}),
    ]
  }

  it('lists only the packages FXM may not ship', () => {
    const root = tempDir()
    const gpl = { ...(packages(root)[0] as BundledPackage), name: 'copyleft', license: 'GPL-3.0' }
    expect(licenseProblems([...packages(root), gpl])).toEqual([
      'copyleft@1.0.0 (in app): GPL-3.0 is GPL or AGPL, which FXM must not ship (ARCHITECTURE.md §17)',
    ])
  })

  it('writes every package with its licence files, sorted by name', () => {
    const root = tempDir()
    const text = renderNotices(packages(root), 'https://github.com/Pratyay-ops/FXM')
    expect(text).toContain(
      'FXM is open source under the Apache License 2.0: https://github.com/Pratyay-ops/FXM',
    )
    expect(text.indexOf('alpha 1.0.0')).toBeLessThan(text.indexOf('bare 1.0.0'))
    expect(text.indexOf('bare 1.0.0')).toBeLessThan(text.indexOf('zeta 1.0.0'))
    expect(text).toContain(
      'alpha 1.0.0\nLicence: Apache-2.0\nUsed in: app\nhttps://example.com/alpha',
    )
    expect(text).toContain('--- LICENSE.txt\n\nApache License\n\n--- NOTICE\n\nAlpha notice')
    expect(text).toContain('The package ships no licence file; its package.json says ISC.')
    expect(text).toContain('MIT License\n\nCopyright (c) Zeta')
  })

  it('says so when nothing third-party is bundled', () => {
    expect(renderNotices([], 'https://x')).toContain('This build includes no third-party packages.')
  })
})
