import { isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { createRequestBudget } from './budget'
import { isTransportError } from './errors'
import { SIMPLE_CONTENT_TYPE } from './innertube'
import { createNodeTransport, type NodeTransportOptions } from './node'
import { MAX_REDIRECTS } from './transport'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'x' })
const AGENT = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36'

type Respond = (url: string, init: RequestInit) => Response

function setup(options: Partial<NodeTransportOptions> = {}, respond?: Respond) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    respond ? respond(String(input), init ?? {}) : Response.json({}),
  )
  const budget = createRequestBudget()
  const transport = createNodeTransport({
    fetch: fetch as typeof globalThis.fetch,
    budget,
    ...options,
  })
  const calls = () => fetch.mock.calls as unknown as [string, RequestInit][]
  return { fetch, transport, budget, calls }
}

/** A redirect response, as Node's fetch returns one for `redirect: 'manual'`. */
function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('createNodeTransport', () => {
  it('reaches every host class directly, without credentials and following no redirect', async () => {
    const { fetch, transport, calls } = setup()
    for (const url of [
      'https://lrclib.net/api/get',
      'https://rr1---sn-x.googlevideo.com/videoplayback',
      'https://open.spotify.com/api/server-time',
      'https://www.last.fm/player/station/music/x',
      'https://www.youtube.com/sw.js_data',
    ]) {
      await transport.fetch(url)
    }
    expect(fetch).toHaveBeenCalledTimes(5)
    for (const [, init] of calls()) {
      expect(init.credentials).toBe('omit')
      expect(init.redirect).toBe('manual')
    }
  })

  it('sends InnerTube calls in the CORS-simple shape and draws from the budget', async () => {
    const { calls, transport, budget } = setup()
    await transport.fetch(SEARCH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Visitor-Id': 'v' },
      body: BODY,
    })
    const [url, init] = calls()[0] as [string, RequestInit]
    expect(url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(init.headers).toEqual({ 'content-type': SIMPLE_CONTENT_TYPE })
    expect(init.redirect).toBe('manual')
    expect(transport.budget).toBe(budget)
    expect(budget.snapshot().used).toBe(1)
  })

  it('adds a browser User-Agent to YouTube and Spotify requests that carry none', async () => {
    const { calls, transport } = setup({ userAgent: AGENT })
    await transport.fetch(SEARCH, { method: 'POST', body: BODY })
    await transport.fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
      headers: { 'User-Agent': 'Custom/1.0' },
    })
    await transport.fetch('https://musicbrainz.org/ws/2/recording', {
      headers: { 'User-Agent': 'FXM/0.1 ( https://github.com/Pratyay-ops/FXM )' },
    })
    await transport.fetch('https://lrclib.net/api/get')
    expect(calls().map((call) => call[1].headers)).toEqual([
      { 'content-type': SIMPLE_CONTENT_TYPE, 'user-agent': AGENT },
      { 'user-agent': 'Custom/1.0' },
      { 'user-agent': 'FXM/0.1 ( https://github.com/Pratyay-ops/FXM )' },
      {},
    ])
  })

  it('refuses unknown hosts, and allows the user’s own for GET only', async () => {
    const { transport } = setup({ userHosts: () => ['secrets.example.org'] })
    expect(
      isTransportError(await rejection(transport.fetch('https://example.com/')), 'unknown-host'),
    ).toBe(true)
    await expect(transport.fetch('https://secrets.example.org/x.json')).resolves.toBeInstanceOf(
      Response,
    )
    expect(
      isTransportError(
        await rejection(transport.fetch('https://secrets.example.org/x', { method: 'POST' })),
        'bad-request',
      ),
    ).toBe(true)
  })

  it('uses Node’s fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    try {
      const transport = createNodeTransport({ budget: createRequestBudget() })
      await transport.fetch('https://lrclib.net/api/get')
      expect(spy).toHaveBeenCalledOnce()
      expect(transport.budget.snapshot().hourlyLimit).toBe(600)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('redirects on Node', () => {
  it('follows them hop by hop while they stay in the host class', async () => {
    const { calls, transport } = setup({}, (url) =>
      url.startsWith('https://coverartarchive.org/')
        ? redirect('https://archive.org/download/mbid-x/front.jpg', 307)
        : url.startsWith('https://archive.org/')
          ? redirect('//ia800300.us.archive.org/1/items/mbid-x/front.jpg')
          : new Response('jpeg bytes'),
    )
    const response = await transport.fetch('https://coverartarchive.org/release/x/front', {
      headers: { Accept: 'image/*' },
    })
    await expect(response.text()).resolves.toBe('jpeg bytes')
    expect(calls().map(([url]) => url)).toEqual([
      'https://coverartarchive.org/release/x/front',
      'https://archive.org/download/mbid-x/front.jpg',
      'https://ia800300.us.archive.org/1/items/mbid-x/front.jpg',
    ])
    for (const [, init] of calls()) {
      expect(init).toMatchObject({ redirect: 'manual', headers: { accept: 'image/*' } })
    }
  })

  it('turns a POST into a GET after a 303, and drops Authorization on another origin', async () => {
    const { calls, transport } = setup({}, (url) =>
      url === 'https://lrclib.net/api/publish'
        ? redirect('https://lrclib.net/api/get/1', 303)
        : url === 'https://lrclib.net/api/get/1'
          ? redirect('https://musicbrainz.org/ws/2/x', 302)
          : Response.json({ done: true }),
    )
    await transport.fetch('https://lrclib.net/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Token t', 'X-Id': '1' },
      body: '{"a":1}',
    })
    const [, second, third] = calls()
    expect(second?.[1]).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Token t', 'x-id': '1' },
    })
    expect(second?.[1].body).toBeUndefined()
    expect(third?.[1].headers).toEqual({ 'x-id': '1' })
  })

  it('keeps the method and body through a 307 or 308', async () => {
    const { calls, transport } = setup({}, (url) =>
      url === 'https://lrclib.net/a' ? redirect('https://lrclib.net/b', 308) : Response.json({}),
    )
    await transport.fetch('https://lrclib.net/a', {
      method: 'PUT',
      body: 'x',
      headers: { 'Content-Type': 'text/plain' },
    })
    expect(calls()[1]?.[1]).toMatchObject({
      method: 'PUT',
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    })
  })

  it.each([
    ['outside the host table', 'https://evil.example/x'],
    ['to plain HTTP', 'http://ia800300.us.archive.org/x'],
    ['to a host of another class', 'https://www.youtube.com/youtubei/v1/search'],
    ['to an unreadable location', 'https://exa mple.com/'],
  ])('refuses one that leads %s, without sending anything there', async (_case, location) => {
    const { fetch, transport } = setup({}, () => redirect(location))
    const error = await rejection(transport.fetch('https://archive.org/download/x'))
    expect(isTransportError(error, 'redirect')).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps a user host’s redirects on that host', async () => {
    const hosts = () => ['invidious.example.org', 'other.example.org']
    const same = setup({ userHosts: hosts }, (url) =>
      url.endsWith('/a') ? redirect('/b') : Response.json({}),
    )
    await same.transport.fetch('https://invidious.example.org/a')
    expect(same.calls()[1]?.[0]).toBe('https://invidious.example.org/b')
    const other = setup({ userHosts: hosts }, () => redirect('https://other.example.org/b'))
    expect(
      isTransportError(
        await rejection(other.transport.fetch('https://invidious.example.org/a')),
        'redirect',
      ),
    ).toBe(true)
  })

  it(`gives up after ${MAX_REDIRECTS} redirects`, async () => {
    let hop = 0
    const { fetch, transport } = setup({}, () => {
      hop += 1
      return redirect(`https://lrclib.net/${hop}`)
    })
    expect(
      isTransportError(await rejection(transport.fetch('https://lrclib.net/0')), 'redirect'),
    ).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1)
  })

  it('honours the caller’s redirect mode', async () => {
    const { fetch, transport } = setup({}, () => redirect('https://lrclib.net/b'))
    const manual = await transport.fetch('https://lrclib.net/a', { redirect: 'manual' })
    expect(manual.status).toBe(302)
    const error = await rejection(transport.fetch('https://lrclib.net/a', { redirect: 'error' }))
    expect(isTransportError(error, 'redirect')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns a 3xx without a Location as it is', async () => {
    const { transport } = setup({}, () => new Response(null, { status: 304 }))
    expect((await transport.fetch('https://lrclib.net/a')).status).toBe(304)
  })

  it('cannot send a streamed body to the next hop', async () => {
    const { transport } = setup({}, () => redirect('https://lrclib.net/b', 307))
    const error = await rejection(
      transport.fetch('https://lrclib.net/a', {
        method: 'POST',
        body: new ReadableStream(),
        duplex: 'half',
      } as RequestInit),
    )
    expect(isTransportError(error, 'redirect')).toBe(true)
  })

  it('counts a detour to Google’s "unusual traffic" page as a bot check, never fetching it', async () => {
    const { fetch, transport, budget } = setup({}, () =>
      redirect('https://www.google.com/sorry/index?continue=https://www.youtube.com/'),
    )
    const error = await rejection(transport.fetch(SEARCH, { method: 'POST', body: BODY }))
    expect(isFxmError(error, 'BotCheck')).toBe(true)
    expect(budget.snapshot().lastBotCheck?.cause).toBe('rate-limited')
    expect(fetch).toHaveBeenCalledOnce()
  })
})
