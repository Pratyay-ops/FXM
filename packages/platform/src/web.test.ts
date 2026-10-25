import { isFxmError } from '@fxm/core'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestBudget } from './budget'
import { type ConnectStatus, type ConnectWindow, createConnectClient } from './connect'
import { isCorsSimpleRequest } from './cors'
import { SIMPLE_CONTENT_TYPE } from './innertube'
import { createLiteTier, type KillSwitches } from './lite'
import { memoryStorage } from './storage'
import { createFakeClock } from './testing/fake-clock'
import { FAKE_CONNECT_FEATURES, installFakeConnect } from './testing/fake-connect'
import { createFakeSandbox, type FakeSandboxOptions } from './testing/fake-sandbox'
import { createWebTransport } from './web'

/** Messages travel on happy-dom's real timers, which a busy machine can slow down a lot. */
const PATIENCE = { timeout: 10_000 }

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const PLAYER = 'https://www.youtube.com/youtubei/v1/player'
const MEDIA = 'https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback?itag=251&expire=1'
const GRAPHQL = 'https://api-partner.spotify.com/pathfinder/v2/query'
const STATION = 'https://www.last.fm/player/station/music/Radiohead?ajax=1'
const LYRICS = 'https://lrclib.net/api/get?track_name=Creep&artist_name=Radiohead'

const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'creep' })

const connected = (features: readonly string[] = FAKE_CONNECT_FEATURES): ConnectStatus => ({
  state: 'present',
  version: '0.1.0',
  features,
})

interface TierOptions {
  connect?: ConnectStatus
  sandbox?: FakeSandboxOptions | false
  killSwitches?: () => KillSwitches
  userHosts?: string[]
  respond?: (url: string, init: RequestInit) => Response
}

async function tier(options: TierOptions = {}) {
  const clock = createFakeClock(Date.UTC(2026, 9, 25))
  const budget = createRequestBudget({ clock })
  const pageFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    options.respond ? options.respond(String(input), init ?? {}) : Response.json({ ok: true }),
  )
  const sandbox = options.sandbox === false ? undefined : createFakeSandbox(options.sandbox ?? {})
  const lite =
    sandbox === undefined
      ? undefined
      : createLiteTier({
          sandbox,
          ...(options.killSwitches ? { killSwitches: options.killSwitches } : {}),
        })
  await lite?.check()
  const connect = { status: options.connect }
  const transport = createWebTransport({
    fetch: pageFetch as typeof fetch,
    connect,
    budget,
    ...(lite ? { lite } : {}),
    ...(options.userHosts ? { userHosts: () => options.userHosts as string[] } : {}),
  })
  return { transport, pageFetch, sandbox, budget, clock, connect }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

async function refusedAsUnsupported(promise: Promise<unknown>): Promise<boolean> {
  return isFxmError(await rejection(promise), 'Unsupported')
}

const innerTubeInit = (): RequestInit => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Goog-Visitor-Id': 'visitor',
    'X-YouTube-Client-Name': '67',
    Authorization: 'Bearer nope',
  },
  body: BODY,
})

