/**
 * The sandbox documents in real browsers (Chromium and Firefox), against the test network's
 * mocks of InnerTube, googlevideo and a user host (`network.ts`). Nothing here reaches the
 * internet: the proxy refuses every host it does not serve.
 */

import type { Frame, Page } from '@playwright/test'
import { sandboxDocumentHeader } from '../csp.ts'
import { SANDBOX_INNERTUBE_HOSTS, SANDBOX_INNERTUBE_PATHS } from '../document.ts'
import { expect, test } from './fixtures.ts'
import type { Rung } from './harness/harness.ts'
import {
  BLOCKED_HOST,
  CAPPED_BYTES,
  FXM,
  FXM_HOST,
  GOOGLEVIDEO_HOST,
  INNERTUBE_HOSTS,
  OTHER_HOST,
  USER_HOST,
} from './network.ts'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const BROWSE = 'https://music.youtube.com/youtubei/v1/browse'
const PLAYER = 'https://www.youtube.com/youtubei/v1/player'
const CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20261020.10.00', hl: 'en' }
const payload = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ context: { client: CLIENT }, ...fields })

/** What youtubei.js sends: JSON with InnerTube's headers, each of which needs a preflight. */
const RICH_HEADERS = {
  'Content-Type': 'application/json',
  'X-Goog-Visitor-Id': 'CgtNb2NrVmlzaXRvcg%3D%3D',
  'X-YouTube-Client-Name': '67',
  'X-YouTube-Client-Version': CLIENT.clientVersion,
}

const LADDER: Rung[] = [
  {
    name: 'VISIONOS',
    url: PLAYER,
    client: { clientName: 'VISIONOS', clientVersion: '1.02', hl: 'en' },
    pick: 'audio',
  },
  {
    name: 'ANDROID',
    url: PLAYER,
    client: { clientName: 'ANDROID', clientVersion: '21.03.36', hl: 'en' },
    pick: 'itag18',
  },
]

/** The frame of a sandbox document in the page. */
async function sandboxFrame(page: Page, kind: 'innertube' | 'userhost'): Promise<Frame> {
  const url = `${FXM}/sandbox/${kind}.html`
  await expect.poll(() => page.frames().some((frame) => frame.url() === url)).toBe(true)
  const frame = page.frames().find((candidate) => candidate.url() === url) as Frame
  await frame.waitForLoadState()
  return frame
}

/** Fetches from inside a frame, past every check of the document's script. */
function fetchFrom(frame: Frame, url: string, init: Record<string, unknown> = {}) {
  return frame.evaluate(
    async ([target, options]) => {
      try {
        const response = await fetch(target, { credentials: 'omit', ...options })
        return `reached ${response.status}`
      } catch {
        return 'blocked'
      }
    },
    [url, init] as const,
  )
}

/** The marker a sandbox document's script sets while it listens for its page. */
const marker = () => document.documentElement.getAttribute('data-fxm-sandbox')

