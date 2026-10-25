import { afterEach, describe, expect, it } from 'vitest'
import { serializePolicy, sha256Source } from './csp.ts'
import type { HeaderRule } from './headers-file.ts'
import { appPolicy, SANDBOX_DOCUMENTS, STATIC_FILE_POLICY } from './policies.ts'
import { generateRules, listFiles, RulesError, servedPaths, validateRules } from './rules.ts'
import { removeTempDirs, tempDir, writeFiles } from './testing.ts'

afterEach(removeTempDirs)

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
      'sandbox/innertube.html': page('<script>inner()</script>'),
      'sandbox/eval.html': page('<script>evaluate()</script>'),
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
      SANDBOX_DOCUMENTS['innertube.html']([sha256Source('inner()')]),
    )
    expect(csp(rules, '/sandbox/innertube')).toBe(innertube)
    expect(csp(rules, '/sandbox/innertube.html')).toBe(innertube)
    for (const rule of rules) {
      expect(rule.headers.slice(1)).toEqual([
        ['Referrer-Policy', 'no-referrer'],
        ['X-Content-Type-Options', 'nosniff'],
      ])
    }
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
    [{ 'sandbox/innertube.js': 'x' }, /sandbox\/innertube\.js has no policy/],
    [{ 'app/assets/x.js': 'x' }, /app\/ has no index\.html/],
  ])('refuses pages a policy cannot fix: %j', (files, message) => {
    expect(() => generateRules(folder(files))).toThrow(message)
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
  const rule = (path: string, value = "default-src 'none'"): HeaderRule => ({
    path,
    headers: [['Content-Security-Policy', value]],
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
})
