import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { fakeFetch, testContext, textResponse } from './fake-network'
import { getText, maxAgeMs, parseJson, rateLimited, retryAfterMs } from './http'

const OPTIONS = { service: 'Test service', timeoutMs: 1_000, maxBytes: 1_000 }

/** A fetch whose answer never comes, and rejects like a real one when its signal aborts. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

/** The error a promise rejects with. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('expected a rejection'),
    (error: unknown) => error,
  )
}

describe('getText', () => {
  it('sends a plain GET without cookies and reads the body', async () => {
    const { fetch, calls } = fakeFetch(() =>
      textResponse('{"ok":true}', { contentType: 'Application/JSON; charset=utf-8' }),
    )
    const response = await getText(testContext({ fetch }), 'https://example.test/a?b=1', OPTIONS)
    expect(response).toMatchObject({ status: 200, contentType: 'application/json' })
    expect(response.text).toBe('{"ok":true}')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.href).toBe('https://example.test/a?b=1')
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.credentials).toBe('omit')
    // No headers, so a browser never sends a CORS preflight.
    expect(calls[0]?.init?.headers).toBeUndefined()
  })

  it('resolves error statuses for the caller to read', async () => {
    const { fetch } = fakeFetch(() =>
      textResponse('nope', { status: 503, contentType: 'text/plain' }),
    )
    const response = await getText(testContext({ fetch }), 'https://example.test/', OPTIONS)
    expect(response.status).toBe(503)
    expect(response.text).toBe('nope')
    expect(response.headers.get('content-type')).toBe('text/plain')
  })

  it('reads an empty body as an empty string', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }))
    const response = await getText(testContext({ fetch }), 'https://example.test/', OPTIONS)
    expect(response).toMatchObject({ status: 204, text: '', contentType: '' })
  })

  it('refuses a body larger than the cap', async () => {
    const { fetch } = fakeFetch(() => textResponse('x'.repeat(1_001)))
    const error = await failure(getText(testContext({ fetch }), 'https://example.test/', OPTIONS))
    expect(isFxmError(error, 'Parse')).toBe(true)
    expect((error as Error).message).toBe('Test service answered with more than 1000 bytes')
  })

  it('reports a failed request as a Network error', async () => {
    const cause = new TypeError('fetch failed')
    const error = await failure(
      getText(
        testContext({ fetch: () => Promise.reject(cause) }),
        'https://example.test/',
        OPTIONS,
      ),
    )
    expect(isFxmError(error, 'Network')).toBe(true)
    expect((error as Error).message).toBe('Test service could not be reached')
    expect((error as Error).cause).toBe(cause)
  })

  it('reports a timeout as a Network error that says so', async () => {
    const error = await failure(
      getText(testContext({ fetch: hangingFetch }), 'https://example.test/', {
        ...OPTIONS,
        timeoutMs: 10,
      }),
    )
    expect(isFxmError(error, 'Network')).toBe(true)
    expect((error as Error).message).toBe('Test service did not answer within 10 ms')
  })

  it('reports a body that breaks off as a Network error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'))
        controller.error(new TypeError('terminated'))
      },
    })
    const { fetch } = fakeFetch(() => new Response(body))
    const error = await failure(getText(testContext({ fetch }), 'https://example.test/', OPTIONS))
    expect(isFxmError(error, 'Network')).toBe(true)
  })

  it('rejects with the reason when the caller cancels', async () => {
    const controller = new AbortController()
    const pending = getText(
      testContext({ fetch: hangingFetch, signal: controller.signal }),
      'https://example.test/',
      OPTIONS,
    )
    const reason = new Error('stop')
    controller.abort(reason)
    expect(await failure(pending)).toBe(reason)
  })
})

describe('parseJson', () => {
  const response = (text: string) => ({
    status: 200,
    headers: new Headers(),
    contentType: 'application/json',
    text,
  })

  it('parses JSON', () => {
    expect(parseJson(response('[1,2]'), 'Test')).toEqual([1, 2])
  })

  it('rejects anything else as a Parse error with the cause', () => {
    let error: unknown
    try {
      parseJson(response('<html>'), 'Test')
    } catch (caught) {
      error = caught
    }
    expect(isFxmError(error, 'Parse')).toBe(true)
    expect((error as Error).message).toBe('Test answered with invalid JSON')
    expect((error as Error).cause).toBeInstanceOf(SyntaxError)
  })
})

describe('maxAgeMs', () => {
  it.each([
    [null, undefined],
    ['', undefined],
    ['public', undefined],
    ['max-age=86400', 86_400_000],
    ['public, max-age=60, must-revalidate', 60_000],
    ['max-age="30"', 30_000],
    ['s-maxage=10, max-age=5', 5_000],
    ['no-store', 0],
    ['private, no-cache', 0],
    ['max-age=abc', undefined],
  ])('reads %j as %j', (header, expected) => {
    expect(maxAgeMs(header)).toBe(expected)
  })
})

describe('retryAfterMs', () => {
  it('reads seconds and dates, and falls back otherwise', () => {
    const now = Date.parse('2026-10-26T00:00:00Z')
    expect(retryAfterMs('2', 99, now)).toBe(2_000)
    expect(retryAfterMs('Mon, 26 Oct 2026 00:00:30 GMT', 99, now)).toBe(30_000)
    expect(retryAfterMs(null, 99, now)).toBe(99)
    expect(retryAfterMs('soon', 99, now)).toBe(99)
  })
})

describe('rateLimited', () => {
  it('is a RateLimited error with a whole number of milliseconds', () => {
    const error = rateLimited('Test', 1_234.6)
    expect(error).toBeInstanceOf(FxmError)
    expect(error.code).toBe('RateLimited')
    expect(error.retryAfterMs).toBe(1_235)
    expect(rateLimited('Test', -5).retryAfterMs).toBe(0)
  })
})
