import type { ProviderContext } from '@fxm/core'
import { createRequestBudget, RouteUnavailableError, TransportError } from '@fxm/platform'
import { createFakeClock } from '@fxm/platform/testing'
import { describe, expect, it } from 'vitest'
import { createFetchBroker } from './broker'
import type { WireRequest } from './runtime/protocol'
import { testContext } from './testing'

const HOSTS = ['api.example.org', 'cdn.example.org:8443']

interface Sent {
  url: string
  init: RequestInit | undefined
}

function setup(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
  options: {
    hourlyLimit?: number
    reserves?: Record<string, number>
    responseBytes?: number
    hosts?: readonly string[]
  } = {},
) {
  const clock = createFakeClock(Date.UTC(2026, 9, 26, 9))
  const sent: Sent[] = []
  const budget = createRequestBudget({
    hourlyLimit: options.hourlyLimit ?? 100,
    reserves: { 'current-track': 0, prefetch: 0, interactive: 0, bulk: 0, ...options.reserves },
    clock,
  })
  const broker = createFetchBroker({
    plugin: { name: 'Example', hosts: options.hosts ?? HOSTS },
    budget,
    clock,
    ...(options.responseBytes === undefined
      ? {}
      : { limits: { responseBytes: options.responseBytes } }),
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, init })
    return respond(url, init)
  }) as typeof globalThis.fetch
  return { broker, sent, clock, budget, ctx: testContext(fetch) }
}

function request(url: string, extra: Partial<WireRequest> = {}): WireRequest {
  return { id: 1, url, method: 'GET', headers: [], ...extra }
}