test.describe('the sandbox documents', () => {
  test('are served with the sandbox header, so they are opaque even at top level', async ({
    page,
  }) => {
    for (const kind of ['innertube', 'userhost'] as const) {
      const response = await page.goto(`${FXM}/sandbox/${kind}.html`)
      const policy = response?.headers()['content-security-policy'] ?? ''
      expect(policy).toMatch(/^sandbox allow-scripts; default-src 'none'; script-src 'sha256-/)
      expect(policy).toBe(await sandboxDocumentHeader(kind, (await response?.text()) ?? ''))
      expect(response?.headers()['referrer-policy']).toBe('no-referrer')
      expect(await page.evaluate(() => self.origin)).toBe('null')
      // At top level the script finds no parent to talk to, and waits for nothing.
      expect(await page.evaluate(marker)).toBeNull()
    }
  })

  test('send allowlisted calls from an opaque origin, CORS-simple, each from the budget', async ({
    harness,
    network,
  }) => {
    expect(await harness.start()).toMatchObject({ youtube: 'simple', mediaBytes: false })
    expect(await harness.frames()).toEqual([
      { src: `${FXM}/sandbox/innertube.html`, sandbox: 'allow-scripts', hidden: true },
    ])
    for (const host of SANDBOX_INNERTUBE_HOSTS) {
      for (const path of SANDBOX_INNERTUBE_PATHS) {
        const result = await harness.fetch(`https://${host}${path}`, {
          method: 'POST',
          headers: RICH_HEADERS,
          body: payload({ query: 'creep', input: 'cre', videoId: 'mockSong001' }),
        })
        expect([host, path, result.ok && result.status]).toEqual([host, path, 200])
      }
    }
    const calls = INNERTUBE_HOSTS.flatMap((host) => network.requests(host, '/youtubei/v1/'))
    // The self-test, then 15 calls.
    expect(calls).toHaveLength(16)
    for (const call of calls) {
      expect(call).toMatchObject({
        method: 'POST',
        status: 200,
        origin: 'null',
        contentType: 'text/plain;charset=UTF-8',
      })
      expect([call.referer, call.cookie, call.requestHeaders]).toEqual([
        undefined,
        undefined,
        undefined,
      ])
      expect(call.path).toContain('prettyPrint=false')
    }
    // The headers youtubei.js sends moved into context.client.
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({
      context: { client: { visitorData: RICH_HEADERS['X-Goog-Visitor-Id'] } },
    })
    expect(await harness.budget()).toMatchObject({ used: 16 })
  })

  test('refuse other hosts and paths, and reach no other host even when asked directly', async ({
    harness,
    network,
    page,
  }) => {
    await harness.start()
    const post = { method: 'POST', headers: {}, body: payload() }
    // The page's own check.
    const elsewhere = await harness.innerTube(`https://${BLOCKED_HOST}/youtubei/v1/search`, post)
    const otherPath = await harness.innerTube('https://www.youtube.com/youtubei/v1/att/get', post)
    expect([elsewhere, otherPath]).toMatchObject([
      { ok: false, error: { code: 'Unsupported', sandboxCode: 'forbidden-host' } },
      { ok: false, error: { code: 'Unsupported', sandboxCode: 'forbidden-path' } },
    ])
    // The document's own check, with messages the page would never send.
    const raw = await harness.raw('/sandbox/innertube.html', [
      { id: 'a', url: `https://${BLOCKED_HOST}/youtubei/v1/search`, ...post },
      { id: 'b', url: 'https://www.youtube.com/youtubei/v1/att/get', ...post },
      { id: 'c', url: 'https://www.youtube.com/watch?v=mockSong001', ...post },
      { id: 'd', url: `https://${USER_HOST}/api/v1/stats`, ...post },
    ])
    expect(raw.hello).toEqual({
      origin: 'null',
      data: { type: 'fxm-sandbox:hello', protocol: 1, document: 'innertube' },
    })
    expect(raw.replies.map((reply) => (reply as { code?: string }).code)).toEqual([
      'forbidden-host',
      'forbidden-path',
      'forbidden-path',
      'forbidden-host',
    ])
    // Past the script: the document's policy lets it reach InnerTube's hosts only.
    await harness.fetch(SEARCH, { method: 'POST', body: payload() })
    const frame = await sandboxFrame(page, 'innertube')
    expect(await frame.evaluate(() => self.origin)).toBe('null')
    expect(await frame.evaluate(marker)).toBe('listening')
    for (const url of [
      `https://${BLOCKED_HOST}/`,
      `${FXM}/harness.html`,
      `https://${USER_HOST}/`,
    ]) {
      expect([url, await fetchFrom(frame, url)]).toEqual([url, 'blocked'])
    }
    // The policy names hosts, not paths: the script's allowlist is what keeps paths out.
    expect(
      await fetchFrom(frame, 'https://www.youtube.com/youtubei/v1/att/get', {
        method: 'POST',
        body: '{}',
      }),
    ).toBe('reached 404')
    expect(network.log.filter((entry) => entry.host === BLOCKED_HOST)).toEqual([])
    expect(network.requests(USER_HOST)).toEqual([])
    expect(network.requests(FXM_HOST, '/harness.html')).toHaveLength(1)
  })

  test('fail preflighted request shapes with a typed error', async ({ harness, network, page }) => {
    await harness.start()
    const body = payload({ query: 'creep' })
    const shapes = [
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      { method: 'POST', headers: { 'x-goog-visitor-id': 'v' }, body },
      { method: 'PUT', headers: {}, body },
    ]
    for (const shape of shapes) {
      expect(await harness.innerTube(SEARCH, shape)).toMatchObject({
        ok: false,
        error: { name: 'FxmError', code: 'Unsupported', sandboxCode: 'preflight' },
      })
    }
    const raw = await harness.raw(
      '/sandbox/innertube.html',
      shapes.map((shape, index) => ({ id: String(index), url: SEARCH, ...shape })),
    )
    expect(raw.replies.map((reply) => (reply as { code?: string }).code)).toEqual([
      'preflight',
      'preflight',
      'preflight',
    ])
    expect(network.requests('music.youtube.com', '/youtubei/v1/search')).toEqual([])

    // Why: InnerTube answers the preflight of such a request from the sandbox with 403.
    await harness.fetch(SEARCH, { method: 'POST', body })
    const frame = await sandboxFrame(page, 'innertube')
    expect(
      await fetchFrom(frame, SEARCH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    ).toBe('blocked')
    const preflight = network
      .requests('music.youtube.com')
      .find((entry) => entry.method === 'OPTIONS')
    expect(preflight).toMatchObject({ origin: 'null', status: 403 })

    // The transport turns youtubei.js's shape into the simple one, so a provider's call works.
    const rich = await harness.fetch(SEARCH, { method: 'POST', headers: RICH_HEADERS, body })
    expect(rich).toMatchObject({ ok: true, status: 200 })
  })

  test('are what makes InnerTube answer: the page’s own origin gets 403', async ({
    harness,
    network,
  }) => {
    await harness.start()
    const result = await harness.pageFetch(SEARCH, { method: 'POST', body: payload() })
    expect(result).toMatchObject({ ok: false, error: { name: 'TypeError' } })
    expect(network.requests('music.youtube.com', '/youtubei/v1/search').at(-1)).toMatchObject({
      origin: FXM,
      status: 403,
    })
  })

  test('framed by another site without the attribute: opaque, and silent', async ({
    page,
    network,
  }) => {
    for (const kind of ['innertube', 'userhost'] as const) {
      network.log.length = 0
      await page.goto(`https://${OTHER_HOST}/frame.html?document=${kind}`)
      const frame = await sandboxFrame(page, kind)
      expect(await frame.evaluate(() => self.origin)).toBe('null')
      // The script runs and listens: the silence below comes from its checks.
      expect(await frame.evaluate(marker)).toBe('listening')
      const request = {
        type: 'fxm-sandbox:request',
        id: 'other-site',
        url:
          kind === 'innertube'
            ? `${SEARCH}?prettyPrint=false`
            : `https://${USER_HOST}/api/v1/stats`,
        method: kind === 'innertube' ? 'POST' : 'GET',
        headers: {},
        ...(kind === 'innertube' ? { body: payload() } : {}),
      }
      const result = await page.evaluate(
        (message) =>
          (
            window as unknown as {
              probe(
                requests: unknown[],
              ): Promise<{ windowMessages: unknown[]; portReplies: unknown[] }>
            }
          ).probe([message]),
        request,
      )
      expect(result).toEqual({ windowMessages: [], portReplies: [] })
      expect(network.requests('music.youtube.com')).toEqual([])
      expect(network.requests(USER_HOST)).toEqual([])
    }
  })

  test('answer only their parent: a frame of the FXM origin next to them gets nothing', async ({
    page,
    network,
  }) => {
    await page.goto(`${FXM}/sibling.html`)
    await sandboxFrame(page, 'innertube')
    const helper = page.frames().find((frame) => frame.url() === `${FXM}/helper.html`) as Frame
    await helper.waitForLoadState()
    const request = {
      type: 'fxm-sandbox:request',
      id: 'sibling',
      url: `${SEARCH}?prettyPrint=false`,
      method: 'POST',
      headers: {},
      body: payload(),
    }
    const probe = (message: unknown) =>
      (window as unknown as { probe(m: unknown): Promise<unknown[]> }).probe(message)
    expect(await helper.evaluate(probe, request)).toEqual([])
    expect(network.requests('music.youtube.com')).toEqual([])
    // The same request from the document's real parent is answered.
    expect(await page.evaluate(probe, request)).toMatchObject([
      { type: 'fxm-sandbox:response', id: 'sibling', status: 200 },
    ])
    expect(network.requests('music.youtube.com')).toMatchObject([{ origin: 'null', status: 200 }])
  })

  test('make Lite depend on the self-test, and the kill switch turns it off', async ({
    harness,
    network,
  }) => {
    network.state.refuseOpaque = true
    expect(await harness.start()).toMatchObject({ youtube: 'none' })
    network.state.refuseOpaque = false
    expect(await harness.retest()).toMatchObject({ youtube: 'simple' })

    await harness.setKilled(true)
    expect(await harness.liteReady()).toBe(false)
    expect(await harness.refresh()).toMatchObject({ youtube: 'none' })
    const before = network.requests('music.youtube.com').length
    expect(await harness.fetch(SEARCH, { method: 'POST', body: payload() })).toMatchObject({
      ok: false,
      error: { code: 'Unsupported' },
    })
    expect(network.requests('music.youtube.com')).toHaveLength(before)

    // Switched off from the start: no frame, no self-test.
    network.log.length = 0
    expect(await harness.start({ killed: true })).toMatchObject({ youtube: 'none' })
    expect(await harness.frames()).toEqual([])
    expect(INNERTUBE_HOSTS.flatMap((host) => network.requests(host))).toEqual([])
    await harness.setKilled(false)
    expect(await harness.retest()).toMatchObject({ youtube: 'simple' })
  })

  test('cap and time out requests, with typed errors', async ({ harness }) => {
    await harness.start({ innerTube: { timeoutMs: 1000 } })
    const slow = await harness.fetch(BROWSE, {
      method: 'POST',
      body: payload({ browseId: 'FXM_SLOW' }),
    })
    expect(slow).toMatchObject({ ok: false, error: { code: 'Network', sandboxCode: 'timeout' } })
    const huge = await harness.fetch(BROWSE, {
      method: 'POST',
      body: payload({ browseId: 'FXM_HUGE' }),
    })
    expect(huge).toMatchObject({ ok: false, error: { code: 'Parse', sandboxCode: 'too-large' } })
  })

  test('fetch from user hosts through userhost.html: GET only, without headers, capped', async ({
    harness,
    network,
  }) => {
    await harness.start({ userHosts: [USER_HOST] })
    const stats = await harness.fetch(`https://${USER_HOST}/api/v1/stats`, {
      headers: { accept: 'application/json' },
    })
    expect(stats).toMatchObject({ ok: true, status: 200 })
    expect(stats.ok && JSON.parse(stats.text)).toMatchObject({ software: { name: 'invidious' } })
    expect(network.requests(USER_HOST)).toMatchObject([
      { method: 'GET', origin: 'null', status: 200 },
    ])
    expect([
      network.requests(USER_HOST)[0]?.cookie,
      network.requests(USER_HOST)[0]?.referer,
    ]).toEqual([undefined, undefined])
    expect(await harness.frames()).toContainEqual({
      src: `${FXM}/sandbox/userhost.html`,
      sandbox: 'allow-scripts',
      hidden: true,
    })
    const post = await harness.fetch(`https://${USER_HOST}/api/v1/stats`, {
      method: 'POST',
      body: 'x',
    })
    expect(post).toMatchObject({ ok: false, error: { code: 'Unsupported' } })
    const big = await harness.fetch(`https://${USER_HOST}/big`)
    expect(big).toMatchObject({ ok: false, error: { code: 'Parse', sandboxCode: 'too-large' } })
    const notAdded = await harness.fetch(`https://${BLOCKED_HOST}/api/v1/stats`)
    expect(notAdded).toMatchObject({ ok: false, error: { code: 'Unsupported' } })
    expect(network.requests(USER_HOST)).toHaveLength(2)
  })
})

test.describe('capped-URL fallback', () => {
  test('a capped VISIONOS URL fails <audio>, and the harness plays itag 18 instead', async ({
    harness,
    network,
  }) => {
    await harness.start()
    const rungs = await harness.resolveAndPlay({
      videoId: 'mockSong001',
      ladder: LADDER,
      stallMs: 15_000,
      playMs: 1500,
    })
    expect(rungs).toMatchObject([
      { name: 'VISIONOS', status: 200, playability: 'OK', itag: 251 },
      { name: 'ANDROID', status: 200, playability: 'OK', itag: 18, outcome: 'playing' },
    ])
    expect(rungs[0]?.outcome).toMatch(/^error \d$/)
    expect(rungs[1]?.currentTime).toBeGreaterThan(0)

    const media = network.requests(GOOGLEVIDEO_HOST)
    const capped = media.filter((entry) => entry.path?.includes('fxm=capped'))
    const full = media.filter((entry) => entry.path?.includes('fxm=full'))
    // The browser asks for the whole file at once; a URL capped at 1 MiB refuses that.
    expect(capped[0]).toMatchObject({ range: 'bytes=0-', status: 403 })
    expect(capped.every((entry) => entry.status === 403)).toBe(true)
    expect(full.length).toBeGreaterThan(0)
    expect(full.every((entry) => entry.status === 200 || entry.status === 206)).toBe(true)
    // googlevideo never learns which site plays it.
    expect(media.every((entry) => entry.referer === undefined)).toBe(true)
    expect(CAPPED_BYTES).toBe(1024 * 1024)
    // The self-test and two /player calls.
    expect(await harness.budget()).toMatchObject({ used: 3 })
  })
})
