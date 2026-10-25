import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addPackagesFromBanners,
  addPackagesFromSourceMaps,
  type BundledPackage,
  evaluateLicense,
  findInstalledPackage,
  isGplFamily,
  licenseOf,
  licenseProblems,
  packageDirOf,
  parseLicenseExpression,
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

  it('tells GPL from LGPL', () => {
    expect(isGplFamily('GPL-2.0')).toBe(true)
    expect(isGplFamily('AGPL-3.0')).toBe(true)
    expect(isGplFamily('LGPL-2.1')).toBe(false)
    expect(isGplFamily('GPLv3-ish')).toBe(false)
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
  it('reads the current field and both legacy forms', () => {
    expect(licenseOf({ license: 'MIT' })).toBe('MIT')
    expect(licenseOf({ license: { type: 'ISC' } })).toBe('ISC')
    expect(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT OR Apache-2.0)',
    )
    expect(licenseOf({ licenses: [{ type: 'BSD-2-Clause' }] })).toBe('BSD-2-Clause')
    expect(licenseOf({})).toBeUndefined()
    expect(licenseOf({ license: ' ' })).toBeUndefined()
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