describe('the Free tier (no FXM Connect, no Lite)', () => {
  it('fetches CORS-friendly hosts directly, without credentials or a page-set Origin', async () => {
    const { transport, pageFetch } = await tier({ sandbox: false })
    await transport.fetch(LYRICS, {
      headers: {
        Accept: 'application/json',
        Origin: 'https://evil.example',
        Cookie: 'a=b',
        'User-Agent': 'FXM/0.1 (+https://github.com/Pratyay-ops/FXM)',
      },
      credentials: 'include',
    })
    expect(pageFetch).toHaveBeenCalledOnce()
    const [url, init] = pageFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(LYRICS)
    expect(init.credentials).toBe('omit')
    expect(init.headers).toEqual({ accept: 'application/json' })
  })

  it.each([
    ['an InnerTube call', SEARCH],
    ['a YouTube page', 'https://www.youtube.com/sw.js_data'],
    ['googlevideo bytes', MEDIA],
    ['Spotify', GRAPHQL],
    ['a Last.fm station', STATION],
    ['an unknown host', 'https://example.com/'],
  ])('refuses %s with Unsupported', async (_case, url) => {
    const { transport, pageFetch } = await tier({ sandbox: false })
    expect(await refusedAsUnsupported(transport.fetch(url, innerTubeInit()))).toBe(true)
    expect(pageFetch).not.toHaveBeenCalled()
  })

  it('refuses InnerTube when the Lite self-test failed', async () => {
    const { transport } = await tier({ sandbox: { selfTest: false } })
    expect(await refusedAsUnsupported(transport.fetch(SEARCH, innerTubeInit()))).toBe(true)
  })
})

