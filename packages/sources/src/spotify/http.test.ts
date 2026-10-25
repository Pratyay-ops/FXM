import { describe, expect, it, vi } from 'vitest'
import { isSpotifyError } from './errors'
import { contextFor, fakeClock, hangingFetch, json } from './fixtures/testing'
import { parseRetryAfter, SpotifyHttp, type SpotifyHttpOptions, sleep } from './http'

const UA = 'Mozilla/5.0 (fixture) Chrome/150.0.0.0 Safari/537.36'
const REQUEST = {
  url: 'https://api-partner.spotify.com/pathfinder/v2/query',
  what: 'The test call',
}

/** A fetch answering with each response in turn, recording the requests. */
function sequence(...answers: Array<() => Response | Promise<Response>>) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)]
    if (!answer) throw new Error('no answer')
    return answer()
  }
  return { fetch: fetchImpl, requests }
}

function transport(options: Partial<SpotifyHttpOptions> = {}) {
  const clock = fakeClock()
  const waits: number[] = []
  const onPause = vi.fn()
  const http = new SpotifyHttp({
    userAgent: () => UA,
    now: clock.now,
    random: () => 0.5,
    sleep: async (ms) => {
      waits.push(ms)
      clock.advance(ms)
    },
    onPause,
    ...options,
  })
  return { http, clock, waits, onPause }
}

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, and ignores junk', () => {
    const now = Date.UTC(2026, 9, 25, 12)
    expect(parseRetryAfter('3', now)).toBe(3000)
    expect(parseRetryAfter(' 0 ', now)).toBe(0)
    expect(parseRetryAfter(new Date(now + 7000).toUTCString(), now)).toBe(7000)
    expect(parseRetryAfter(new Date(now - 7000).toUTCString(), now)).toBe(0)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })
})

