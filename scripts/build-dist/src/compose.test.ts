import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pageRevision } from '../../../apps/web/pwa/host.ts'
import { compose, DistError, NOTICES_FILE } from './compose.ts'
import { metaPolicyOf, serializePolicy, sha256Source } from './csp.ts'
import { parseHeaders } from './headers-file.ts'
import { embedPart, sandboxPart } from './later-stages.ts'
import { type InventoryEntry, readInventory } from './licenses.ts'
import type { Part } from './parts.ts'
import { appPolicy, SANDBOX_DOCUMENTS } from './policies.ts'
import { listFiles } from './rules.ts'
import {
  APP_THEME_SCRIPT,
  absentPart,
  bundle,
  type FakePackage,
  fakeAppPart,
  fakeEmbedPart,
  fakePart,
  fakeSandboxPart,
  fakeSitePart,
  installPackage,
  privacyPage,
  removeTempDirs,
  sandboxDocument,
  sandboxScript,
  tempDir,
  writeFiles,
} from './testing.ts'

afterEach(removeTempDirs)

const MIT = (name: string): FakePackage => ({
  name,
  version: '1.0.0',
  license: 'MIT',
  files: { LICENSE: `${name} licence` },
})

function run(root: string, parts: readonly Part[], inventoryDir?: string) {
  const logs: string[] = []
  const outDir = join(root, 'dist/pages')
  const result = compose({
    root,
    parts,
    stagingDir: join(root, 'dist/.staging'),
    outDir,
    ...(inventoryDir === undefined ? {} : { inventoryDir }),
    run: () => {
      throw new Error('fake parts run no commands')
    },
    log: (message) => logs.push(message),
    repositoryUrl: 'https://github.com/Pratyay-ops/FXM',
  })
  return { result, logs, outDir }
}

function problemsOf(action: () => unknown): readonly string[] {
  try {
    action()
  } catch (error) {
    if (error instanceof DistError) return error.problems
    throw error
  }
  throw new Error('expected a DistError')
}

