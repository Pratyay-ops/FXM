import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { metaPolicyOf, serializePolicy, sha256Source } from './csp.ts'
import type { HeaderRule } from './headers-file.ts'
import { scanPage } from './html.ts'
import { appPolicy, COMMON_HEADERS, SANDBOX_DOCUMENTS, STATIC_FILE_POLICY } from './policies.ts'
import {
  addDocumentPolicies,
  encodedVariants,
  generateRules,
  listFiles,
  RulesError,
  servedPaths,
  validateRules,
} from './rules.ts'
import { removeTempDirs, sandboxDocument, tempDir, writeFiles } from './testing.ts'

afterEach(removeTempDirs)

/** A sandbox document's script that does nothing unless its origin is opaque. */
const opaque = (code: string) => `if (self.origin !== 'null') throw 0; ${code}`

const page = (body = '', head = '') =>
  `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body><h1>t</h1>${body}</body></html>`

function folder(files: Record<string, string>): string {
  const dir = tempDir()
  writeFiles(dir, files)
  return dir
}

const csp = (rules: readonly HeaderRule[], path: string) =>
  rules
    .find((rule) => rule.path === path)
    ?.headers.find(([name]) => name === 'Content-Security-Policy')?.[1]

describe('servedPaths', () => {
  const files = new Set([
    'index.html',
    'privacy.html',
    'app/index.html',
    'docs/index.html',
    'x',
    'x.html',
    'a.css',
  ])
  it.each([
    ['index.html', ['/', '/index.html']],
    ['privacy.html', ['/privacy', '/privacy.html']],
    ['app/index.html', ['/app/', '/app/index.html']],
    ['docs/index.html', ['/docs/', '/docs/index.html']],
    // A file named like the extension-less path makes Pages serve the .html file as is.
    ['x.html', ['/x.html']],
    ['a.css', ['/a.css']],
  ])('%s is served at %j', (file, paths) => {
    expect(servedPaths(file, files)).toEqual(paths)
  })
})

