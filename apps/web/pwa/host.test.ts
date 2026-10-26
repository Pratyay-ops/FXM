// @vitest-environment node
// Build-time config: no DOM.
import { describe, expect, it } from 'vitest'
import {
  APP_HEADERS,
  headersRevision,
  PLANNED_APP_CSP,
  PWA_REVALIDATE_PATHS,
  pageRevision,
  parseCsp,
  pwaCspProblems,
  setPageRevision,
} from './host.ts'

describe('what the PWA needs from the host', () => {
  // scripts/build-dist checks the policy make dist generates the same way (policies.test.ts).
  it('is allowed by the /app/* policy of docs/PLAN.md §2.8', () => {
    expect(pwaCspProblems(PLANNED_APP_CSP)).toEqual([])
  })

  it('finds a policy that blocks the service worker', () => {
    expect(pwaCspProblems("default-src 'self'; worker-src 'none'")).toEqual(['worker-src'])
    expect(pwaCspProblems("default-src 'self'; script-src https://cdn.example")).toEqual([
      'worker-src (from script-src)',
    ])
  })

  it('finds a policy that blocks the manifest, the icons or the shell download', () => {
    expect(pwaCspProblems("default-src 'none'; script-src 'self'")).toEqual([
      'manifest-src (from default-src)',
      'img-src (from default-src)',
      'connect-src (from default-src)',
    ])
  })

  it('follows the CSP fallbacks, and accepts a policy that restricts nothing', () => {
    expect(pwaCspProblems("default-src 'none'; child-src 'self'; manifest-src 'self'")).toEqual([
      'img-src (from default-src)',
      'connect-src (from default-src)',
    ])
    expect(pwaCspProblems("frame-ancestors 'none'")).toEqual([])
    expect(pwaCspProblems("default-src *; object-src 'none'")).toEqual([])
  })

  it('parses directive names case-insensitively, the first of a repeated one winning', () => {
    const directives = parseCsp("Default-Src 'self';; default-src 'none'; img-src data:")
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(directives.get('img-src')).toEqual(['data:'])
  })

  it('names the files that announce a new version, which must not be cached for long', () => {
    expect(PWA_REVALIDATE_PATHS).toEqual([
      '/app/sw.js',
      '/app/manifest.webmanifest',
      '/app/index.html',
    ])
  })

  it('revisions builds outside make dist with the /app/* rule of docs/PLAN.md §2.8', () => {
    expect(APP_HEADERS).toEqual({
      'Content-Security-Policy': PLANNED_APP_CSP,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
  })
})

describe('headersRevision', () => {
  it('changes with any header, so a new policy ships a new service worker', () => {
    const revision = headersRevision(APP_HEADERS)
    expect(revision).toMatch(/^[0-9a-f]{12}$/)
    expect(headersRevision({ ...APP_HEADERS })).toBe(revision)
    expect(
      headersRevision({
        ...APP_HEADERS,
        'Content-Security-Policy': `${PLANNED_APP_CSP}; upgrade-insecure-requests`,
      }),
    ).not.toBe(revision)
    expect(headersRevision({ ...APP_HEADERS, 'Referrer-Policy': 'same-origin' })).not.toBe(revision)
  })

  it('ignores the order of the headers and the case of their names', () => {
    expect(headersRevision({ A: '1', b: '2' })).toBe(headersRevision({ B: '2', a: '1' }))
  })
})

describe('the page revision make dist sets', () => {
  const page = '<!doctype html><title>FXM</title>'
  const rule = { 'Content-Security-Policy': "default-src 'self'", 'Referrer-Policy': 'no-referrer' }

  it('changes when only the policy changes, so installed apps get the new headers', () => {
    const revision = pageRevision(page, rule)
    expect(revision).toMatch(/^[0-9a-f]{32}$/)
    expect(pageRevision(page, { ...rule })).toBe(revision)
    expect(
      pageRevision(page, {
        ...rule,
        'Content-Security-Policy': "default-src 'self'; img-src data:",
      }),
    ).not.toBe(revision)
    expect(pageRevision(page, { ...rule, 'Permissions-Policy': 'camera=()' })).not.toBe(revision)
  })

  it('changes with the page, and not with the order of the headers or the case of their names', () => {
    expect(pageRevision(`${page}<p>`, rule)).not.toBe(pageRevision(page, rule))
    const reordered = Object.fromEntries(
      Object.entries(rule)
        .reverse()
        .map(([name, value]) => [name.toLowerCase(), value]),
    )
    expect(pageRevision(page, reordered)).toBe(pageRevision(page, rule))
  })

  it('replaces the revision the build gave the page in the service worker, and only that', () => {
    const built = `${'0'.repeat(32)}-${headersRevision(APP_HEADERS)}`
    const worker = `precache([{url:"index.html",revision:"${built}"},{url:"icons/icon-192.png",revision:"abc"}])`
    expect(setPageRevision(worker, 'f'.repeat(32))).toBe(
      `precache([{url:"index.html",revision:"${'f'.repeat(32)}"},{url:"icons/icon-192.png",revision:"abc"}])`,
    )
    expect(setPageRevision(`precache([{revision:'${built}',url:'index.html'}])`, 'new')).toBe(
      "precache([{revision:'new',url:'index.html'}])",
    )
  })

  it("refuses a service worker without the build's page revision, or with two", () => {
    const built = `"abc-${headersRevision(APP_HEADERS)}"`
    expect(() => setPageRevision('precache([])', 'new')).toThrow(/has 0 precache revisions/)
    expect(() => setPageRevision(`[${built},${built}]`, 'new')).toThrow(/has 2 precache revisions/)
  })
})