describe('compose', () => {
  it('composes every part under its path, with headers, notices and the app fallback', () => {
    const root = tempDir()
    const { result, outDir } = run(root, [
      fakeSitePart(root),
      fakeAppPart(root, { packages: [MIT('react')], cssPackage: MIT('tailwindcss') }),
      fakeEmbedPart(root, [MIT('react'), MIT('preact-ish')]),
      fakeSandboxPart(),
    ])
    expect(result.built).toEqual(['site', 'app', 'embed', 'sandbox'])
    expect(listFiles(outDir)).toEqual([
      '.well-known/security.txt',
      '404.html',
      '_astro/site.css',
      '_headers',
      'app/404.html',
      'app/assets/index.css',
      'app/assets/index.js',
      'app/index.html',
      'embed/404.html',
      'embed/assets/index.css',
      'embed/assets/index.js',
      'embed/index.html',
      'index.html',
      'privacy.html',
      'robots.txt',
      'sandbox/eval.html',
      'sandbox/innertube.html',
      'sandbox/userhost.html',
      NOTICES_FILE,
    ])
    // The single-page apps answer their client-side routes with their own shell.
    expect(readFileSync(join(outDir, 'app/404.html'), 'utf8')).toBe(
      readFileSync(join(outDir, 'app/index.html'), 'utf8'),
    )
    expect(existsSync(join(root, 'dist/.staging'))).toBe(false)

    const { rules, invalid } = parseHeaders(readFileSync(join(outDir, '_headers'), 'utf8'))
    expect(invalid).toEqual([])
    const policy = (path: string) =>
      rules.find((rule) => rule.path === path)?.headers.get('content-security-policy')
    expect(policy('/app/*')).toBe(serializePolicy(appPolicy([sha256Source(APP_THEME_SCRIPT)])))
    expect(policy('/embed/*')).toBe(
      serializePolicy(appPolicy([sha256Source(APP_THEME_SCRIPT)], { embeddable: true })),
    )
    expect(policy('/.well-known/*')).toMatch(/^default-src 'none'/)
    for (const name of ['innertube', 'userhost', 'eval'] as const) {
      expect(policy(`/sandbox/${name}`)).toBe(policy(`/sandbox/${name}.html`))
      expect(policy(`/sandbox/${name}`)).toBe(
        serializePolicy(
          SANDBOX_DOCUMENTS[`${name}.html`]([sha256Source(sandboxScript(`${name}.html`))]),
        ),
      )
    }

    // Every page and app document carries its policy in a meta element too, sandbox documents
    // their own.
    expect(readFileSync(join(outDir, 'app/index.html'), 'utf8')).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="${metaPolicyOf(policy('/app/*') as string)}"><meta name="referrer" content="no-referrer"><title>`,
    )
    expect(readFileSync(join(outDir, 'app/404.html'), 'utf8')).toBe(
      readFileSync(join(outDir, 'app/index.html'), 'utf8'),
    )
    expect(readFileSync(join(outDir, 'privacy.html'), 'utf8')).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${metaPolicyOf(policy('/privacy') as string)}">`,
    )
    expect(readFileSync(join(outDir, 'sandbox/eval.html'), 'utf8')).toBe(
      sandboxDocument('eval.html'),
    )

    const notices = readFileSync(join(outDir, NOTICES_FILE), 'utf8')
    expect(notices).toContain('react 1.0.0\nLicence: MIT\nUsed in: app, embed')
    expect(notices).toContain('tailwindcss 1.0.0\nLicence: MIT\nUsed in: app')
    expect(notices).toContain('preact-ish licence')
    expect(result.packages.map((pkg) => pkg.name).sort()).toEqual([
      'preact-ish',
      'react',
      'tailwindcss',
    ])
  })

  it("revisions the page in the app's service worker from the deployed page and rule", () => {
    const root = tempDir()
    const { outDir, logs } = run(root, [
      fakeSitePart(root),
      fakeAppPart(root, { serviceWorker: true }),
    ])
    const { rules } = parseHeaders(readFileSync(join(outDir, '_headers'), 'utf8'))
    const app = rules.find((rule) => rule.path === '/app/*')
    const page = readFileSync(join(outDir, 'app/index.html'), 'utf8')
    const revision = pageRevision(page, Object.fromEntries(app?.headers ?? []))
    // The final page: make dist added its policy's meta elements.
    expect(page).toContain('<meta http-equiv="Content-Security-Policy"')
    expect(readFileSync(join(outDir, 'app/sw.js'), 'utf8')).toContain(
      `{url:"index.html",revision:"${revision}"}`,
    )
    expect(logs).toContain(`app/sw.js: the page's precache revision is ${revision}`)
  })

  it('skips the parts later stages add, and builds without them', () => {
    const root = tempDir()
    const { result, logs, outDir } = run(root, [
      fakeSitePart(root),
      fakeAppPart(root),
      embedPart,
      absentPart({ name: 'sandbox', mount: 'sandbox' }),
    ])
    expect(result.skipped).toEqual(['embed', 'sandbox'])
    expect(logs).toContain('embed: not built yet (a later stage adds it), skipped')
    expect(existsSync(join(outDir, 'embed'))).toBe(false)
    expect(readFileSync(join(outDir, '_headers'), 'utf8')).not.toMatch(/\/embed\/|\/sandbox\//)
  })

  it('copies the sandbox documents from apps/web/sandbox once 1.10 adds them', () => {
    const root = tempDir()
    writeFiles(root, {
      'apps/web/sandbox/innertube.html': sandboxDocument('innertube.html'),
      'apps/web/sandbox/notes.md': 'not a document',
    })
    const { outDir } = run(root, [fakeSitePart(root), fakeAppPart(root), sandboxPart])
    expect(listFiles(join(outDir, 'sandbox'))).toEqual(['innertube.html'])
  })

  it('refuses a GPL package anywhere in the build, before writing anything', () => {
    const root = tempDir()
    writeFiles(root, { 'dist/pages/index.html': 'the last good build' })
    const problems = problemsOf(() =>
      run(root, [
        fakeSitePart(root),
        fakeAppPart(root, {
          packages: [
            {
              name: 'copyleft',
              version: '2.0.0',
              license: 'GPL-3.0-only',
              files: { COPYING: 'GNU GENERAL PUBLIC LICENSE' },
            },
          ],
        }),
      ]),
    )
    expect(problems).toEqual([
      'copyleft@2.0.0 (in app): GPL-3.0-only is GPL or AGPL, which FXM must not ship (ARCHITECTURE.md §17)',
    ])
    expect(readFileSync(join(root, 'dist/pages/index.html'), 'utf8')).toBe('the last good build')
  })

  it('refuses JavaScript whose packages it cannot see', () => {
    const root = tempDir()
    const noMaps = fakePart({ name: 'embed', mount: 'embed', spa: true }, () => ({
      'index.html': '<!doctype html><title>e</title>',
      'assets/e.js': 'x',
    }))
    const sandbox = fakePart({ name: 'sandbox', mount: 'sandbox', sourceMaps: false }, () => ({
      'helper.js': 'x',
    }))
    expect(
      problemsOf(() => run(root, [fakeSitePart(root), fakeAppPart(root), noMaps, sandbox])),
    ).toEqual([
      'embed: assets/e.js has no source map, so its packages are unknown',
      'sandbox ships helper.js, but builds no source maps to show which packages it contains',
    ])
  })

  it("ships a chunk without a source map only when it holds just the bundler's runtime", () => {
    const appWith = (root: string, chunks: Record<string, readonly string[]>) => {
      writeFiles(root, { 'apps/web/src/app.ts': 'export {}\n' })
      return fakePart(
        { name: 'app', mount: 'app', spa: true, required: true },
        (outDir) => ({
          'index.html':
            '<!doctype html><html><head><title>a</title></head><body><h1>a</h1></body></html>',
          ...bundle(outDir, 'assets/index.js', [join(root, 'apps/web/src/app.ts')]),
          ...Object.fromEntries(Object.keys(chunks).map((file) => [file, 'export {}\n'])),
        }),
        () => [
          {
            environment: 'client',
            modules: [],
            assets: [],
            chunks: Object.entries(chunks).map(([fileName, modules]) => ({ fileName, modules })),
          },
        ],
      )
    }
    const root = tempDir()
    const { logs } = run(root, [
      fakeSitePart(root),
      appWith(root, {
        'assets/rolldown-runtime.js': ['\0rolldown/runtime.js'],
        'assets/preload-helper.js': ['\0vite/preload-helper.js'],
      }),
    ])
    expect(logs).toContain(
      "app: assets/rolldown-runtime.js holds only the bundler's runtime (rolldown/runtime.js)",
    )
    expect(logs).toContain(
      "app: assets/preload-helper.js holds only the bundler's runtime (vite/preload-helper.js)",
    )

    const other = tempDir()
    expect(
      problemsOf(() =>
        run(other, [
          fakeSitePart(other),
          appWith(other, {
            'assets/mixed.js': ['\0vite/preload-helper.js', join(other, 'apps/web/src/app.ts')],
            'assets/virtual.js': ['\0virtual:some-plugin'],
          }),
        ]),
      ),
    ).toEqual([
      'app: assets/mixed.js has no source map, so its packages are unknown',
      'app: assets/virtual.js has no source map, so its packages are unknown',
    ])
  })

  it('lists the packages a build takes stylesheets and assets from, from its inventory', () => {
    const root = tempDir()
    const fonts = installPackage(root, {
      name: 'fonts',
      version: '1.0.0',
      license: 'OFL-1.1',
      files: { 'OFL.txt': 'SIL Open Font License', LICENSE: 'OFL' },
    })
    const codec = installPackage(root, {
      name: 'codec',
      version: '2.0.0',
      license: 'GPL-2.0',
      files: { COPYING: 'GPL' },
    })
    const app = fakePart(
      { name: 'app', mount: 'app', spa: true, required: true },
      (outDir) => ({
        'index.html': '<!doctype html><title>a</title><h1>a</h1>',
        ...bundle(outDir, 'assets/index.js', [join(root, 'apps/web/src/app.ts')]),
        'assets/font.woff2': 'font',
        'assets/codec.wasm': 'codec',
        'assets/own.wasm': 'own',
      }),
      () => [
        {
          environment: 'client',
          modules: [fonts.replace(/index\.js$/, 'font.css')],
          assets: [
            { fileName: 'assets/font.woff2', sources: [fonts.replace(/index\.js$/, 'font.woff2')] },
            { fileName: 'assets/codec.wasm', sources: [codec.replace(/index\.js$/, 'codec.wasm')] },
            { fileName: 'assets/own.wasm', sources: [join(root, 'apps/web/public/own.wasm')] },
          ],
        },
      ],
    )
    writeFiles(root, { 'apps/web/src/app.ts': 'export {}\n' })
    const problems = problemsOf(() => run(root, [fakeSitePart(root), app]))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/^app ships assets\/own\.wasm, WebAssembly from no npm package/)
    expect(problems[1]).toBe(
      'codec@2.0.0 (in app): GPL-2.0 is GPL or AGPL, which FXM must not ship (ARCHITECTURE.md §17)',
    )
  })

  it('keeps the inventories beside the output, for the performance budgets, never in it', () => {
    const root = tempDir()
    const own = join(root, 'apps/web/src/app.ts')
    const entry: InventoryEntry = {
      environment: 'client',
      modules: [own],
      assets: [],
      chunks: [{ fileName: 'assets/index.js', modules: [own], dynamicImports: ['assets/page.js'] }],
    }
    const app = fakePart(
      { name: 'app', mount: 'app', spa: true, required: true },
      (outDir) => ({
        'index.html': '<!doctype html><html><head><title>a</title></head><body></body></html>',
        ...bundle(outDir, 'assets/index.js', [own]),
      }),
      () => [entry],
    )
    writeFiles(root, { 'apps/web/src/app.ts': 'export {}\n', 'dist/inventory/old.jsonl': '{}\n' })
    const inventoryDir = join(root, 'dist/inventory')
    const { outDir } = run(root, [fakeSitePart(root), app], inventoryDir)

    // This build's inventories replace the last build's.
    expect(readInventory(join(inventoryDir, 'app.jsonl'))).toEqual([entry])
    expect(existsSync(join(inventoryDir, 'old.jsonl'))).toBe(false)
    expect(listFiles(outDir).filter((file) => file.endsWith('.jsonl'))).toEqual([])
    expect(existsSync(join(root, 'dist/.staging'))).toBe(false)
  })

  it('refuses code that is neither FXM’s own nor a package’s, such as an unmapped virtual module', () => {
    const root = tempDir()
    writeFiles(root, { 'apps/web/src/app.ts': 'export {}\n' })
    const app = fakePart({ name: 'app', mount: 'app', spa: true, required: true }, (outDir) => ({
      'index.html': '<!doctype html><title>a</title><h1>a</h1>',
      'assets/index.js': 'x',
      'assets/index.js.map': JSON.stringify({
        version: 3,
        sources: [
          relative(join(outDir, 'assets'), join(root, 'apps/web/src/app.ts')),
          `${relative(join(outDir, 'assets'), '/')}/@x/virtual:client`,
        ],
        mappings: '',
      }),
    }))
    expect(problemsOf(() => run(root, [fakeSitePart(root), app]))).toEqual([
      expect.stringMatching(
        /^app ships code from .*\/@x\/virtual:client, which is neither FXM's own file nor in node_modules: .*VIRTUAL_MODULES/,
      ),
    ])
  })

  it('refuses LGPL code that shares a chunk with other code, in the app or in a worker', () => {
    const appWith = (root: string, workerModules: (lgpl: string) => readonly string[]) => {
      writeFiles(root, {
        'apps/web/src/app.ts': 'export {}\n',
        'apps/web/src/worker.ts': 'export {}\n',
      })
      const lgpl = installPackage(root, {
        name: 'lgpl-lib',
        version: '1.0.0',
        license: 'LGPL-3.0-only',
        files: { COPYING: 'GNU Lesser General Public License' },
      })
      return fakePart(
        { name: 'app', mount: 'app', spa: true, required: true },
        (outDir) => ({
          'index.html':
            '<!doctype html><html><head><title>a</title></head><body><h1>a</h1></body></html>',
          ...bundle(outDir, 'assets/index.js', [join(root, 'apps/web/src/app.ts')]),
          ...bundle(outDir, 'assets/lgpl-lib.js', [lgpl]),
          ...bundle(outDir, 'assets/worker.js', workerModules(lgpl)),
        }),
        () => [
          {
            environment: 'client',
            modules: [],
            assets: [],
            chunks: [
              { fileName: 'assets/index.js', modules: [join(root, 'apps/web/src/app.ts')] },
              { fileName: 'assets/lgpl-lib.js', modules: [lgpl, '\0rolldown/runtime.js'] },
            ],
          },
          // What bundle-inventory.ts records for the app's worker (dist-configs.ts).
          {
            environment: 'worker',
            modules: [],
            assets: [],
            chunks: [{ fileName: 'assets/worker.js', modules: workerModules(lgpl) }],
          },
        ],
      )
    }
    const root = tempDir()
    const worker = join(root, 'apps/web/src/worker.ts')
    expect(
      problemsOf(() => run(root, [fakeSitePart(root), appWith(root, (lgpl) => [worker, lgpl])])),
    ).toEqual([
      `lgpl-lib@1.0.0 (in app) is under the LGPL, so it must sit in chunks of its own, but assets/worker.js also holds 1 other module(s), such as ${worker}: give it a chunk of its own (manualChunks)`,
    ])

    // A worker that holds the library alone, as its own chunk, passes.
    const other = tempDir()
    const { result } = run(other, [fakeSitePart(other), appWith(other, (lgpl) => [lgpl])])
    expect(result.packages.map((pkg) => pkg.name)).toEqual(['lgpl-lib'])
  })

  it('attributes the packages the sandbox documents bundle, and names the parts holding them', () => {
    const root = tempDir()
    installPackage(root, {
      name: 'bgutils-js',
      version: '4.0.3',
      license: 'MIT',
      files: { LICENSE: 'MIT License\n\nCopyright (c) LuanRT', 'dist/core/BotGuardClient.js': '' },
    })
    const script = [
      sandboxScript('eval.html'),
      '//#region ../../node_modules/.pnpm/bgutils-js@4.0.3/node_modules/bgutils-js/dist/core/BotGuardClient.js',
      '//#endregion',
    ].join('\n')
    const sandbox = fakePart({ name: 'sandbox', mount: 'sandbox', sourceMaps: false }, () => ({
      'eval.html': sandboxDocument('eval.html', script),
    }))
    const { result, outDir } = run(root, [fakeSitePart(root), fakeAppPart(root), sandbox])
    expect(result.packages.map((pkg) => [pkg.name, [...pkg.usedIn]])).toEqual([
      ['bgutils-js', ['sandbox']],
    ])
    const notices = readFileSync(join(outDir, NOTICES_FILE), 'utf8')
    expect(notices).toContain(
      'Its sandbox documents include code from the open-source packages below',
    )
    expect(notices).toContain('bgutils-js 4.0.3\nLicence: MIT\nUsed in: sandbox')
  })

  it('refuses a package that ships no licence text, unless a review says what covers it', () => {
    const root = tempDir()
    const problems = problemsOf(() =>
      run(root, [
        fakeSitePart(root),
        fakeAppPart(root, {
          packages: [
            {
              name: 'spdx-only',
              version: '1.0.0',
              license: 'MIT OR Apache-2.0',
              files: { 'LICENSE.spdx': 'PackageLicenseDeclared: MIT' },
            },
          ],
        }),
      ]),
    )
    expect(problems).toEqual([
      'spdx-only@1.0.0 (in app) ships no licence text: check what covers it (its licence is MIT OR Apache-2.0) and record that in REVIEWED_LICENCE_TEXTS in src/licenses.ts',
    ])
  })

  it('refuses a document without source maps whose inline code looks bundled', () => {
    const root = tempDir()
    const sandbox = fakePart({ name: 'sandbox', mount: 'sandbox', sourceMaps: false }, () => ({
      'eval.html': sandboxDocument('eval.html', '/*! interpreter v1.0.0 | MIT */ run()'),
    }))
    expect(problemsOf(() => run(root, [fakeSitePart(root), fakeAppPart(root), sandbox]))).toEqual([
      'sandbox: eval.html inlines code with a licence notice ("/*!"), but builds no source maps to show which packages it contains',
    ])
  })

  it('refuses two parts writing one path, Functions and files it writes itself', () => {
    const root = tempDir()
    const intruder = fakePart({ name: 'sandbox', mount: '' }, () => ({
      'robots.txt': 'again',
      _redirects: '/app/* /app/index.html 200',
      _headers: '/*\n  X-Mine: yes',
      [NOTICES_FILE]: 'mine',
    }))
    expect(problemsOf(() => run(root, [fakeSitePart(root), fakeAppPart(root), intruder]))).toEqual([
      'site and sandbox both write robots.txt',
      `a part writes ${NOTICES_FILE}; make dist writes it`,
      'a part writes _headers; make dist writes it',
      'the output has _redirects: FXM deploys static files only',
    ])
  })

  it('needs the required parts', () => {
    const root = tempDir()
    expect(
      problemsOf(() =>
        run(root, [fakeSitePart(root), absentPart({ name: 'app', mount: 'app', required: true })]),
      ),
    ).toEqual(['app is required but was not built'])
  })

  it('refuses a privacy page that misses a service the policies name', () => {
    const root = tempDir()
    const site = fakeSitePart(root, {
      privacy: privacyPage([
        'YouTube',
        'Spotify',
        'MusicBrainz',
        'Internet Archive',
        'Jamendo',
        'SponsorBlock',
        'ListenBrainz',
        'Last.fm',
        'GitHub',
        'Cover Art Archive',
      ]),
    })
    expect(problemsOf(() => run(root, [site, fakeAppPart(root)]))).toEqual([
      "the privacy page doesn't list LRCLIB, whose hosts the policies allow: add it to apps/site/src/pages/privacy.astro",
    ])
  })
})
