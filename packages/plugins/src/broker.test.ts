import type { ProviderContext } from '@fxm/core'
import { createRequestBudget, TransportError } from '@fxm/platform'
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
  options: { hourlyLimit?: number; responseBytes?: number } = {},
) {
  const clock = createFakeClock(Date.UTC(2026, 9, 26, 9))
  const sent: Sent[] = []
  const budget = createRequestBudget({
    hourlyLimit: options.hourlyLimit ?? 100,
    reserves: { 'current-track': 0, prefetch: 0, interactive: 0, bulk: 0 },
    clock,
  })
  const broker = createFetchBroker({
    plugin: { name: 'Example', hosts: HOSTS },
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
  it('sends requests to declared hosts through ctx.fetch, without credentials', async () => {
    const { broker, sent, ctx } = setup()
    const response = await broker.fetch(
      request('https://api.example.org/search?q=moths', {
        headers: [['Accept', 'application/json']],
      }),
      ctx,
    )
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
    expect(sent[0]?.init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    })
    const other = await broker.fetch(request('https://cdn.example.org:8443/a.json'), ctx)
    expect(other).toMatchObject({ ok: true, status: 200 })
  })

  it.each([
    ['another host', 'https://evil.example.org/x'],
    ['a sub-domain', 'https://sub.api.example.org/x'],
    ['plain HTTP', 'http://api.example.org/x'],
    ['credentials', 'https://user:pass@api.example.org/x'],
    ['another port', 'https://api.example.org:8443/x'],
    ['the default port of a host declared with a port', 'https://cdn.example.org/x'],
    ['an IP address', 'https://93.184.216.34/x'],
  ])('refuses %s without sending anything', async (_, url) => {
    const { broker, sent, ctx } = setup()
    const response = await broker.fetch(request(url), ctx)
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'host-not-declared', fxmCode: 'Unsupported' },
    })
    expect(sent).toEqual([])
  })

  it('refuses relative URLs, other methods, other headers and bodies outside a POST', async () => {
    const { broker, sent, ctx } = setup()
    for (const bad of [
      request('/relative'),
      request('https://api.example.org/x', { method: 'PUT' }),
      request('https://api.example.org/x', { headers: [['Authorization', 'Bearer x']] }),
      request('https://api.example.org/x', { headers: [['Cookie', 'a=b']] }),
      request('https://api.example.org/x', { body: 'x' }),
      request('https://api.example.org/x', { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) }),
    ]) {
      expect(await broker.fetch(bad, ctx)).toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
    }
    expect(sent).toEqual([])
    const posted = await broker.fetch(
      request('https://api.example.org/graphql', {
        method: 'POST',
        body: '{"q":1}',
        headers: [['content-type', 'text/plain']],
      }),
      ctx,
    )
    expect(posted).toMatchObject({ ok: true })
    expect(sent[0]?.init).toMatchObject({ method: 'POST', body: '{"q":1}' })
  })

  it('takes every request from the plugin’s budget, and refuses once it is used up', async () => {
    const { broker, sent, ctx, clock, budget } = setup(undefined, { hourlyLimit: 2 })
    await broker.fetch(request('https://api.example.org/1'), ctx)
    await broker.fetch(request('https://api.example.org/2'), ctx)
    const refused = await broker.fetch(request('https://api.example.org/3'), ctx)
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
    expect(await broker.fetch(request('https://api.example.org/4'), ctx)).toMatchObject({
      ok: true,
    })
  })

  it('pauses the plugin after a 429 for its Retry-After, at least a minute', async () => {
    let status = 429
    const { broker, sent, ctx, clock } = setup(
      () => new Response('slow down', { status, headers: { 'retry-after': '120' } }),
    )
    const limited = await broker.fetch(request('https://api.example.org/a'), ctx)
    // The plugin still sees the answer, to read it if it wants.
    expect(limited).toMatchObject({ ok: true, status: 429, body: 'slow down' })
    expect(broker.pausedUntil()).toBe(clock.now() + 120_000)
    const paused = await broker.fetch(request('https://api.example.org/b'), ctx)
    expect(paused).toMatchObject({
      ok: false,
      error: { code: 'rate-limited', retryAfterMs: 120_000 },
    })
    expect(sent).toHaveLength(1)
    status = 200
    clock.advance(120_001)
    expect(broker.pausedUntil()).toBeUndefined()
    expect(await broker.fetch(request('https://api.example.org/c'), ctx)).toMatchObject({
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
    expect(await broker.fetch(request('https://api.example.org/x'), ctx)).toMatchObject({
      ok: false,
      error: { code: 'redirect', fxmCode: 'Unsupported' },
    })
  })

  it('refuses answers over the size limit and reads HEAD answers as empty', async () => {
    const { broker, ctx } = setup(() => new Response('x'.repeat(2_000)), { responseBytes: 1_000 })
    expect(await broker.fetch(request('https://api.example.org/big'), ctx)).toMatchObject({
      ok: false,
      error: { code: 'too-large', fxmCode: 'Parse' },
    })
    expect(
      await broker.fetch(request('https://api.example.org/big', { method: 'HEAD' }), ctx),
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
    const response = await broker.fetch(request('https://api.example.org/x'), ctx)
    expect(response.ok && response.headers).toEqual([
      ['content-type', 'text/plain;charset=UTF-8'],
      ['x-total', '3'],
    ])
  })

  it('reports failures of the platform and the network as the plugin’s request failures', async () => {
    const refusing = setup(() => {
      throw new TransportError('unknown-host', 'The host is not in the table')
    })
    expect(
      await refusing.broker.fetch(request('https://api.example.org/x'), refusing.ctx),
    ).toMatchObject({ ok: false, error: { code: 'refused', fxmCode: 'Unsupported' } })
    const offline = setup(() => {
      throw new TypeError('Failed to fetch')
    })
    expect(
      await offline.broker.fetch(request('https://api.example.org/x'), offline.ctx),
    ).toMatchObject({
      ok: false,
      error: { code: 'network', fxmCode: 'Network', message: 'The request failed' },
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
