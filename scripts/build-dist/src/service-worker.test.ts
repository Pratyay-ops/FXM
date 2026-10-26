import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_HEADERS, headersRevision, pageRevision } from '../../../apps/web/pwa/host.ts'
import type { HeaderRule } from './headers-file.ts'
import { COMMON_HEADERS } from './policies.ts'
import { revisePage } from './service-worker.ts'
import { removeTempDirs, tempDir, writeFiles } from './testing.ts'

afterEach(removeTempDirs)

const PAGE = '<!doctype html><html><head><title>FXM</title></head><body></body></html>'
/** A service worker as the app's build writes it: the page's revision ends in the stand-in's. */
const WORKER = `self.precache([{url:"index.html",revision:"4ff54ac534db830eec9b6ea274475871-${headersRevision(APP_HEADERS)}"},{url:"assets/index.js",revision:null}])`

function composed(files: Record<string, string> = {}): string {
  const dir = tempDir()
  writeFiles(dir, { 'app/index.html': PAGE, 'app/sw.js': WORKER, ...files })
  return dir
}

const appRule = (policy: string): HeaderRule => ({
  path: '/app/*',
  headers: [['Content-Security-Policy', policy], ...COMMON_HEADERS],
})
const pageRevisionIn = (dir: string) =>
  /url:"index\.html",revision:"([^"]*)"/.exec(readFileSync(join(dir, 'app/sw.js'), 'utf8'))?.[1]

describe('revisePage', () => {
  it('revisions the page from the final page and the /app/* rule', () => {
    const dir = composed()
    const rule = appRule("default-src 'self'")
    const revision = revisePage(dir, [rule])
    expect(revision).toBe(pageRevision(PAGE, Object.fromEntries(rule.headers)))
    expect(pageRevisionIn(dir)).toBe(revision)
    expect(readFileSync(join(dir, 'app/sw.js'), 'utf8')).toContain(
      '{url:"assets/index.js",revision:null}',
    )
  })

  it('gives the page a new revision when only the policy changes', () => {
    const before = composed()
    const after = composed()
    revisePage(before, [appRule("default-src 'self'")])
    revisePage(after, [appRule("default-src 'self'; connect-src 'self' https://example.org")])
    expect(pageRevisionIn(after)).not.toBe(pageRevisionIn(before))
    const again = composed()
    revisePage(again, [appRule("default-src 'self'")])
    expect(pageRevisionIn(again)).toBe(pageRevisionIn(before))
  })

  it('and when only the page changes', () => {
    const before = composed()
    const after = composed({ 'app/index.html': PAGE.replace('FXM', 'FXM 2') })
    revisePage(before, [appRule("default-src 'self'")])
    revisePage(after, [appRule("default-src 'self'")])
    expect(pageRevisionIn(after)).not.toBe(pageRevisionIn(before))
  })

  it('leaves an app without a service worker alone', () => {
    const dir = tempDir()
    writeFiles(dir, { 'app/index.html': PAGE })
    expect(revisePage(dir, [appRule("default-src 'self'")])).toBeUndefined()
  })

  it("refuses a service worker without the build's page revision", () => {
    const dir = composed({ 'app/sw.js': 'self.precache([{url:"index.html",revision:"abc"}])' })
    expect(() => revisePage(dir, [appRule("default-src 'self'")])).toThrow(
      /^app\/sw\.js: the service worker has 0 precache revisions ending in -/,
    )
    expect(() => revisePage(composed(), [])).toThrow('app/sw.js exists, but no rule serves /app/*')
  })
})
