// @vitest-environment node
// Build-time config: no DOM.
import { describe, expect, it } from 'vitest'
import { PLANNED_APP_CSP, PWA_REVALIDATE_PATHS, parseCsp, pwaCspProblems } from './host.ts'

describe('what the PWA needs from the host', () => {
  // Integration with 2.8: check the /app/* rule its _headers generator writes here instead.
  it("is allowed by the /app/* policy that stage 2.8's _headers will send", () => {
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
})
