import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { contextFor, fakeService, hangingFetch, json } from './fake-fetch'
import { asObject, getJson, releaseDate, retryAfterMs, statusError, text } from './json'

const options = { service: 'Example', timeoutMs: 1000 }

describe('getJson', () => {
  it('returns the status, headers and parsed body, sending no credentials or extra headers', async () => {
    const service = fakeService(() => json({ ok: true }, { headers: { 'x-test': '1' } }))
    const reply = await getJson(contextFor(service.fetch), 'https://example.test/a', options)
    expect(reply.status).toBe(200)
    expect(reply.headers.get('x-test')).toBe('1')
    expect(reply.body).toEqual({ ok: true })
    expect(service.calls[0]?.init?.credentials).toBe('omit')
    expect([...(service.calls[0]?.headers.keys() ?? [])]).toEqual([])
  })

  it('sends the headers it is given', async () => {
    const service = fakeService(() => json({}))
    await getJson(contextFor(service.fetch), 'https://example.test/a', {
      ...options,
      headers: { 'User-Agent': 'FXM/1.0' },
    })
    expect(service.calls[0]?.headers.get('user-agent')).toBe('FXM/1.0')
  })

  it('resolves error statuses for the caller to map, with a body only when it is JSON', async () => {
    const jsonError = fakeService(() => json({ error: 'Not Found' }, { status: 404 }))
    const htmlError = fakeService(() => new Response('<h1>busy</h1>', { status: 503 }))
    const ctx = (fetch: typeof globalThis.fetch) => contextFor(fetch)
    await expect(
      getJson(ctx(jsonError.fetch), 'https://example.test', options),
    ).resolves.toMatchObject({ status: 404, body: { error: 'Not Found' } })
    await expect(
      getJson(ctx(htmlError.fetch), 'https://example.test', options),
    ).resolves.toMatchObject({ status: 503, body: undefined })
  })

  it('rejects a success that is not JSON, or empty, with Parse', async () => {
    for (const body of ['<html></html>', '', '  ']) {
      const service = fakeService(() => new Response(body, { status: 200 }))
      const error = await getJson(contextFor(service.fetch), 'https://example.test', options).catch(
        (caught: unknown) => caught,
      )
      expect(isFxmError(error, 'Parse')).toBe(true)
    }
  })

  it('rejects with Network when the service cannot be reached or is too slow', async () => {
    const offline = fakeService(() => {
      throw new TypeError('Failed to fetch')
    })
    const unreachable = await getJson(
      contextFor(offline.fetch),
      'https://example.test',
      options,
    ).catch((caught: unknown) => caught)
    expect(isFxmError(unreachable, 'Network')).toBe(true)
    expect((unreachable as Error).message).toBe('Example could not be reached')
    expect((unreachable as Error).cause).toBeInstanceOf(TypeError)
    const slow = await getJson(contextFor(hangingFetch), 'https://example.test', {
      ...options,
      timeoutMs: 5,
    }).catch((caught: unknown) => caught)
    expect(isFxmError(slow, 'Network')).toBe(true)
    expect((slow as Error).message).toBe('Example did not answer within 5 ms')
  })

  it('rejects with the caller’s own reason when the caller cancels', async () => {
    const controller = new AbortController()
    const reason = new Error('navigated away')
    const request = getJson(
      contextFor(hangingFetch, { signal: controller.signal }),
      'https://x.test',
      options,
    )
    controller.abort(reason)
    await expect(request).rejects.toBe(reason)
    const service = fakeService(() => json({}))
    await expect(
      getJson(
        contextFor(service.fetch, { signal: AbortSignal.abort(reason) }),
        'https://x.test',
        options,
      ),
    ).rejects.toBe(reason)
    expect(service.calls).toHaveLength(0)
  })

  it('rejects with Network when the body breaks off', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('connection reset'))
      },
    })
    const service = fakeService(() => new Response(body, { status: 200 }))
    const error = await getJson(contextFor(service.fetch), 'https://x.test', options).catch(
      (caught: unknown) => caught,
    )
    expect(isFxmError(error, 'Network')).toBe(true)
  })
})

describe('retryAfterMs', () => {
  const now = Date.parse('2026-10-25T12:00:00Z')

  it.each([
    ['0', 0],
    ['7', 7000],
    ['1.5', 1500],
    ['Sun, 25 Oct 2026 12:00:30 GMT', 30_000],
    ['Sun, 25 Oct 2026 11:00:00 GMT', 0],
    ['999999', 3_600_000],
  ])('reads %j', (header, expected) => {
    expect(retryAfterMs(header, 42, now)).toBe(expected)
  })

  it.each([null, '', 'soon', '-1', '1e3'])('falls back for %j', (header) => {
    expect(retryAfterMs(header, 42, now)).toBe(42)
  })
})

describe('statusError', () => {
  const reply = (status: number, headers: Record<string, string> = {}) => ({
    status,
    headers: new Headers(headers),
  })

  it('maps statuses to error codes', () => {
    expect(statusError('S', 'a search', reply(404)).code).toBe('NotFound')
    expect(statusError('S', 'a search', reply(410)).code).toBe('NotFound')
    expect(statusError('S', 'a search', reply(403)).code).toBe('Unavailable')
    expect(statusError('S', 'a search', reply(500)).message).toBe(
      'S answered a search with HTTP 500',
    )
  })

  it('passes on how long to wait after a 429', () => {
    expect(statusError('S', 'x', reply(429, { 'retry-after': '12' }))).toMatchObject({
      code: 'RateLimited',
      retryAfterMs: 12_000,
    })
    expect(statusError('S', 'x', reply(429)).retryAfterMs).toBe(60_000)
  })
})

describe('value helpers', () => {
  it('accept only plain objects and non-blank strings', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 })
    for (const value of [null, [], 'x', 1, undefined]) expect(asObject(value)).toBeUndefined()
    expect(text('  a b ')).toBe('a b')
    for (const value of ['', '  ', 1, null]) expect(text(value)).toBeUndefined()
  })

  it.each([
    ['2008-03-02', '2008-03-02'],
    ['2008-11-06T00:00:00Z', '2008-11-06'],
    ['2008-03', '2008-03'],
    ['2008', '2008'],
    [2008, '2008'],
    ['2021-00-00', '2021'],
    ['2021-13-01', '2021'],
    ['2021-04-00', '2021-04'],
    ['2021-04-32', '2021-04'],
  ])('reads the release date %j', (value, expected) => {
    expect(releaseDate(value)).toBe(expected)
  })

  it.each(['0000-00-00', '', 'n.d.', '20081', 99, 2008.5, '08-03-2008', null])(
    'refuses the release date %j',
    (value) => {
      expect(releaseDate(value)).toBeUndefined()
    },
  )
})