describe('sleep', () => {
  it('waits, and rejects with the reason when aborted', async () => {
    await expect(sleep(1)).resolves.toBeUndefined()
    const controller = new AbortController()
    const waiting = sleep(10_000, controller.signal)
    controller.abort(new DOMException('stop', 'AbortError'))
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await expect(sleep(1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('SpotifyHttp', () => {
  it('returns non-retried answers as they are, without credentials', async () => {
    const { http } = transport()
    const { fetch, requests } = sequence(() => json({ ok: true }, { status: 404 }))
    const response = await http.request(REQUEST, contextFor(fetch))
    expect(response.status).toBe(404)
    expect(requests[0]?.init?.credentials).toBe('omit')
    expect(requests[0]?.init?.method).toBe('GET')
  })

  it('sends the User-Agent only from native transports, unless told otherwise', async () => {
    const headersOf = (init: RequestInit | undefined) => new Headers(init?.headers)
    const { http } = transport()
    const web = sequence(() => json({}))
    await http.request(REQUEST, contextFor(web.fetch))
    expect(headersOf(web.requests[0]?.init).get('user-agent')).toBeNull()
    for (const platform of ['desktop', 'android'] as const) {
      const native = sequence(() => json({}))
      await http.request(REQUEST, contextFor(native.fetch, { platform }))
      expect(headersOf(native.requests[0]?.init).get('user-agent')).toBe(UA)
    }
    const always = transport({ sendUserAgent: () => true }).http
    const forced = sequence(() => json({}))
    await always.request(REQUEST, contextFor(forced.fetch))
    expect(headersOf(forced.requests[0]?.init).get('user-agent')).toBe(UA)
  })

  it('honours Retry-After on a 429 and then succeeds', async () => {
    const { http, waits } = transport()
    const { fetch, requests } = sequence(
      () => json({}, { status: 429, headers: { 'retry-after': '2' } }),
      () => json({ ok: true }),
    )
    const response = await http.request(REQUEST, contextFor(fetch))
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(2)
    expect(waits).toEqual([2000 + 0.5 * 500])
  })

  it('backs off exponentially with jitter on 5xx answers', async () => {
    const { http, waits } = transport()
    const { fetch, requests } = sequence(
      () => json({}, { status: 503 }),
      () => json({}, { status: 500 }),
      () => json({}, { status: 502 }),
      () => json({ ok: true }),
    )
    await http.request(REQUEST, contextFor(fetch))
    expect(requests).toHaveLength(4)
    // Half the delay plus a random share of the other half: 500, 1000, 2000 ms delays.
    expect(waits).toEqual([375, 750, 1500])
  })

  it('pauses for 5 minutes after 3 retries, then fails fast until the pause ends', async () => {
    const { http, clock, onPause } = transport()
    const { fetch, requests } = sequence(() => json({}, { status: 429 }))
    const ctx = contextFor(fetch)
    const error = await http.request(REQUEST, ctx).catch((e: unknown) => e)
    expect(isSpotifyError(error, 'paused')).toBe(true)
    expect(error).toMatchObject({ code: 'RateLimited', retryAfterMs: 300_000 })
    expect(requests).toHaveLength(4)
    expect(onPause).toHaveBeenCalledWith(clock.now() + 300_000)
    expect(http.pausedUntil).toBe(clock.now() + 300_000)
    clock.advance(120_000)
    await expect(http.request(REQUEST, ctx)).rejects.toMatchObject({ retryAfterMs: 180_000 })
    expect(requests).toHaveLength(4)
    clock.advance(180_000)
    expect(http.pausedUntil).toBeUndefined()
    await http.request(REQUEST, contextFor(sequence(() => json({})).fetch))
  })

  it('pauses at once when Retry-After asks for longer than a call may wait', async () => {
    const { http, clock, waits } = transport()
    const { fetch, requests } = sequence(() =>
      json({}, { status: 429, headers: { 'retry-after': '900' } }),
    )
    await expect(http.request(REQUEST, contextFor(fetch))).rejects.toMatchObject({
      retryAfterMs: 900_000,
    })
    expect(requests).toHaveLength(1)
    expect(waits).toEqual([])
    expect(http.pausedUntil).toBe(clock.now() + 900_000)
  })

  it('can be resumed early, and keeps the longer of two pauses', async () => {
    const { http, clock } = transport()
    http.pause(60_000)
    http.pause(10_000)
    expect(http.pausedUntil).toBe(clock.now() + 60_000)
    expect(() => http.assertNotPaused()).toThrow(/paused for 60 s/u)
    http.resume()
    expect(http.pausedUntil).toBeUndefined()
    expect(() => http.assertNotPaused()).not.toThrow()
  })

  it('fails without retry loops when no pause is configured', async () => {
    const { http } = transport({ pauseMs: 0, maxRetries: 1 })
    const { fetch, requests } = sequence(() => json({}, { status: 500 }))
    await expect(http.request(REQUEST, contextFor(fetch))).rejects.toMatchObject({
      reason: 'paused',
      retryAfterMs: 0,
    })
    expect(requests).toHaveLength(2)
  })

  it('reports network failures with redacted details', async () => {
    const { http } = transport()
    const failing: typeof fetch = () =>
      Promise.reject(
        new TypeError('connect failed: https://open.spotify.com/api/token?totp=123456&totpVer=7'),
      )
    const error = (await http
      .request(
        { url: 'https://open.spotify.com/api/token', what: 'The token endpoint' },
        contextFor(failing),
      )
      .catch((e: unknown) => e)) as Error
    expect(isSpotifyError(error, 'network')).toBe(true)
    expect(error.message).toContain('The token endpoint failed')
    expect(error.message).not.toContain('123456')
  })

  it('times out slow requests as network errors', async () => {
    const { http } = transport({ timeoutMs: 5 })
    const error = await http.request(REQUEST, contextFor(hangingFetch)).catch((e: unknown) => e)
    expect(isSpotifyError(error, 'network')).toBe(true)
    expect((error as Error).message).toMatch(/timed out after 5 ms/u)
  })

  it('passes a caller abort through, also while waiting to retry', async () => {
    const controller = new AbortController()
    const { http } = transport({ sleep })
    const pending = http.request(REQUEST, contextFor(hangingFetch, { signal: controller.signal }))
    controller.abort(new DOMException('stop', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const waiting = new AbortController()
    const retrying = new SpotifyHttp({ userAgent: () => UA, baseDelayMs: 5_000 }).request(
      REQUEST,
      contextFor(sequence(() => json({}, { status: 503 })).fetch, { signal: waiting.signal }),
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    waiting.abort(new DOMException('stop', 'AbortError'))
    await expect(retrying).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('returns 429 and 5xx answers as they are for calls that must not retry', async () => {
    const { http, waits } = transport()
    const { fetch, requests } = sequence(() => json({}, { status: 503 }))
    const response = await http.request({ ...REQUEST, retry: false }, contextFor(fetch))
    expect(response.status).toBe(503)
    expect(requests).toHaveLength(1)
    expect(waits).toEqual([])
    expect(http.pausedUntil).toBeUndefined()
  })

  it('sends a POST body', async () => {
    const { http } = transport()
    const { fetch, requests } = sequence(() => json({}))
    await http.request({ ...REQUEST, method: 'POST', body: '{"a":1}' }, contextFor(fetch))
    expect(requests[0]?.init).toMatchObject({ method: 'POST', body: '{"a":1}' })
  })
})
