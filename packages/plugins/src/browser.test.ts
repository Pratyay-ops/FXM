/**
 * Plugins in a real browser (Playwright's Chromium from `.tools/playwright`, headless, muted,
 * with a throwaway profile): the committed `apps/web/sandbox/eval.html`, served with the policy
 * stage 2.8 serves it with, runs the test plugin for a page that uses this package and the web
 * host of `@fxm/platform`, exactly as the web app does. Every request is answered locally: the
 * browser never touches the network. It is not part of `make test`; run it with:
 *
 * ```sh
 * FXM_BROWSER=1 scripts/run.sh pnpm vitest run packages/plugins/src/browser.test.ts
 * ```
 */

import type { Browser, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** Node's environment and `fs`, without Node's types. */
const node = (
  globalThis as unknown as {
    process: {
      env: Record<string, string | undefined>
      getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
    }
  }
).process
const enabled = node.env.FXM_BROWSER === '1'

const APP = 'https://fxm.test'

/** A plugin that reports what its document can reach, as a track's title. */
const PROBE_CODE = `fxm.register({
  async search() { return {} },
  async track(id, ctx) {
    const probe = { origin: self.origin }
    try { await fetch('https://catalog.fxm-plugin.test/direct'); probe.fetch = 'reached' } catch (error) { probe.fetch = error.name }
    try { probe.storage = typeof localStorage.getItem('x') } catch (error) { probe.storage = error.name }
    try { probe.parent = parent.document.title } catch (error) { probe.parent = error.name }
    try { probe.image = await new Promise((resolve) => { const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('blocked'); image.src = 'https://catalog.fxm-plugin.test/pixel.gif' }) } catch (error) { probe.image = error.name }
    const answer = await ctx.fetch('https://catalog.fxm-plugin.test/tracks/' + id)
    probe.viaHost = answer.status
    return { id, title: JSON.stringify(probe) }
  },
})`

describe.skipIf(!enabled)('plugins in Chromium', { timeout: 60_000 }, () => {
  let browser: Browser
  let page: Page
  /** Every request that reached the browser's network layer for the test catalog. */
  const catalogRequests: string[] = []

  beforeAll(async () => {
    const { chromium } = await import('playwright-core')
    const { build } = await import('rolldown')
    const html = node
      .getBuiltinModule('node:fs')
      .readFileSync(new URL('../../../apps/web/sandbox/eval.html', import.meta.url), 'utf8')
    const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/u.exec(html)?.[1]
    if (meta === undefined) throw new Error('eval.html has no policy')
    // As stage 2.8's `_headers` serves it (`evaluatorHeaderPolicy` of @fxm/platform).
    const policy = `sandbox allow-scripts; ${meta}`
    const bundle = await build({
      input: decodeURIComponent(new URL('./testing/browser-entry.ts', import.meta.url).pathname),
      write: false,
      platform: 'browser',
      logLevel: 'silent',
      output: { format: 'iife', name: 'fxmPlugins' },
    })
    const script = bundle.output[0]?.code ?? ''
    browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })
    const context = await browser.newContext()
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.href === `${APP}/app/`) {
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><title>FXM</title><script>${script}</script>`,
        })
      }
      if (url.origin === APP && url.pathname === '/sandbox/eval.html') {
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: { 'content-security-policy': policy },
          body: html,
        })
      }
      if (url.host === 'catalog.fxm-plugin.test') catalogRequests.push(url.href)
      return route.abort()
    })
    page = await context.newPage()
    await page.goto(`${APP}/app/`)
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('installs the test plugin and runs it in an evaluator document, never in the page', async () => {
    const result = await page.evaluate(async () => {
      const fxm = (globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') })
        .fxmPlugins
      const registry = fxm.createPluginRegistry({
        store: fxm.memoryPluginStore(),
        sandboxes: fxm.isolatedSandboxes(() => fxm.createSandboxEvaluator()),
      })
      await registry.load()
      await registry.install(registry.offerFromFile(fxm.testPluginFile(), 'test.json'))
      const providers = registry.providers()[0]
      const fetch = fxm.fakeCatalogFetch()
      const results = await providers?.metadata?.search(
        'moths',
        { types: ['track'] },
        fxm.testContext(fetch),
      )
      const frames = [...document.querySelectorAll('iframe')].map((frame) => ({
        sandbox: frame.getAttribute('sandbox'),
        src: new URL(frame.src).pathname,
      }))
      return {
        titles: results?.tracks?.items.map((track) => track.title),
        requests: fetch.requests.map((request) => request.url),
        frames,
        // The page never ran the plugin's code: it registers nothing here.
        leaked: 'fxm' in globalThis || Object.getOwnPropertySymbols(globalThis).length > 0,
      }
    })
    expect(result).toEqual({
      titles: ['Lantern Weather', 'Harbour Lights Out'],
      requests: ['https://catalog.fxm-plugin.test/search?q=moths'],
      frames: [{ sandbox: 'allow-scripts', src: '/sandbox/eval.html' }],
      leaked: false,
    })
  })

  it('gives each plugin its own opaque document, which reaches nothing but through the host', async () => {
    const result = await page.evaluate(async (probeCode) => {
      const fxm = (globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') })
        .fxmPlugins
      const registry = fxm.createPluginRegistry({
        store: fxm.memoryPluginStore(),
        sandboxes: fxm.isolatedSandboxes(() => fxm.createSandboxEvaluator()),
      })
      await registry.load()
      await registry.install(registry.offerFromFile(fxm.testPluginFile(), 'test.json'))
      await registry.install(
        registry.offerFromFile(
          fxm.testPluginFile(
            { id: 'probe', name: 'Probe', provides: ['search', 'track'] },
            probeCode,
          ),
          'probe.json',
        ),
      )
      const before = document.querySelectorAll('iframe').length
      const ctx = fxm.testContext(fxm.fakeCatalogFetch())
      const [probe, catalog] = [
        registry.providers().find((p) => p.id === 'probe'),
        registry.providers().find((p) => p.id === 'test-catalog'),
      ]
      const track = await probe?.metadata?.getTrack('plugin.probe:track:t1' as never, ctx)
      await catalog?.metadata?.getTrack('plugin.test-catalog:track:t2' as never, ctx)
      return {
        probe: JSON.parse(track?.title ?? '{}') as unknown,
        documents: document.querySelectorAll('iframe').length - before,
      }
    }, PROBE_CODE)
    expect(result).toEqual({
      probe: {
        origin: 'null',
        fetch: 'TypeError',
        storage: 'SecurityError',
        parent: 'SecurityError',
        image: 'blocked',
        viaHost: 200,
      },
      documents: 2,
    })
    // The document's own attempts never left the browser: its policy allows no connection.
    expect(catalogRequests).toEqual([])
  })
})