describe('generateRules', () => {
  it('gives every path exactly one policy, by kind of file', () => {
    const dir = folder({
      'index.html': page(
        '<script type="module">menu()</script>',
        '<link rel="stylesheet" href="/_astro/a.css"><style>h1{}</style>',
      ),
      '404.html': page(),
      'robots.txt': 'User-agent: *',
      '_astro/a.css': 'a{}',
      '.well-known/security.txt': 'Contact: x',
      'app/index.html': page(
        '',
        '<script>theme()</script><script type="module" src="/app/assets/i.js"></script>',
      ),
      'app/404.html': page('', '<script>theme()</script>'),
      'app/assets/i.js': '1',
      'embed/index.html': page('', '<script>embed()</script>'),
      'sandbox/innertube.html': sandboxDocument('innertube.html', opaque('inner()')),
      'sandbox/eval.html': sandboxDocument('eval.html', opaque('evaluate()')),
    })
    const rules = generateRules(dir)
    expect(rules.map((rule) => rule.path)).toEqual([
      '/404',
      '/404.html',
      '/',
      '/index.html',
      '/robots.txt',
      '/.well-known/*',
      '/_astro/*',
      '/app/*',
      '/embed/*',
      '/sandbox/eval',
      '/sandbox/eval.html',
      '/sandbox/innertube',
      '/sandbox/innertube.html',
    ])
    expect(csp(rules, '/')).toBe(
      `default-src 'none'; script-src ${sha256Source('menu()')}; style-src 'self' ${sha256Source('h1{}')}; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    )
    expect(csp(rules, '/404')).toBe(
      "default-src 'none'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    expect(csp(rules, '/robots.txt')).toBe(serializePolicy(STATIC_FILE_POLICY))
    expect(csp(rules, '/_astro/*')).toBe(serializePolicy(STATIC_FILE_POLICY))
    expect(csp(rules, '/app/*')).toBe(serializePolicy(appPolicy([sha256Source('theme()')])))
    expect(csp(rules, '/embed/*')).toBe(
      serializePolicy(appPolicy([sha256Source('embed()')], { embeddable: true })),
    )
    const innertube = serializePolicy(
      SANDBOX_DOCUMENTS['innertube.html']([sha256Source(opaque('inner()'))]),
    )
    expect(csp(rules, '/sandbox/innertube')).toBe(innertube)
    expect(csp(rules, '/sandbox/innertube.html')).toBe(innertube)
    for (const rule of rules) expect(rule.headers.slice(1)).toEqual(COMMON_HEADERS)
  })

  it.each([
    [{ 'index.html': page('<p style="color:red">x</p>') }, /style attributes \(p\)/],
    [
      { 'index.html': page('<button onclick="x()">x</button>') },
      /inline event handlers \(button\[onclick\]\)/,
    ],
    [
      { 'index.html': page('', '<script src="https://cdn.example/x.js"></script>') },
      /loads a script from https:\/\/cdn/,
    ],
    [
      { 'index.html': page('', '<link rel="stylesheet" href="//cdn.example/x.css">') },
      /loads a stylesheet/,
    ],
    [
      { 'index.html': page('', '<meta name="referrer" content="origin">') },
      /override Referrer-Policy/,
    ],
    [{ 'sandbox/other.html': page('<script>x()</script>') }, /sandbox\/other\.html has no policy/],
    [{ 'sandbox/innertube.html': page('<script src="/x.js"></script>') }, /must inline its script/],
    [{ 'sandbox/innertube.html': page() }, /has no inline script/],
    [
      {
        'sandbox/innertube.html': sandboxDocument('innertube.html', opaque('x()'), {
          meta: false,
        }),
      },
      /must carry its policy in exactly one <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-/,
    ],
    [
      {
        'sandbox/userhost.html': sandboxDocument('userhost.html', opaque('x()')).replace(
          'connect-src https:',
          'connect-src *',
        ),
      },
      /the policy in its meta element is\n.*connect-src \*;.*\n {4}but must be\n.*connect-src https:;/,
    ],
    [
      {
        'sandbox/innertube.html': `<!doctype html><title>x</title><script>${opaque('x()')}</script>${sandboxDocument('innertube.html', opaque('x()')).match(/<meta http-equiv[^>]*>/)?.[0]}`,
      },
      /must put its policy's meta element before its script/,
    ],
    [
      { 'sandbox/innertube.html': sandboxDocument('innertube.html', 'start()') },
      /innertube\.html must do nothing unless self\.origin === 'null'/,
    ],
    [
      {
        'sandbox/innertube.html': sandboxDocument(
          'innertube.html',
          "if (location.origin !== 'null') start()",
        ),
      },
      /must do nothing unless self\.origin === 'null'/,
    ],
    [
      {
        'index.html': page(
          '',
          `<meta http-equiv="Content-Security-Policy" content="default-src *">`,
        ),
      },
      /index\.html has a policy in a meta element: make dist writes it/,
    ],
    [
      { 'priv%61cy.html': page() },
      /priv%61cy\.html: a file name with % can't have a rule of its own/,
    ],
    [{ 'sandbox/innertube.js': 'x' }, /sandbox\/innertube\.js has no policy/],
    [{ 'app/assets/x.js': 'x' }, /app\/ has no index\.html/],
  ])('refuses pages a policy cannot fix: %j', (files, message) => {
    expect(() => generateRules(folder(files))).toThrow(message)
  })

  it('accepts a referrer meta element only when it says what the header says', () => {
    const rules = generateRules(
      folder({ 'a.html': page('', '<meta name="referrer" content="no-referrer">') }),
    )
    expect(csp(rules, '/a')).toMatch(/^default-src 'none'/)
  })

  it("allows a page's own files by a relative URL, under 'self'", () => {
    const rules = generateRules(
      folder({
        'docs/index.html': page(
          '',
          '<script src="app.js"></script><link rel="stylesheet" href="./a.css">',
        ),
      }),
    )
    expect(csp(rules, '/docs/')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
  })

  it('reports every problem at once', () => {
    const error = (() => {
      try {
        generateRules(
          folder({ 'a.html': page('<p style="x">x</p>'), 'b.html': page('<i onclick="x">x</i>') }),
        )
      } catch (thrown) {
        return thrown
      }
    })()
    expect(error).toBeInstanceOf(RulesError)
    expect((error as RulesError).problems).toHaveLength(2)
  })

  it('lists files with dot-folders, refusing symbolic links', () => {
    const dir = folder({ '.well-known/security.txt': 'x', 'a/b.txt': 'y' })
    expect(listFiles(dir)).toEqual(['.well-known/security.txt', 'a/b.txt'])
  })
})

describe('validateRules', () => {
  const SITE = "default-src 'none'; frame-ancestors 'none'"
  const rule = (path: string, value = SITE): HeaderRule => ({
    path,
    headers: [['Content-Security-Policy', value], ...COMMON_HEADERS],
  })

  it('accepts rules that cover every served path exactly once', () => {
    expect(
      validateRules([rule('/a'), rule('/a.html'), rule('/app/*')], ['a.html', 'app/index.html']),
    ).toEqual([])
  })

  it('refuses overlapping rules, uncovered paths, long lines and too many rules', () => {
    expect(validateRules([rule('/app/*'), rule('/app/index.html')], ['app/index.html'])).toContain(
      'rules /app/* and /app/index.html match the same paths',
    )
    expect(validateRules([rule('/a')], ['a.html'])).toContain('/a.html matches 0 rules')
    expect(validateRules([rule('/a', 'x'.repeat(2000))], [])[0]).toMatch(/over Cloudflare's 2000/)
    const many = Array.from({ length: 101 }, (_, i) => rule(`/p${i}`))
    expect(validateRules(many, [])[0]).toBe('101 rules, but Cloudflare reads only 100')
  })

  it('checks that a client-side route of the app has a rule', () => {
    expect(validateRules([rule('/app/'), rule('/app/index.html')], ['app/index.html'])).toContain(
      '/app/__fxm-route-check__/deep/link matches 0 rules',
    )
  })

  it('refuses a rule path Cloudflare would read differently', () => {
    expect(validateRules([rule('/a%41')], [])).toContain('the rule for /a%41 reads back as /aA')
  })

  it('checks the promises each kind of rule makes', () => {
    const errors = validateRules(
      [
        rule('/app/*', "default-src 'self'; script-src 'self' 'unsafe-eval'"),
        rule('/sandbox/innertube', "sandbox; default-src 'none'"),
        rule(
          '/sandbox/eval',
          "sandbox allow-scripts; script-src 'unsafe-eval'; frame-ancestors 'none'",
        ),
        { path: '/b', headers: [['Content-Security-Policy', SITE]] },
      ],
      [],
    )
    expect(errors).toEqual([
      "/app/*: 'unsafe-eval' outside the evaluator document",
      '/app/*: no "frame-ancestors \'none\'"',
      '/sandbox/innertube: a sandbox document without "sandbox allow-scripts"',
      '/sandbox/eval: frame-ancestors, which would stop the embed or Lite inside other sites',
      '/b: Referrer-Policy must be no-referrer, once',
      '/b: X-Content-Type-Options must be nosniff, once',
      '/b: Cross-Origin-Opener-Policy must be same-origin, once',
      '/b: 0 Permissions-Policy headers',
    ])
  })

  it('refuses a Permissions-Policy that turns off what the player may use', () => {
    const headers = COMMON_HEADERS.filter(([name]) => name !== 'Permissions-Policy')
    const loose: HeaderRule = {
      path: '/b',
      headers: [
        ['Content-Security-Policy', SITE],
        ...headers,
        ['Permissions-Policy', 'camera=(), autoplay=(), fullscreen=(self)'],
      ],
    }
    expect(validateRules([loose], [])).toEqual([
      '/b: Permissions-Policy: it turns off autoplay, which the player may use',
      '/b: Permissions-Policy: "fullscreen=(self)" doesn\'t turn a feature off (feature=())',
    ])
  })
})

describe('addDocumentPolicies', () => {
  function composed(files: Record<string, string>) {
    const dir = folder(files)
    const rules = generateRules(dir)
    addDocumentPolicies(dir, rules)
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    return { rules, read }
  }

  it('puts each page’s policy and no-referrer at the start of its head', () => {
    const appPage = `<!doctype html><html><head>\n<meta charset="UTF-8" />\n<title>a</title><script>theme()</script></head><body></body></html>`
    const { rules, read } = composed({
      'privacy.html': page('<script type="module">menu()</script>'),
      'app/index.html': appPage,
      'app/404.html': appPage,
      'sandbox/innertube.html': sandboxDocument('innertube.html', opaque('inner()')),
    })
    const policy = (path: string) => metaPolicyOf(csp(rules, path) as string)
    expect(read('privacy.html')).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="${policy('/privacy')}"><meta name="referrer" content="no-referrer"><title>`,
    )
    // After the charset, which must stay in the first 1,024 bytes; before the theme script.
    expect(read('app/index.html')).toContain(
      `<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${policy('/app/*')}"><meta name="referrer" content="no-referrer">\n<title>`,
    )
    expect(read('app/404.html')).toBe(read('app/index.html'))
    expect(policy('/app/*')).not.toMatch(/frame-ancestors|sandbox/)
    // The sandbox documents bring their own.
    expect(read('sandbox/innertube.html')).toBe(
      sandboxDocument('innertube.html', opaque('inner()')),
    )
    // The hashes still hold: the pages' scripts didn't change.
    expect(scanPage(read('app/index.html')).inlineScripts).toEqual(['theme()'])
  })

  it('keeps a referrer meta element a page already has', () => {
    const { read } = composed({
      'a.html': page('', '<meta name="referrer" content="no-referrer">'),
    })
    expect(read('a.html').match(/name="referrer"/g)).toHaveLength(1)
    expect(read('a.html')).toContain('http-equiv="Content-Security-Policy"')
  })

  it('refuses a page without a head, or with a script before its charset', () => {
    expect(() => composed({ 'a.html': '<!doctype html><title>a</title><h1>a</h1>' })).toThrow(
      /a\.html: the document has no <head> tag/,
    )
    expect(() =>
      composed({
        'a.html':
          '<!doctype html><html><head><script>early()</script><meta charset="utf-8"><title>a</title></head></html>',
      }),
    ).toThrow(/a\.html must put its policy's meta element before its script/)
  })
})

describe('encoded paths', () => {
  it('encode the first and the last character of each segment, as UTF-8, and each inner slash', () => {
    expect(encodedVariants('/privacy')).toEqual(['/%70rivacy', '/privac%79'])
    expect(encodedVariants('/sandbox/innertube')).toEqual([
      '/%73andbox/innertube',
      '/sandbo%78/innertube',
      '/sandbox%2Finnertube',
      '/sandbox/%69nnertube',
      '/sandbox/innertub%65',
    ])
    expect(encodedVariants('/app/', 1)).toEqual(['/%61pp/', '/ap%70/', '/app%2F'])
    expect(encodedVariants('/x/é')).toEqual(['/%78/é', '/x%2Fé', '/x/%C3%A9'])
    expect(encodedVariants('/')).toEqual([])
  })
})
