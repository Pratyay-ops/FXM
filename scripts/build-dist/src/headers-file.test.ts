import { describe, expect, it } from 'vitest'
import {
  type HeaderRule,
  MAX_RULES,
  matchingRules,
  parseHeaders,
  ruleRegExp,
  rulesOverlap,
  serializeHeaders,
} from './headers-file.ts'

const RULES: HeaderRule[] = [
  {
    path: '/',
    headers: [
      ['Content-Security-Policy', "default-src 'none'"],
      ['Referrer-Policy', 'no-referrer'],
    ],
  },
  { path: '/app/*', headers: [['Content-Security-Policy', "default-src 'self'"]] },
]

describe('serializeHeaders and parseHeaders', () => {
  it('round-trip, with comments, header names lower-cased by the parser', () => {
    const text = serializeHeaders(RULES, ['Generated.'])
    expect(text).toBe(
      "# Generated.\n\n/\n  Content-Security-Policy: default-src 'none'\n  Referrer-Policy: no-referrer\n\n/app/*\n  Content-Security-Policy: default-src 'self'\n",
    )
    const { rules, invalid } = parseHeaders(text)
    expect(invalid).toEqual([])
    expect(rules.map((rule) => [rule.path, Object.fromEntries(rule.headers)])).toEqual([
      ['/', { 'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer' }],
      ['/app/*', { 'content-security-policy': "default-src 'self'" }],
    ])
  })

  it('join a header repeated within a rule with a comma, as Cloudflare does', () => {
    const { rules } = parseHeaders('/a\n  X-Robots-Tag: noindex\n  X-Robots-Tag: nosnippet\n')
    expect(rules[0]?.headers.get('x-robots-tag')).toBe('noindex, nosnippet')
  })

  it('report what Cloudflare would skip, and what FXM never writes', () => {
    const long = `/long\n  Content-Security-Policy: ${'x'.repeat(2000)}\n`
    const { rules, invalid } = parseHeaders(
      `${long}https://example.com/*\n  A: b\n/empty\n/two/*/stars/*\n  A: b\n/ok\n  ! Server\n  bad line\n  A: b\n`,
    )
    expect(rules.map((rule) => rule.path)).toEqual(['/ok'])
    expect(invalid).toEqual([
      'line 2: longer than 2000 characters, Cloudflare ignores it',
      'line 1: /long has no headers',
      'line 3: absolute URL rules are not used by FXM: https://example.com/*',
      'line 5: /empty has no headers',
      'line 6: only one * is allowed per rule: /two/*/stars/*',
      'line 9: header removal (! Server) is not used by FXM',
      'line 10: expected "Name: value": bad line',
    ])
  })

  it(`read at most ${MAX_RULES} rules`, () => {
    const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => `/p${i}\n  A: b`).join('\n')
    const { rules, invalid } = parseHeaders(many)
    expect(rules).toHaveLength(MAX_RULES)
    expect(invalid).toHaveLength(1)
  })
})

describe('matching', () => {
  it('compiles splats and placeholders the way Pages does', () => {
    expect(ruleRegExp('/app/*').test('/app/')).toBe(true)
    expect(ruleRegExp('/app/*').test('/app/a/b.js')).toBe(true)
    expect(ruleRegExp('/app/*').test('/app')).toBe(false)
    expect(ruleRegExp('/blog/:slug').test('/blog/x')).toBe(true)
    expect(ruleRegExp('/blog/:slug').test('/blog/x/y')).toBe(false)
    expect(ruleRegExp('/a.html').test('/aXhtml')).toBe(false)
  })

  it('returns every matching rule in order', () => {
    const rules = [{ path: '/*' }, { path: '/app/*' }, { path: '/app/' }]
    expect(matchingRules(rules, '/app/').map((rule) => rule.path)).toEqual([
      '/*',
      '/app/*',
      '/app/',
    ])
    expect(matchingRules(rules, '/privacy').map((rule) => rule.path)).toEqual(['/*'])
  })
})

describe('rulesOverlap', () => {
  it.each([
    ['/a', '/a', true],
    ['/a', '/b', false],
    ['/app/*', '/app/index.html', true],
    ['/app/*', '/app', false],
    ['/app/*', '/application', false],
    ['/*', '/app/*', true],
    ['/app/*', '/embed/*', false],
    ['/sandbox/innertube', '/sandbox/innertube.html', false],
    // The encoded-path rules: `<folder>/%*` is a prefix, `<folder>/:name%*` its own shape.
    ['/%*', '/privacy', false],
    ['/:name%*', '/privacy', false],
    ['/%*', '/app/*', false],
    ['/:name%*', '/app/*', false],
    ['/:name%*', '/.well-known/*', false],
    ['/%*', '/sandbox/%*', false],
    ['/:name%*', '/sandbox/:name%*', false],
    ['/:name%*', '/sandbox/%*', false],
    ['/%*', '/sandbox/:name%*', false],
    ['/sandbox/:name%*', '/sandbox/innertube', false],
    ['/sandbox/%*', '/sandbox/innertube.html', false],
    ['/%*', '/%*', true],
    ['/:name%*', '/:name%*', true],
    // A first segment that starts with % and has another one later matches both.
    ['/%*', '/:name%*', true],
    ['/sandbox/%*', '/sandbox/:name%*', true],
    ['/*', '/:name%*', true],
    ['/sandbox/*', '/sandbox/:name%*', true],
    ['/:name%*', '/sandbox/*', false],
  ])('%s and %s: %s', (a, b, overlap) => {
    expect(rulesOverlap(a, b)).toBe(overlap)
    expect(rulesOverlap(b, a)).toBe(overlap)
  })

  it('agrees with the paths the rules match', () => {
    const paths = [
      '/%61%62',
      '/a%62',
      '/%61',
      '/sandbox/x%79',
      '/sandbox/%78',
      '/sandbox/x',
      '/s%61/x',
    ]
    const rules = ['/%*', '/:name%*', '/sandbox/%*', '/sandbox/:name%*', '/sandbox/*', '/sandbox/x']
    for (const a of rules) {
      for (const b of rules) {
        const shared = paths.some((path) => ruleRegExp(a).test(path) && ruleRegExp(b).test(path))
        // Every pair that shares one of these paths must be reported as overlapping.
        if (shared) expect(rulesOverlap(a, b), `${a} ${b}`).toBe(true)
      }
    }
  })

  it('refuses rule shapes FXM never writes', () => {
    expect(() => rulesOverlap('/blog/:slug', '/a')).toThrow(/placeholders/)
    expect(() => rulesOverlap('/a*', '/a')).toThrow(/splat/)
    expect(() => rulesOverlap('/a%b/*', '/a')).toThrow(/splat/)
    expect(() => rulesOverlap('/a%b', '/a')).toThrow(/can't contain %/)
    expect(() => rulesOverlap('/:name%x*', '/a')).toThrow(/placeholders/)
  })
})