describe('the Lite tier (sandbox, no FXM Connect)', () => {
  it('sends InnerTube calls through the sandbox in the CORS-simple shape', async () => {
    const { transport, pageFetch, sandbox, budget } = await tier({
      sandbox: { respond: () => Response.json({ contents: 'results' }) },
    })
    const response = await transport.fetch(SEARCH, innerTubeInit())
    await expect(response.json()).resolves.toEqual({ contents: 'results' })
    expect(pageFetch).not.toHaveBeenCalled()
    const [request] = sandbox?.requests ?? []
    expect(request?.url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(request?.init.headers).toEqual({ 'content-type': SIMPLE_CONTENT_TYPE })
    expect(isCorsSimpleRequest('POST', Object.entries(request?.init.headers ?? {}))).toBe(true)
    expect(JSON.parse(request?.init.body ?? '{}').context.client.visitorData).toBe('visitor')
    expect(budget.snapshot().used).toBe(1)
  })

  it.each([
    ['a YouTube page', 'https://www.youtube.com/s/player/abc/base.js'],
    ['googlevideo bytes', MEDIA],
    ['Spotify', GRAPHQL],
    ['a Last.fm station', STATION],
  ])('still refuses %s', async (_case, url) => {
    const { transport, sandbox } = await tier()
    expect(await refusedAsUnsupported(transport.fetch(url))).toBe(true)
    expect(sandbox?.requests).toEqual([])
  })

  it('stops using the sandbox the moment the kill switch is set', async () => {
    let switches: KillSwitches = {}
    const { transport } = await tier({ killSwitches: () => switches })
    await expect(transport.fetch(SEARCH, innerTubeInit())).resolves.toBeInstanceOf(Response)
    switches = { lite: true }
    expect(await refusedAsUnsupported(transport.fetch(SEARCH, innerTubeInit()))).toBe(true)
  })

  it('draws no budget for a call the sandbox could never send', async () => {
    const { transport, budget } = await tier({ sandbox: false })
    await rejection(transport.fetch(SEARCH, innerTubeInit()))
    expect(budget.snapshot().used).toBe(0)
  })
})

describe('the Full tier (FXM Connect)', () => {
  it('sends InnerTube calls through the page in the CORS-simple shape, even with Lite ready', async () => {
    const { transport, pageFetch, sandbox } = await tier({ connect: connected() })
    await transport.fetch(SEARCH, innerTubeInit())
    expect(sandbox?.requests).toEqual([])
    const [url, init] = pageFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': SIMPLE_CONTENT_TYPE },
    })
    expect(Object.keys(init.headers as object)).toEqual(['content-type'])
  })

  it.each([
    ['a YouTube page', 'https://www.youtube.com/sw.js_data', { Accept: '*/*' }],
    ['googlevideo bytes', MEDIA, { Range: 'bytes=0-65535' }],
    ['Spotify', GRAPHQL, { Authorization: 'Bearer token', 'Content-Type': 'application/json' }],
    ['a Last.fm station', STATION, { Accept: 'application/json' }],
  ])('fetches %s through the page, keeping its own headers', async (_case, url, headers) => {
    const { transport, pageFetch } = await tier({ connect: connected() })
    await transport.fetch(url, { headers, credentials: 'include' })
    const [sentUrl, init] = pageFetch.mock.calls[0] as [string, RequestInit]
    expect(sentUrl).toBe(url)
    expect(init.credentials).toBe('omit')
    expect(init.headers).toEqual(
      Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    )
  })

  it.each([
    ['youtube', SEARCH],
    ['youtube', 'https://www.youtube.com/sw.js_data'],
    ['googlevideo', MEDIA],
    ['spotify', GRAPHQL],
    ['lastfm', STATION],
  ])('needs the %s feature for %s', async (feature, url) => {
    const features = FAKE_CONNECT_FEATURES.filter((name) => name !== feature)
    const { transport } = await tier({ connect: connected(features), sandbox: false })
    expect(await refusedAsUnsupported(transport.fetch(url, innerTubeInit()))).toBe(true)
  })

  it('opens no route for an outdated FXM Connect, but keeps the Lite tier', async () => {
    const outdated: ConnectStatus = { ...connected(), state: 'outdated' }
    const { transport, sandbox, pageFetch } = await tier({ connect: outdated })
    expect(await refusedAsUnsupported(transport.fetch(MEDIA))).toBe(true)
    await transport.fetch(SEARCH, innerTubeInit())
    expect(sandbox?.requests).toHaveLength(1)
    expect(pageFetch).not.toHaveBeenCalled()
  })

  it('follows FXM Connect’s status on every request', async () => {
    const { transport, connect } = await tier({ sandbox: false })
    expect(await refusedAsUnsupported(transport.fetch(MEDIA))).toBe(true)
    connect.status = connected()
    await expect(transport.fetch(MEDIA)).resolves.toBeInstanceOf(Response)
  })

  it('forwards the body of a Request, such as a Spotify GraphQL query', async () => {
    const { transport, pageFetch } = await tier({ connect: connected() })
    const query = JSON.stringify({ operationName: 'searchDesktop', variables: { q: 'creep' } })
    await transport.fetch(
      new Request(GRAPHQL, {
        method: 'POST',
        body: query,
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      }),
    )
    const [, init] = pageFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(query)
    expect(init.headers).toEqual({ 'content-type': 'application/json;charset=UTF-8' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('the request budget', () => {
  it('counts InnerTube and other YouTube requests, but not other hosts', async () => {
    const { transport, budget } = await tier({ connect: connected() })
    await transport.fetch(SEARCH, innerTubeInit())
    await transport.fetch('https://www.youtube.com/sw.js_data')
    await transport.fetch(MEDIA)
    await transport.fetch(LYRICS)
    expect(budget.snapshot().used).toBe(2)
  })

  it('pauses bulk work when InnerTube answers 429', async () => {
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => new Response('', { status: 429 }),
    })
    const response = await transport.fetch(SEARCH, innerTubeInit())
    expect(response.status).toBe(429)
    expect(budget.snapshot().lastBotCheck?.cause).toBe('rate-limited')
    expect(budget.snapshot().bulkPausedUntil).toBeDefined()
  })

  it('pauses bulk work when a YouTube page answers 429', async () => {
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => new Response('', { status: 429 }),
    })
    await transport.fetch('https://www.youtube.com/sw.js_data')
    expect(budget.snapshot().lastBotCheck?.cause).toBe('rate-limited')
  })

  it('pauses bulk work on LOGIN_REQUIRED from /player, and leaves the body readable', async () => {
    const player = {
      playabilityStatus: {
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
      },
    }
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => Response.json(player),
    })
    const response = await transport.fetch(PLAYER, innerTubeInit())
    await expect(response.json()).resolves.toEqual(player)
    expect(budget.snapshot().lastBotCheck?.cause).toBe('login-required')
  })

  it.each([
    ['a playable /player response', PLAYER, { playabilityStatus: { status: 'OK' } }],
    ['LOGIN_REQUIRED elsewhere in /player', PLAYER, { note: 'LOGIN_REQUIRED' }],
    [
      'LOGIN_REQUIRED in a search result',
      SEARCH,
      { playabilityStatus: { status: 'LOGIN_REQUIRED' } },
    ],
  ])('reports nothing for %s', async (_case, url, body) => {
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => Response.json(body),
    })
    await transport.fetch(url, innerTubeInit())
    expect(budget.snapshot().lastBotCheck).toBeUndefined()
  })

  it('reports nothing when the /player body is not JSON or not OK', async () => {
    const answers = [
      new Response('LOGIN_REQUIRED but not JSON'),
      new Response('{"playabilityStatus":{"status":"LOGIN_REQUIRED"}}', { status: 500 }),
    ]
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => answers.shift() as Response,
    })
    await transport.fetch(PLAYER, innerTubeInit())
    await transport.fetch(PLAYER, innerTubeInit())
    expect(budget.snapshot().lastBotCheck).toBeUndefined()
  })

  it('draws at the priority of the fetch it came through', async () => {
    const { transport, budget, clock } = await tier({ connect: connected() })
    expect(transport.withPriority('interactive')).toBe(transport.fetch)
    expect(transport.withPriority('bulk')).toBe(transport.withPriority('bulk'))
    await transport.withPriority('bulk')(SEARCH, innerTubeInit())
    let second = false
    void transport
      .withPriority('bulk')(SEARCH, innerTubeInit())
      .then(() => {
        second = true
      })
    await clock.advanceAsync(4_999)
    expect(second).toBe(false)
    await transport.withPriority('current-track')(SEARCH, innerTubeInit())
    await clock.advanceAsync(1)
    expect(second).toBe(true)
    expect(budget.snapshot().used).toBe(3)
  })

  it('refuses unknown priorities', async () => {
    const { transport } = await tier()
    expect(() => transport.withPriority('urgent' as never)).toThrow(/Unknown request priority/)
  })

  it('refuses at once when the signal is already aborted', async () => {
    const { transport, budget, pageFetch } = await tier({ connect: connected() })
    const signal = AbortSignal.abort(new Error('gone'))
    const error = await rejection(transport.fetch(SEARCH, { ...innerTubeInit(), signal }))
    expect((error as Error).message).toBe('gone')
    expect(budget.snapshot().used).toBe(0)
    expect(pageFetch).not.toHaveBeenCalled()
  })
})

