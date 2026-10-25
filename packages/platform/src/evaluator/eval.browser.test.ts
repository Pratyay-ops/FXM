/**
 * The committed `apps/web/sandbox/eval.html` in a real browser (Playwright's Chromium from
 * `.tools/playwright`), served with the policy stage 2.8 serves it with, and driven by the real
 * web host of `web.ts`. Every request is answered locally: the browser never touches the
 * network. It is not part of `make test`; run it with:
 *
 * ```sh
 * FXM_BROWSER=1 scripts/run.sh pnpm vitest run packages/platform/src/evaluator/eval.browser.test.ts
 * ```
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeBotGuardChallenge, fakeIntegrityToken, fakeWebPoToken } from '../testing/fake-botguard'
import { EVALUATOR_DOCUMENT_FILE, evaluatorHeaderPolicy, scriptHashOf } from './build'
import { EVALUATOR_CHANNEL } from './protocol'

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
const OTHER = 'https://other.test'
const YOUTUBE = 'https://www.youtube.com'

describe.skipIf(!enabled)('eval.html in Chromium', { timeout: 60_000 }, () => {
  let browser: Browser
  let context: BrowserContext

  beforeAll(async () => {
    const { chromium } = await import('playwright-core')
    const { build } = await import('rolldown')
    const html = node
      .getBuiltinModule('node:fs')
      .readFileSync(new URL(`../../../../${EVALUATOR_DOCUMENT_FILE}`, import.meta.url), 'utf8')
    const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? ''
    const policy = evaluatorHeaderPolicy(await scriptHashOf(script))
    const host = await build({
      input: decodeURIComponent(new URL('./web.ts', import.meta.url).pathname),
      write: false,
      platform: 'browser',
      logLevel: 'silent',
      output: { format: 'iife', name: 'fxmTest' },
    })
    const hostScript = host.output[0]?.code ?? ''
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext()
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      const page = (body: string, headers: Record<string, string> = {}) =>
        route.fulfill({ status: 200, contentType: 'text/html', headers, body })
      if (url.href === `${APP}/app/`) {
        return page(`<!doctype html><title>app</title><script>${hostScript}</script>`)
      }
      if (url.origin === APP && url.pathname === '/sandbox/eval.html') {
        return page(html, { 'content-security-policy': policy })
      }
      if (url.origin === APP && url.pathname === '/secret.json') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"secret":1}' })
      }
      if (url.href === `${OTHER}/`) return page('<!doctype html><title>other</title>')
      // Android's evaluator WebView loads the document with this base URL.
      if (url.href === `${YOUTUBE}/`) return page(html)
      return route.abort()
    })
  })

  afterAll(async () => {
    await browser?.close()
  })

  async function app(): Promise<Page> {
    const page = await context.newPage()
    await page.goto(`${APP}/app/`)
    return page
  }

  it('evaluates scripts in an opaque-origin document the app frames', async () => {
    const page = await app()
    const result = await page.evaluate(async () => {
      const { createSandboxEvaluator } = (
        globalThis as never as {
          fxmTest: typeof import('./web')
        }
      ).fxmTest
      const evaluator = createSandboxEvaluator()
      const info = await evaluator.ready()
      const sum = await evaluator.evaluate('return args.a + args.b', { a: 2, b: 40 })
      const origin = await evaluator.evaluate('return self.origin')
      const keyed = await evaluator.evaluate('return args * 2', 21, { key: 'double' })
      return { info, sum, origin, keyed }
    })
    expect(result).toEqual({
      info: { kind: 'web', version: 1, origin: APP },
      sum: 42,
      origin: 'null',
      keyed: 42,
    })
  })

  it('lets the document reach nothing: no network, no storage, no parent DOM', async () => {
    const page = await app()
    const result = await page.evaluate(async () => {
      const { createSandboxEvaluator } = (
        globalThis as never as {
          fxmTest: typeof import('./web')
        }
      ).fxmTest
      const evaluator = createSandboxEvaluator()
      return evaluator.evaluate(`
        const fetched = await fetch('/secret.json').then(() => 'fetched', (e) => 'blocked: ' + e.name)
        let storage
        try { storage = localStorage.length } catch (e) { storage = 'blocked: ' + e.name }
        let parentDom
        try { parentDom = parent.document.title } catch (e) { parentDom = 'blocked: ' + e.name }
        return { fetched, storage, parentDom }
      `)
    })
    expect(result).toEqual({
      fetched: 'blocked: TypeError',
      storage: 'blocked: SecurityError',
      parentDom: 'blocked: SecurityError',
    })
  })

  it('runs a BotGuard challenge and mints tokens without any network', async () => {
    const page = await app()
    const challenge = fakeBotGuardChallenge({ program: 'browser' })
    const integrityToken = fakeIntegrityToken('it-browser')
    const result = await page.evaluate(
      async ({ challenge, integrityToken }) => {
        const { createSandboxEvaluator } = (
          globalThis as never as {
            fxmTest: typeof import('./web')
          }
        ).fxmTest
        const evaluator = createSandboxEvaluator()
        const snapshot = await evaluator.botguardSnapshot(challenge)
        const tokens = await evaluator.mintWebPoTokens(integrityToken, ['video-1'])
        return { snapshot, tokens }
      },
      { challenge, integrityToken },
    )
    expect(result).toEqual({
      snapshot: 'snapshot:browser',
      tokens: [fakeWebPoToken('it-browser', 'video-1')],
    })
  })

  it('ignores a page on another site that frames it, even without the sandbox attribute', async () => {
    const page = await context.newPage()
    await page.goto(`${OTHER}/`)
    const answers = await page.evaluate(
      async ({ url, channel }) => {
        const frame = document.createElement('iframe')
        const answers: unknown[] = []
        addEventListener('message', (event) => answers.push(event.data))
        await new Promise((resolve) => {
          frame.onload = resolve
          frame.src = url
          document.body.append(frame)
        })
        frame.contentWindow?.postMessage(
          { channel, id: 1, method: 'evaluate', params: { source: 'return 1', args: null } },
          '*',
        )
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        return answers
      },
      { url: `${APP}/sandbox/eval.html`, channel: EVALUATOR_CHANNEL },
    )
    expect(answers).toEqual([])
  })

  it('exposes the mailbox when a native webview loads it by itself', async () => {
    const page = await context.newPage()
    await page.goto(`${YOUTUBE}/`)
    const result = await page.evaluate(async (channel) => {
      const mailbox = (
        window as never as {
          __fxmEvaluator: {
            hello: string
            receive(request: string): string
            take(id: number): string | null
          }
        }
      ).__fxmEvaluator
      const request = {
        channel,
        id: 3,
        method: 'evaluate',
        params: { source: 'return location.origin', args: null },
      }
      const accepted = mailbox.receive(JSON.stringify(request))
      let answer: string | null = null
      for (let tries = 0; answer === null && tries < 100; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        answer = mailbox.take(3)
      }
      return { hello: JSON.parse(mailbox.hello), accepted, answer: JSON.parse(answer ?? 'null') }
    }, EVALUATOR_CHANNEL)
    expect(result).toEqual({
      hello: { channel: EVALUATOR_CHANNEL, type: 'ready', version: 1, origin: YOUTUBE },
      accepted: 'accepted',
      answer: { channel: EVALUATOR_CHANNEL, id: 3, ok: true, result: YOUTUBE },
    })
  })
})
