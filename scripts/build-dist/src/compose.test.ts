import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compose, DistError, NOTICES_FILE } from './compose.ts'
import { metaPolicyOf, serializePolicy, sha256Source } from './csp.ts'
import { parseHeaders } from './headers-file.ts'
import { embedPart, sandboxPart } from './later-stages.ts'
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

function run(root: string, parts: readonly Part[]) {
  const logs: string[] = []
  const outDir = join(root, 'dist/pages')
  const result = compose({
    root,
    parts,
    stagingDir: join(root, 'dist/.staging'),
    outDir,
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
          packages: [{ name: 'copyleft', version: '2.0.0', license: 'GPL-3.0-only' }],
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
    const fonts = installPackage(root, { name: 'fonts', version: '1.0.0', license: 'OFL-1.1' })
    const codec = installPackage(root, { name: 'codec', version: '2.0.0', license: 'GPL-2.0' })
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
      privacy: privacyPage(['YouTube', 'Spotify', 'MusicBrainz', 'Internet Archive', 'Jamendo']),
    })
    expect(problemsOf(() => run(root, [site, fakeAppPart(root)]))).toEqual([
      "the privacy page doesn't list LRCLIB, whose hosts the policies allow: add it to apps/site/src/pages/privacy.astro",
    ])
  })
})