describe('hosts the user added', () => {
  const INSTANCE = 'https://invidious.example.org:8443/api/v1/videos/x'

  it('go through the sandbox’s user-host document, GET only and without headers', async () => {
    const { transport, sandbox, pageFetch } = await tier({
      userHosts: [' Invidious.Example.org:8443 '],
      sandbox: { userHost: () => Response.json({ title: 'x' }) },
    })
    const response = await transport.fetch(INSTANCE, { headers: { Authorization: 'x' } })
    await expect(response.json()).resolves.toEqual({ title: 'x' })
    expect(sandbox?.userHostRequests).toEqual([{ url: INSTANCE, init: { method: 'GET' } }])
    await transport.fetch(INSTANCE, { method: 'HEAD', signal: new AbortController().signal })
    expect(sandbox?.userHostRequests[1]?.init.method).toBe('HEAD')
    expect(pageFetch).not.toHaveBeenCalled()
    expect(
      await refusedAsUnsupported(transport.fetch(INSTANCE, { method: 'POST', body: 'x' })),
    ).toBe(true)
  })

  it('are refused without the sandbox documents, and when not added', async () => {
    const withoutDocument = await tier({ userHosts: ['invidious.example.org:8443'] })
    expect(await refusedAsUnsupported(withoutDocument.transport.fetch(INSTANCE))).toBe(true)
    const notAdded = await tier({ sandbox: { userHost: () => Response.json({}) } })
    expect(await refusedAsUnsupported(notAdded.transport.fetch(INSTANCE))).toBe(true)
    const plainHttp = await tier({
      userHosts: ['invidious.example.org'],
      sandbox: { userHost: () => Response.json({}) },
    })
    expect(
      await refusedAsUnsupported(plainHttp.transport.fetch('http://invidious.example.org/')),
    ).toBe(true)
  })
})

