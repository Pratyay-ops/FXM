/**
 * Plugins in a real browser (Playwright's Chromium from `.tools/playwright`, headless, muted,
 * with a throwaway profile): the committed `apps/web/sandbox/eval.html`, served with the policy
 * stage 2.8 serves it with, runs the test plugin for a page that uses this package and the web
 * host of `@fxm/platform`, exactly as the web app does: each plugin in a worker of its own
 * document. A probe plugin checks what a plugin can reach (WebRTC and navigation, which no policy
 * stops a document's own scripts from using, the network, storage, the page), code that doesn't
 * compile can't load, a plugin that loops forever is stopped while the page goes on, and a
 * document that can't start workers runs no plugin. Every request is answered locally: the
 * browser never touches the network. It is not part of `make test`; run it with:
 *
 * ```sh
 * FXM_BROWSER=1 scripts/run.sh pnpm vitest run packages/plugins/src/browser.test.ts
 * ```
 *
 * `FXM_BROWSER_ENGINE=firefox` runs it in Playwright's Firefox, which passes the same way, and
 * `FXM_BROWSER_ENGINE=webkit` in its WebKit, which starts no worker from the `blob:` URL of an
 * opaque origin, so plugins don't run there at all: that run checks that they fail closed.
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
const ENGINE = (node.env.FXM_BROWSER_ENGINE ?? 'chromium') as 'chromium' | 'firefox' | 'webkit'
/** Whether the engine starts workers in the evaluator document (WebKit doesn't). */
const WORKERS = ENGINE !== 'webkit'

const APP = 'https://fxm.test'

/**
 * A plugin that reports what it can reach, as a track's title: everything a document's own
 * scripts could use to carry data out (WebRTC, which no policy covers, and navigating its
 * document, with the data in the URL), and the network, storage and the page.
 */
const PROBE_CODE = `const HOST = 'https://catalog.fxm-plugin.test'
fxm.register({
  async search() { return {} },
  async track({ id }, ctx) {
    const probe = {
      origin: self.origin,
      document: typeof document,
      webrtc: typeof RTCPeerConnection + ' ' + typeof webkitRTCPeerConnection,
      postMessage: typeof postMessage,
    }
    try { await fetch(HOST + '/direct?q=' + id); probe.fetch = 'reached' } catch (error) { probe.fetch = error.name }
    try { importScripts(HOST + '/import.js'); probe.importScripts = 'reached' } catch (error) { probe.importScripts = error.name }
    probe.socket = await new Promise((resolve) => {
      try {
        const socket = new WebSocket('wss://catalog.fxm-plugin.test/socket?q=' + id)
        socket.onopen = () => resolve('open')
        socket.onerror = () => resolve('error')
      } catch (error) { resolve(error.name) }
    })
    try { location.href = HOST + '/navigate?q=' + id; probe.navigate = 'navigated' } catch (error) { probe.navigate = error.name }
    probe.nested = await new Promise((resolve) => {
      try {
        const script = "fetch('" + HOST + "/nested').then(() => postMessage('reached'), (error) => postMessage(error.name))"
        const nested = new Worker(URL.createObjectURL(new Blob([script])))
        nested.onmessage = (event) => resolve(event.data)
        nested.onerror = () => resolve('error')
      } catch (error) { resolve(error.name) }
    })
    try { probe.storage = typeof indexedDB.open('x') } catch (error) { probe.storage = error.name }
    const answer = await ctx.fetch(HOST + '/tracks/' + id)
    probe.viaHost = answer.status
    return { id, title: JSON.stringify(probe) }
  },
})`

/**
 * A plugin that declares one of FXM's own open services, which the page reaches directly, and
 * reports what became of its request there as a track's title.
 */
const REDIRECTED_CODE = `fxm.register({
  async search() { return {} },
  async track({ id }, ctx) {
    try {
      await ctx.fetch('https://musicbrainz.org/ws/2/go?q=' + id)
      return { id, title: 'reached' }
    } catch (error) {
      return { id, title: String(error.code) }
    }
  },
})`