describe('the fetch broker', () => {
  it('sends requests to declared hosts through ctx.fetch, without credentials or headers', async () => {
    const { broker, sent, ctx } = setup()
    const { response } = await broker.fetch(request('https://api.example.org/search?q=moths'), ctx)
    expect(response).toEqual({
      id: 1,
      ok: true,
      status: 200,
      statusText: '',
      url: 'https://api.example.org/search?q=moths',
      headers: [['content-type', 'application/json']],
      body: '{"ok":true}',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.init).toMatchObject({ method: 'GET', credentials: 'omit' })
    expect(sent[0]?.init).not.toHaveProperty('headers')
    const other = await broker.fetch(request('https://cdn.example.org:8443/a.json'), ctx)
    expect(other.response).toMatchObject({ ok: true, status: 200 })
  })

  it.each([
    ['another host', 'https://evil.example.org/x'],
    ['a sub-domain', 'https://sub.api.example.org/x'],
    ['plain HTTP', 'http://api.example.org/x'],
    ['credentials', 'https://user:pass@api.example.org/x'],
    ['another port', 'https://api.example.org:8443/x'],
    ['the default port of a host declared with a port', 'https://cdn.example.org/x'],
    ['an IP address', 'https://93.184.216.34/x'],
  ])('refuses %s without sending anything, as the plugin’s fault', async (_, url) => {
    const { broker, sent, ctx } = setup()
    const { response } = await broker.fetch(request(url), ctx)
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'host-not-declared', fxmCode: 'Unavailable' },
    })
    expect(sent).toEqual([])
  })

  it('refuses FXM’s own services even when a manifest got them past its checks', async () => {
    const { broker, sent, ctx } = setup(undefined, {
      hosts: ['music.youtube.com', 'open.spotify.com'],
    })
    for (const url of [
      'https://music.youtube.com/youtubei/v1/search',
      'https://open.spotify.com/',
    ]) {
      expect((await broker.fetch(request(url), ctx)).response).toMatchObject({
        ok: false,
        error: { code: 'host-not-declared' },
      })
    }
    expect(sent).toEqual([])
  })

  it('sends only GET and HEAD, without headers or a body, as every platform carries them', async () => {
    const { broker, sent, ctx } = setup()
    for (const bad of [
      request('/relative'),
      request('https://api.example.org/x', { method: 'POST', body: '{"q":1}' }),
      request('https://api.example.org/x', { method: 'PUT' }),
      request('https://api.example.org/x', { headers: [['Accept', 'application/json']] }),
      request('https://api.example.org/x', { headers: [['Range', 'bytes=0-1']] }),
      request('https://api.example.org/x', { headers: [['Cookie', 'a=b']] }),
      request('https://api.example.org/x', { body: 'x' }),
    ]) {
      expect((await broker.fetch(bad, ctx)).response).toMatchObject({
        ok: false,
        error: { code: 'bad-request', fxmCode: 'Unavailable' },
      })
    }
    expect(sent).toEqual([])
    const head = await broker.fetch(request('https://api.example.org/x', { method: 'HEAD' }), ctx)
    expect(head.response).toMatchObject({ ok: true, body: '' })
    expect(sent[0]?.init).toMatchObject({ method: 'HEAD' })
  })

  it('takes every request from the plugin’s budget, and refuses once it is used up', async () => {
    const { broker, sent, ctx, clock, budget } = setup(undefined, { hourlyLimit: 2 })
    await broker.fetch(request('https://api.example.org/1'), ctx)
    await broker.fetch(request('https://api.example.org/2'), ctx)
    const { response: refused } = await broker.fetch(request('https://api.example.org/3'), ctx)
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'rate-limited',
        fxmCode: 'RateLimited',
        message: 'Example used up its 2 requests of the hour',
      },
    })
    expect(refused.ok === false && refused.error.retryAfterMs).toBeGreaterThan(0)
    expect(sent).toHaveLength(2)
    expect(budget.snapshot().used).toBe(2)
    clock.advance(60 * 60_000 + 1)
    expect((await broker.fetch(request('https://api.example.org/4'), ctx)).response).toMatchObject({
      ok: true,
    })
  })

  it('takes the slot at the request’s priority, so playback keeps its reserve', async () => {
    const { broker, ctx } = setup(undefined, { hourlyLimit: 2, reserves: { interactive: 1 } })
    await broker.fetch(request('https://api.example.org/1'), ctx)
    expect((await broker.fetch(request('https://api.example.org/2'), ctx)).response).toMatchObject({
      ok: false,
      error: { code: 'rate-limited' },
    })
    const playing = await broker.fetch(request('https://api.example.org/3'), ctx, 'current-track')
    expect(playing.response).toMatchObject({ ok: true })
  })

  it('pauses the plugin after a 429 for its Retry-After, at least a minute', async () => {
    let status = 429
    const { broker, sent, ctx, clock } = setup(
      () => new Response('slow down', { status, headers: { 'retry-after': '120' } }),
    )
    const limited = await broker.fetch(request('https://api.example.org/a'), ctx)
    // The plugin still sees the answer, to read it if it wants.
    expect(limited.response).toMatchObject({ ok: true, status: 429, body: 'slow down' })
    expect(broker.pausedUntil()).toBe(clock.now() + 120_000)
    const paused = await broker.fetch(request('https://api.example.org/b'), ctx)
    expect(paused.response).toMatchObject({
      ok: false,
      error: { code: 'rate-limited', retryAfterMs: 120_000 },
    })
    expect(sent).toHaveLength(1)
    status = 200
    clock.advance(120_001)
    expect(broker.pausedUntil()).toBeUndefined()
    expect((await broker.fetch(request('https://api.example.org/c'), ctx)).response).toMatchObject({
      ok: true,
      status: 200,
    })
  })

  it('refuses an answer that came from an undeclared host after a redirect', async () => {
    const { broker, ctx } = setup(() => {
      const response = new Response('moved')
      Object.defineProperty(response, 'url', { value: 'https://other.example.net/x' })
      return response
    })
    expect((await broker.fetch(request('https://api.example.org/x'), ctx)).response).toMatchObject({
      ok: false,
      error: { code: 'redirect', fxmCode: 'Unavailable' },
    })
  })

  it('refuses answers over the size limit and reads HEAD answers as empty', async () => {
    const { broker, ctx } = setup(() => new Response('x'.repeat(2_000)), { responseBytes: 1_000 })
    expect(
      (await broker.fetch(request('https://api.example.org/big'), ctx)).response,
    ).toMatchObject({ ok: false, error: { code: 'too-large', fxmCode: 'Unavailable' } })
    expect(
      (await broker.fetch(request('https://api.example.org/big', { method: 'HEAD' }), ctx))
        .response,
    ).toMatchObject({ ok: true, body: '' })
  })

  it('keeps response headers other than Set-Cookie, in lower case', async () => {
    const { broker, ctx } = setup(
      () =>
        new Response('', {
          headers: [
            ['X-Total', '3'],
            ['Set-Cookie', 'session=secret'],
          ],
        }),
    )
    const { response } = await broker.fetch(request('https://api.example.org/x'), ctx)
    expect(response.ok && response.headers).toEqual([
      ['content-type', 'text/plain;charset=UTF-8'],
      ['x-total', '3'],
    ])
  })

  it('reports failures of the platform and the network as the plugin’s request failures', async () => {
    const refusing = setup(() => {
      throw new TransportError('unknown-host', 'The host is not in the table')
    })
    const refused = await refusing.broker.fetch(request('https://api.example.org/x'), refusing.ctx)
    expect(refused).toEqual({
      response: {
        id: 1,
        ok: false,
        error: { code: 'refused', fxmCode: 'Unavailable', message: 'The host is not in the table' },
      },
    })
    const offline = setup(() => {
      throw new TypeError('Failed to fetch')
    })
    expect(
      (await offline.broker.fetch(request('https://api.example.org/x'), offline.ctx)).response,
    ).toMatchObject({
      ok: false,
      error: { code: 'network', fxmCode: 'Network', message: 'The request failed' },
    })
  })

  it('tells the host about a route the platform closed, which only it can report', async () => {
    const closed = new RouteUnavailableError('user', ['sandbox'], 'Reaching it needs the sandbox')
    const { broker, ctx } = setup(() => {
      throw closed
    })
    const outcome = await broker.fetch(request('https://api.example.org/x'), ctx)
    expect(outcome.closedRoute).toBe(closed)
    expect(outcome.response).toMatchObject({
      ok: false,
      error: { code: 'refused', fxmCode: 'Unsupported' },
    })
  })

  it('rejects with the reason when the caller cancels', async () => {
    const controller = new AbortController()
    const { broker, ctx } = setup(
      (_, init) =>
        new Promise<Response>((_resolve, reject) => {
          // As fetch does: an aborted signal rejects at once, a later abort when it comes.
          if (init?.signal?.aborted) reject(init.signal.reason)
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const cancelled: ProviderContext = { ...ctx, signal: controller.signal }
    const reason = new Error('gone')
    const pending = broker.fetch(request('https://api.example.org/slow'), cancelled)
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await expect(broker.fetch(request('https://api.example.org/x'), cancelled)).rejects.toBe(reason)
  })
})