describe('defaults', () => {
  it('uses the global fetch and a budget of its own when given nothing', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    try {
      const transport = createWebTransport()
      await transport.fetch(LYRICS)
      expect(spy).toHaveBeenCalledOnce()
      expect(transport.budget.snapshot().used).toBe(0)
      expect(await refusedAsUnsupported(transport.fetch(SEARCH, innerTubeInit()))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('all three tiers against the fake FXM Connect and the fake sandbox', () => {
  const pages: { happyDOM: { close(): Promise<void> } }[] = []
  afterEach(async () => {
    await Promise.all(pages.splice(0).map((page) => page.happyDOM.close()))
  })

  async function page(selfTest: boolean) {
    const window = new Window({ url: 'https://fxm-music.pages.dev/app/' })
    pages.push(window)
    const view = window as unknown as ConnectWindow
    const connect = createConnectClient({ window: view, storage: memoryStorage() })
    const sandbox = createFakeSandbox({ selfTest })
    const lite = createLiteTier({ sandbox })
    await lite.check()
    const pageFetch = vi.fn(async () => Response.json({}))
    const transport = createWebTransport({
      fetch: pageFetch as typeof fetch,
      connect,
      lite,
      budget: createRequestBudget(),
    })
    return { view, connect, sandbox, pageFetch, transport }
  }

  it('Free only: no YouTube, Spotify or Last.fm, free sources direct', async () => {
    const { connect, transport, pageFetch } = await page(false)
    expect((await connect.detect()).state).toBe('absent')
    await transport.fetch(LYRICS)
    expect(pageFetch).toHaveBeenCalledOnce()
    for (const url of [SEARCH, MEDIA, GRAPHQL, STATION]) {
      expect(await refusedAsUnsupported(transport.fetch(url, innerTubeInit()))).toBe(true)
    }
    connect.dispose()
  })

  it('Lite: InnerTube through the sandbox, nothing else of YouTube, Spotify or Last.fm', async () => {
    const { connect, transport, sandbox, pageFetch } = await page(true)
    await connect.detect()
    await transport.fetch(SEARCH, innerTubeInit())
    expect(sandbox.requests).toHaveLength(1)
    expect(pageFetch).not.toHaveBeenCalled()
    for (const url of [MEDIA, GRAPHQL, STATION]) {
      expect(await refusedAsUnsupported(transport.fetch(url))).toBe(true)
    }
    connect.dispose()
  })

  it('Full: everything through the page, and back to Lite when FXM Connect goes away', async () => {
    const { view, connect, transport, sandbox, pageFetch } = await page(true)
    const extension = installFakeConnect(view)
    expect((await connect.detect()).state).toBe('present')
    for (const url of [SEARCH, MEDIA, GRAPHQL, STATION]) {
      await transport.fetch(url, url === SEARCH ? innerTubeInit() : {})
    }
    expect(pageFetch).toHaveBeenCalledTimes(4)
    expect(sandbox.requests).toEqual([])
    extension.uninstall()
    await vi.waitFor(() => expect(connect.status?.state).toBe('missing'), PATIENCE)
    await transport.fetch(SEARCH, innerTubeInit())
    expect(sandbox.requests).toHaveLength(1)
    expect(await refusedAsUnsupported(transport.fetch(MEDIA))).toBe(true)
    connect.dispose()
  })
})