/** A plugin that never gives its thread back. */
const LOOP_CODE = `fxm.register({
  async search() { return {} },
  async track() { for (;;) {} },
})`

describe.skipIf(!enabled)(`plugins in ${ENGINE}`, { timeout: 60_000 }, () => {
  let browser: Browser
  let page: Page
  /** Every request that reached the browser's network layer for the test catalog. */
  const catalogRequests: string[] = []
  /**
   * Every request the browser sent for the open service the redirect test's plugin declares, and
   * for the host its redirect names, from the context's `request` events: a redirect's next hop
   * never reaches a route (Playwright sends it on itself), so only the events see it. The host
   * it names is under `.invalid`, which never resolves, so not even a hop can reach the network.
   */
  const serviceRequests: string[] = []

  beforeAll(async () => {
    const engines = await import('playwright-core')
    const { build } = await import('rolldown')
    const html = node
      .getBuiltinModule('node:fs')
      .readFileSync(new URL('../../../apps/web/sandbox/eval.html', import.meta.url), 'utf8')
    const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/u.exec(html)?.[1]
    if (meta === undefined) throw new Error('eval.html has no policy')
    // As stage 2.8's `_headers` serves it (`evaluatorHeaderPolicy` of @fxm/platform).
    const policy = `sandbox allow-scripts; ${meta}`
    if (!policy.includes(' worker-src blob:;')) throw new Error('eval.html allows no workers')
    const bundle = await build({
      input: decodeURIComponent(new URL('./testing/browser-entry.ts', import.meta.url).pathname),
      write: false,
      platform: 'browser',
      logLevel: 'silent',
      output: { format: 'iife', name: 'fxmPlugins' },
    })
    const script = bundle.output[0]?.code ?? ''
    // Headless and muted, with a throwaway profile: nothing shows or sounds on the machine.
    browser = await engines[ENGINE].launch({
      headless: true,
      ...(ENGINE === 'chromium' ? { args: ['--mute-audio'] } : {}),
      ...(ENGINE === 'firefox' ? { firefoxUserPrefs: { 'media.volume_scale': '0.0' } } : {}),
    })
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
      // The document as 1.11 first published it, whose policy allowed no workers.
      if (url.origin === APP && url.pathname === '/sandbox/eval-without-workers.html') {
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: { 'content-security-policy': policy.replace(' worker-src blob:;', '') },
          body: html.replace(' worker-src blob:;', ''),
        })
      }
      if (url.host === 'catalog.fxm-plugin.test') catalogRequests.push(url.href)
      // MusicBrainz, as a server that sends a plugin's request on to another host.
      if (url.host === 'musicbrainz.org') {
        return route.fulfill({
          status: 302,
          headers: {
            location: `https://elsewhere.fxm-plugin.invalid/landing${url.search}`,
            'access-control-allow-origin': '*',
          },
        })
      }
      return route.abort()
    })
    context.on('request', (sent) => {
      const { host, href } = new URL(sent.url())
      if (host === 'musicbrainz.org' || host.endsWith('.invalid')) serviceRequests.push(href)
    })
    page = await context.newPage()
    await page.goto(`${APP}/app/`)
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('tells, before any plugin is added, whether plugins can run in this engine', async () => {
    const runs = await page.evaluate(async () => {
      const fxm = (globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') })
        .fxmPlugins
      const runs = await fxm.probePluginWorkers(() => fxm.createSandboxEvaluator())
      // The probe's document is gone once it has answered.
      return { runs, frames: document.querySelectorAll('iframe').length }
    })
    // Yes in Chromium and Firefox; no in WebKit, which starts no worker in the document.
    expect(runs).toEqual({ runs: WORKERS, frames: 0 })
  })

  it.runIf(!WORKERS)('runs no plugin in an engine that starts no worker there', async () => {
    const result = await page.evaluate(async () => {
      const fxm = (globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') })
        .fxmPlugins
      const registry = fxm.createPluginRegistry({
        store: fxm.memoryPluginStore(),
        sandboxes: fxm.isolatedSandboxes(() => fxm.createSandboxEvaluator()),
      })
      await registry.load()
      await registry.install(await registry.offerFromFile(fxm.testPluginFile(), 'test.json'))
      const error = await registry
        .providers()[0]
        ?.metadata?.search('moths', { types: ['track'] }, fxm.testContext(fxm.fakeCatalogFetch()))
        .then(
          () => undefined,
          (caught: unknown) => caught as { pluginCode?: string; code?: string },
        )
      return { pluginCode: error?.pluginCode, code: error?.code }
    })
    expect(result).toEqual({ pluginCode: 'unavailable', code: 'Unsupported' })
  })

  it.runIf(WORKERS)(
    'installs the test plugin and runs it in an evaluator document, never in the page',
    async () => {
      const result = await page.evaluate(async () => {
        const fxm = (
          globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') }
        ).fxmPlugins
        const registry = fxm.createPluginRegistry({
          store: fxm.memoryPluginStore(),
          sandboxes: fxm.isolatedSandboxes(() => fxm.createSandboxEvaluator()),
        })
        await registry.load()
        await registry.install(await registry.offerFromFile(fxm.testPluginFile(), 'test.json'))
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
    },
  )

  it.runIf(WORKERS)(
    'runs each plugin in a worker of its own document, which reaches nothing but through the host',
    async () => {
      const result = await page.evaluate(async (probeCode) => {
        const fxm = (
          globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') }
        ).fxmPlugins
        const registry = fxm.createPluginRegistry({
          store: fxm.memoryPluginStore(),
          sandboxes: fxm.isolatedSandboxes(() => fxm.createSandboxEvaluator()),
        })
        await registry.load()
        await registry.install(await registry.offerFromFile(fxm.testPluginFile(), 'test.json'))
        await registry.install(
          await registry.offerFromFile(
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
      expect(result).toMatchObject({
        probe: {
          origin: 'null',
          document: 'undefined',
          webrtc: 'undefined undefined',
          postMessage: 'undefined',
          importScripts: 'NetworkError',
          navigate: 'TypeError',
          storage: 'SecurityError',
          viaHost: 200,
        },
        documents: 2,
      })
      // Blocked, each the engine's own way (Chromium's socket fails with an error event, Firefox's
      // throws at once).
      const { fetch, socket, nested } = result.probe as Record<string, unknown>
      expect([fetch, nested]).toEqual(['TypeError', 'TypeError'])
      expect(socket).not.toBe('open')
      // Nothing the plugin tried itself left the browser: no fetch, socket, import or navigation.
      expect(catalogRequests).toEqual([])
    },
  )

  it.runIf(WORKERS)(
    'runs no plugin where its document can’t start a worker, rather than run it in the document',
    async () => {
      const result = await page.evaluate(async () => {
        const fxm = (
          globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') }
        ).fxmPlugins
        const registry = fxm.createPluginRegistry({
          store: fxm.memoryPluginStore(),
          sandboxes: fxm.isolatedSandboxes(() =>
            fxm.createSandboxEvaluator({ url: '/sandbox/eval-without-workers.html' }),
          ),
        })
        await registry.load()
        await registry.install(await registry.offerFromFile(fxm.testPluginFile(), 'test.json'))
        const error = await registry
          .providers()[0]
          ?.metadata?.search('moths', { types: ['track'] }, fxm.testContext(fxm.fakeCatalogFetch()))
          .then(
            () => undefined,
            (caught: unknown) => caught as { pluginCode?: string; code?: string },
          )
        return { pluginCode: error?.pluginCode, code: error?.code }
      })
      expect(result).toEqual({ pluginCode: 'unavailable', code: 'Unsupported' })
    },
  )

  it.runIf(WORKERS)(
    'reports a plugin whose code doesn’t compile as one that can’t load',
    async () => {
      const result = await page.evaluate(async () => {
        const fxm = (
          globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') }
        ).fxmPlugins
        const registry = fxm.createPluginRegistry({
          store: fxm.memoryPluginStore(),
          sandboxes: fxm.isolatedSandboxes(() => fxm.createSandboxEvaluator()),
        })
        await registry.load()
        const code = 'fxm.register({ async search( {'
        await registry.install(
          await registry.offerFromFile(
            fxm.testPluginFile({ id: 'broken', name: 'Broken', provides: ['search'] }, code),
            'broken.json',
          ),
        )
        const error = await registry
          .providers()[0]
          ?.metadata?.search('moths', { types: ['track'] }, fxm.testContext(fxm.fakeCatalogFetch()))
          .then(
            () => undefined,
            (caught: unknown) => caught as { pluginCode?: string; code?: string },
          )
        return { pluginCode: error?.pluginCode, code: error?.code }
      })
      expect(result).toEqual({ pluginCode: 'load-failed', code: 'Unavailable' })
    },
  )

  it.runIf(WORKERS)(
    'follows no redirect from a declared service of FXM’s own to a host the plugin didn’t declare',
    async () => {
      const result = await page.evaluate(async (code) => {
        const fxm = (
          globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') }
        ).fxmPlugins
        // The web app's own transport: an open service goes straight from the page.
        const transport = fxm.createWebTransport({ budget: fxm.createRequestBudget() })
        const registry = fxm.createPluginRegistry({
          store: fxm.memoryPluginStore(),
          sandboxes: fxm.isolatedSandboxes(() => fxm.createSandboxEvaluator()),
        })
        await registry.load()
        await registry.install(
          await registry.offerFromFile(
            fxm.testPluginFile(
              {
                id: 'redirected',
                name: 'Redirected',
                provides: ['search', 'track'],
                hosts: ['musicbrainz.org'],
              },
              code,
            ),
            'redirected.json',
          ),
        )
        const track = await registry
          .providers()[0]
          ?.metadata?.getTrack(
            'plugin.redirected:track:what-the-user-searched' as never,
            fxm.testContext(transport.withPriority('interactive')),
          )
        return track?.title
      }, REDIRECTED_CODE)
      expect(result).toBe('redirect')
      // The browser stopped at the redirect: the host it named never got the plugin's URL.
      expect(serviceRequests).toEqual(['https://musicbrainz.org/ws/2/go?q=what-the-user-searched'])
    },
  )

  it.runIf(WORKERS)(
    'stops a plugin that loops forever, and the page goes on meanwhile',
    async () => {
      const result = await page.evaluate(async (loopCode) => {
        const fxm = (
          globalThis as never as { fxmPlugins: typeof import('./testing/browser-entry') }
        ).fxmPlugins
        const registry = fxm.createPluginRegistry({
          store: fxm.memoryPluginStore(),
          sandboxes: fxm.isolatedSandboxes(() => fxm.createSandboxEvaluator()),
          limits: { runner: { stepMs: 200, evaluateMs: 2_500 } },
        })
        await registry.load()
        await registry.install(
          await registry.offerFromFile(
            fxm.testPluginFile(
              { id: 'loop', name: 'Loop', provides: ['search', 'track'] },
              loopCode,
            ),
            'loop.json',
          ),
        )
        const ctx = fxm.testContext(fxm.fakeCatalogFetch())
        let ticks = 0
        const ticking = setInterval(() => {
          ticks += 1
        }, 50)
        const started = performance.now()
        const error = await registry
          .providers()[0]
          ?.metadata?.getTrack('plugin.loop:track:t1' as never, ctx)
          .then(
            () => undefined,
            (caught: unknown) => caught as { pluginCode?: string },
          )
        clearInterval(ticking)
        return {
          pluginCode: error?.pluginCode,
          seconds: Math.round((performance.now() - started) / 100) / 10,
          ticks,
        }
      }, LOOP_CODE)
      expect(result.pluginCode).toBe('timeout')
      // Stopped by its document's relay after about a second, well before the evaluator's timeout.
      expect(result.seconds).toBeLessThan(2.5)
      // The page's own timers ran all along: the loop held only the plugin's worker.
      expect(result.ticks).toBeGreaterThan(10)
    },
  )
})
