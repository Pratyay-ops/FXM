import { isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { createRequestBudget } from './budget'
import { createCapacitorTransport, unpatchedFetch } from './capacitor'
import { isCorsSimpleRequest } from './cors'
import { isRouteUnavailable, isTransportError } from './errors'
import { SIMPLE_CONTENT_TYPE, toSimpleInnerTubeRequest } from './innertube'
import {
  createNativeStub,
  createNativeTransport,
  NATIVE_ORIGINS,
  type NativeHttp,
  type NativeRequestInit,
  toNativeRequest,
} from './native'
import { createTauriTransport } from './tauri'
import type { OutgoingRequest } from './transport'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const BODY = JSON.stringify({ context: { client: { clientName: 'VISIONOS' } }, query: 'x' })
const AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'

function outgoing(url: string, init: Partial<OutgoingRequest['init']> = {}): OutgoingRequest {
  return { url, init: { method: 'GET', headers: {}, credentials: 'omit', ...init } }
}

function nativeHttp(respond?: (url: string, init: NativeRequestInit) => Response) {
  const calls: { url: string; init: NativeRequestInit }[] = []
  const http: NativeHttp = async (url, init) => {
    calls.push({ url, init })
    return respond?.(url, init) ?? Response.json({})
  }
  return { http, calls }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('the native header policy', () => {
  it('never sends a webview origin: no Origin for YouTube, Spotify’s own for Spotify', () => {
    expect(NATIVE_ORIGINS).toEqual({
      open: null,
      innertube: null,
      'youtube-web': null,
      googlevideo: null,
      spotify: 'https://open.spotify.com',
      'lastfm-web': null,
      user: null,
    })
  })

  it('puts every header in a plain object, the InnerTube shape intact', async () => {
    const simple = await toSimpleInnerTubeRequest(SEARCH, {
      method: 'POST',
      headers: { 'X-Goog-Visitor-Id': 'v', Origin: 'tauri://localhost' },
      body: BODY,
    })
    const native = await toNativeRequest(simple, 'innertube', AGENT)
    expect(native.url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(native.init.headers).toEqual({
      'content-type': SIMPLE_CONTENT_TYPE,
      'user-agent': AGENT,
    })
    expect(native.init).toMatchObject({
      method: 'POST',
      origin: null,
      route: 'innertube',
      credentials: 'omit',
      redirect: 'manual',
    })
    expect(typeof native.init.body).toBe('string')
    expect(
      isCorsSimpleRequest(
        'POST',
        Object.entries(native.init.headers).filter(([name]) => name !== 'user-agent'),
      ),
    ).toBe(true)
  })

  it('gives Spotify its origin and the browser agent, and keeps a caller’s agent', async () => {
    const spotify = await toNativeRequest(
      outgoing('https://open.spotify.com/api/token', { headers: { Authorization: 'Bearer x' } }),
      'spotify',
      AGENT,
    )
    expect(spotify.init.headers).toEqual({ authorization: 'Bearer x', 'user-agent': AGENT })
    expect(spotify.init.origin).toBe('https://open.spotify.com')
    const own = await toNativeRequest(
      outgoing('https://musicbrainz.org/ws/2/', { headers: { 'user-agent': 'FXM/0.1' } }),
      'open',
      AGENT,
    )
    expect(own.init.headers).toEqual({ 'user-agent': 'FXM/0.1' })
    expect(own.init.origin).toBeNull()
  })

  it('never carries an Origin or Cookie header, whatever it is handed', async () => {
    const native = await toNativeRequest(
      outgoing('https://lrclib.net/', { headers: { Origin: 'tauri://localhost', Cookie: 'a=b' } }),
      'open',
    )
    expect(native.init.headers).toEqual({})
  })

  it('turns any body into text or bytes, with the Content-Type fetch would add', async () => {
    const form = await toNativeRequest(
      outgoing('https://lrclib.net/api', { method: 'POST', body: new URLSearchParams({ a: 'b' }) }),
      'open',
    )
    expect(new TextDecoder().decode(form.init.body as Uint8Array)).toBe('a=b')
    expect(form.init.headers['content-type']).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    )
    const bytes = await toNativeRequest(
      outgoing('https://lrclib.net/api', {
        method: 'POST',
        body: new Uint8Array([1, 2, 3]),
        headers: { 'content-type': 'application/x-protobuf' },
      }),
      'open',
    )
    expect([...(bytes.init.body as Uint8Array)]).toEqual([1, 2, 3])
    expect(bytes.init.headers['content-type']).toBe('application/x-protobuf')
    const blob = await toNativeRequest(
      outgoing('https://lrclib.net/api', {
        method: 'POST',
        body: new Blob(['{}'], { type: 'application/json' }),
      }),
      'open',
    )
    expect(blob.init.headers['content-type']).toBe('application/json')
    const text = await toNativeRequest(
      outgoing('https://lrclib.net/api', { body: 'hello' }),
      'open',
    )
    expect(text.init.body).toBe('hello')
  })

  it('keeps the signal, and always asks for manual redirects and no cookies', async () => {
    const signal = new AbortController().signal
    const native = await toNativeRequest(
      outgoing('https://lrclib.net/api', { signal, redirect: 'error', credentials: 'include' }),
      'open',
    )
    expect(native.init.signal).toBe(signal)
    expect(native.init.redirect).toBe('manual')
    expect(native.init.credentials).toBe('omit')
    const bare = await toNativeRequest(
      { url: 'https://lrclib.net/', init: { headers: {} } },
      'user',
    )
    expect(bare.init).toEqual({
      method: 'GET',
      headers: {},
      origin: null,
      route: 'user',
      credentials: 'omit',
      redirect: 'manual',
    })
  })
})

describe('createNativeTransport', () => {
  it('sends every host through the native HTTP, InnerTube drawing from the budget', async () => {
    const { http, calls } = nativeHttp()
    const budget = createRequestBudget()
    const transport = createNativeTransport({
      http,
      budget,
      userAgent: AGENT,
      userHosts: () => ['gist.example.org'],
    })
    await transport.fetch(SEARCH, { method: 'POST', body: BODY })
    await transport.fetch('https://rr1---sn-x.googlevideo.com/videoplayback', {
      headers: { Range: 'bytes=0-65535' },
    })
    await transport.fetch('https://spclient.wg.spotify.com/metadata/4/track/x')
    await transport.fetch('https://www.last.fm/player/station/music/x')
    await transport.fetch('https://gist.example.org/raw/secret.json')
    expect(calls.map((call) => [call.init.route, call.init.origin])).toEqual([
      ['innertube', null],
      ['googlevideo', null],
      ['spotify', 'https://open.spotify.com'],
      ['lastfm-web', null],
      ['user', null],
    ])
    expect(calls[1]?.init.headers.range).toBe('bytes=0-65535')
    for (const call of calls) expect(call.init).toMatchObject({ credentials: 'omit' })
    expect(budget.snapshot().used).toBe(1)
    expect(
      isTransportError(await rejection(transport.fetch('https://example.com/')), 'unknown-host'),
    ).toBe(true)
  })

  it('follows redirects itself, sending each hop through the native HTTP', async () => {
    const { http, calls } = nativeHttp((url) =>
      url.includes('rr1---')
        ? new Response(null, {
            status: 302,
            headers: {
              location: 'https://rr5---sn-y.googlevideo.com/videoplayback?cms_redirect=yes',
            },
          })
        : new Response('bytes'),
    )
    const transport = createNativeTransport({ http, budget: createRequestBudget() })
    const response = await transport.fetch('https://rr1---sn-x.googlevideo.com/videoplayback', {
      headers: { Range: 'bytes=0-1' },
    })
    await expect(response.text()).resolves.toBe('bytes')
    expect(
      calls.map((call) => [new URL(call.url).host, call.init.route, call.init.redirect]),
    ).toEqual([
      ['rr1---sn-x.googlevideo.com', 'googlevideo', 'manual'],
      ['rr5---sn-y.googlevideo.com', 'googlevideo', 'manual'],
    ])
    expect(calls[1]?.init.headers.range).toBe('bytes=0-1')
  })
})

describe('createNativeStub', () => {
  it('reaches only CORS-friendly hosts, through the webview’s fetch', async () => {
    const webFetch = vi.fn(async () => Response.json({}))
    const transport = createNativeStub({
      needs: 'the native networking of stage 9.9',
      webFetch: webFetch as typeof fetch,
      budget: createRequestBudget(),
      userHosts: () => ['invidious.example.org'],
    })
    await transport.fetch('https://lrclib.net/api/get', {
      headers: { Origin: 'tauri://localhost', 'User-Agent': 'FXM/0.1', Accept: 'application/json' },
    })
    const [, init] = webFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ accept: 'application/json' })
    for (const url of [
      SEARCH,
      'https://www.youtube.com/sw.js_data',
      'https://rr1---sn-x.googlevideo.com/videoplayback',
      'https://open.spotify.com/api/token',
    ]) {
      const error = await rejection(transport.fetch(url, { method: 'POST', body: BODY }))
      expect(isRouteUnavailable(error)).toBe(true)
      expect(error).toMatchObject({ needs: ['native'] })
      expect((error as Error).message).toContain('stage 9.9')
    }
    expect(
      isRouteUnavailable(await rejection(transport.fetch('https://invidious.example.org/x'))),
    ).toBe(true)
    expect(transport.budget.snapshot().used).toBe(0)
  })
})

