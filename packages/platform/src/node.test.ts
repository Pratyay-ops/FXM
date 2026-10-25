import { isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { createRequestBudget } from './budget'
import { SIMPLE_CONTENT_TYPE } from './innertube'
import { createNodeTransport } from './node'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'x' })
const AGENT = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36'

function setup(options: Parameters<typeof createNodeTransport>[0] = {}) {
  const fetch = vi.fn(async () => Response.json({}))
  const transport = createNodeTransport({ fetch: fetch as typeof globalThis.fetch, ...options })
  return { fetch, transport }
}

describe('createNodeTransport', () => {
  it('reaches every host class directly', async () => {
    const { fetch, transport } = setup()
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
    for (const call of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].credentials).toBe('omit')
    }
  })

  it('sends InnerTube calls in the CORS-simple shape and draws from the budget', async () => {
    const budget = createRequestBudget()
    const { fetch, transport } = setup({ budget })
    await transport.fetch(SEARCH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Visitor-Id': 'v' },
      body: BODY,
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(init.headers).toEqual({ 'content-type': SIMPLE_CONTENT_TYPE })
    expect(transport.budget).toBe(budget)
    expect(budget.snapshot().used).toBe(1)
  })

  it('adds a browser User-Agent to YouTube and Spotify requests that carry none', async () => {
    const { fetch, transport } = setup({ userAgent: AGENT })
    await transport.fetch(SEARCH, { method: 'POST', body: BODY })
    await transport.fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
      headers: { 'User-Agent': 'Custom/1.0' },
    })
    await transport.fetch('https://musicbrainz.org/ws/2/recording', {
      headers: { 'User-Agent': 'FXM/0.1 ( https://github.com/Pratyay-ops/FXM )' },
    })
    await transport.fetch('https://lrclib.net/api/get')
    const headers = (fetch.mock.calls as unknown as [string, RequestInit][]).map(
      (call) => call[1].headers,
    )
    expect(headers).toEqual([
      { 'content-type': SIMPLE_CONTENT_TYPE, 'user-agent': AGENT },
      { 'user-agent': 'Custom/1.0' },
      { 'user-agent': 'FXM/0.1 ( https://github.com/Pratyay-ops/FXM )' },
      {},
    ])
  })

  it('refuses unknown hosts, and allows the user’s own for GET only', async () => {
    const { transport } = setup({ userHosts: () => ['secrets.example.org'] })
    let error: unknown
    try {
      await transport.fetch('https://example.com/')
    } catch (caught) {
      error = caught
    }
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    await expect(transport.fetch('https://secrets.example.org/x.json')).resolves.toBeInstanceOf(
      Response,
    )
  })

  it('uses Node’s fetch and a budget of its own by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    try {
      const transport = createNodeTransport()
      await transport.fetch('https://lrclib.net/api/get')
      expect(spy).toHaveBeenCalledOnce()
      expect(transport.budget.snapshot().hourlyLimit).toBe(600)
    } finally {
      spy.mockRestore()
    }
  })
})