describe('createTauriTransport', () => {
  it('is the stub until stage 7.2 supplies its native HTTP', async () => {
    const webFetch = vi.fn(async () => Response.json({}))
    const transport = createTauriTransport({
      webFetch: webFetch as typeof fetch,
      budget: createRequestBudget(),
    })
    await transport.fetch('https://lrclib.net/api/get')
    expect(webFetch).toHaveBeenCalledOnce()
    const error = await rejection(transport.fetch(SEARCH, { method: 'POST', body: BODY }))
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    expect((error as Error).message).toContain('7.2')
  })

  it('uses the native HTTP once it exists', async () => {
    const { http, calls } = nativeHttp()
    const budget = createRequestBudget()
    const transport = createTauriTransport({
      http,
      budget,
      userAgent: AGENT,
      userHosts: () => ['invidious.example.org'],
    })
    await transport.fetch(SEARCH, { method: 'POST', body: BODY })
    await transport.fetch('https://invidious.example.org/api/v1/stats')
    expect(calls[0]?.init.headers).toMatchObject({ 'user-agent': AGENT })
    expect(calls[0]?.init.origin).toBeNull()
    expect(calls[1]?.init.route).toBe('user')
    expect(transport.budget).toBe(budget)
    expect(calls).toHaveLength(2)
  })

  it('defaults to the global fetch for the stub', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    try {
      await createTauriTransport({ budget: createRequestBudget() }).fetch('https://lrclib.net/')
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('createCapacitorTransport', () => {
  it('never uses Capacitor’s fetch patch, only the WebView’s own fetch', async () => {
    const own = vi.fn(async () => Response.json({ own: true }))
    const patched = vi.fn(async () => Response.json({ patched: true }))
    const global = { fetch: patched, CapacitorWebFetch: own }
    await unpatchedFetch(global)('https://lrclib.net/')
    expect(own).toHaveBeenCalledOnce()
    expect(patched).not.toHaveBeenCalled()
    await unpatchedFetch({ fetch: patched })('https://lrclib.net/')
    expect(patched).toHaveBeenCalledOnce()
  })

  it('is the stub until stage 6.2 supplies its OkHttp plugin', async () => {
    const webFetch = vi.fn(async () => Response.json({}))
    const transport = createCapacitorTransport({
      webFetch: webFetch as typeof fetch,
      budget: createRequestBudget(),
    })
    await transport.fetch('https://lrclib.net/api/get')
    expect(webFetch).toHaveBeenCalledOnce()
    const error = await rejection(transport.fetch('https://open.spotify.com/api/token'))
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    expect((error as Error).message).toContain('6.2')
  })

  it('uses the native HTTP once it exists', async () => {
    const { http, calls } = nativeHttp()
    const transport = createCapacitorTransport({
      http,
      budget: createRequestBudget(),
      userAgent: AGENT,
      userHosts: () => [],
    })
    await transport.fetch('https://open.spotify.com/api/token')
    expect(calls[0]?.init.headers).toEqual({ 'user-agent': AGENT })
    expect(calls[0]?.init.origin).toBe('https://open.spotify.com')
  })

  it('defaults to the unpatched global fetch for the stub', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    try {
      await createCapacitorTransport({ budget: createRequestBudget() }).fetch('https://lrclib.net/')
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})
