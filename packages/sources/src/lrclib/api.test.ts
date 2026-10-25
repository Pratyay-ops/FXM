import { isFxmError } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LRCLIB_CLIENT,
  LRCLIB_ORIGIN,
  LrclibApi,
  type LrclibApiOptions,
  MAX_NAME_LENGTH,
  retryAfterMs,
  toRecord,
} from './api'
import {
  brokenBody,
  busy,
  type Call,
  contextFor,
  fakeLrclib,
  fixtures,
  hangingFetch,
  json,
  slowBody,
  stalledBody,
} from './fixtures/testing'

const OPTIONS: LrclibApiOptions = {
  baseUrl: LRCLIB_ORIGIN,
  client: DEFAULT_LRCLIB_CLIENT,
  timeoutMs: 1_000,
  minIntervalMs: 0,
  maxWaitMs: 5_000,
}

const SIGNATURE = {
  trackName: 'Creep',
  artistName: 'Radiohead',
  albumName: 'Pablo Honey',
  duration: 238.64,
}

/** An API client in front of a fake LRCLIB, and the requests it made. */
function setup(
  route: (url: URL) => Response | Promise<Response>,
  options: Partial<LrclibApiOptions> = {},
) {
  const { fetch, calls } = fakeLrclib(route)
  return { api: new LrclibApi({ ...OPTIONS, ...options }), ctx: contextFor(fetch), calls }
}

/** The query parameters of a request. */
function params(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(call?.url.searchParams ?? [])
}

/** The `retryAfterMs` of a `RateLimited` error, or a failed test. */
function waitOf(error: unknown): number {
  if (!isFxmError(error, 'RateLimited') || error.retryAfterMs === undefined) {
    throw new Error(`expected a RateLimited error, got ${String(error)}`)
  }
  return error.retryAfterMs
}

/** The error a call rejects with. */
function failure(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => new Error('expected the call to fail'),
    (error: unknown) => error,
  )
}

describe('LrclibApi.get', () => {
  it('sends the signature, identifies FXM and returns the record', async () => {
    const { api, ctx, calls } = setup(() => json(fixtures.getCreep))
    const record = await api.get(SIGNATURE, ctx)
    expect(record).toEqual({
      id: 496,
      trackName: 'Creep',
      artistName: 'Radiohead',
      albumName: 'Pablo Honey',
      duration: 239,
      instrumental: false,
      plainLyrics: fixtures.getCreep.plainLyrics,
      syncedLyrics: fixtures.getCreep.syncedLyrics,
    })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url.href.split('?')[0]).toBe('https://lrclib.net/api/get')
    expect(params(call)).toEqual({
      track_name: 'Creep',
      artist_name: 'Radiohead',
      album_name: 'Pablo Honey',
      duration: '239',
    })
    expect(call?.headers.get('lrclib-client')).toBe(DEFAULT_LRCLIB_CLIENT)
    expect(DEFAULT_LRCLIB_CLIENT).toMatch(/^FXM v\d+\.\d+\.\d+ \(https:\/\/github\.com\/.+\)$/)
    // Browsers cannot set User-Agent, and LRCLIB's preflight does not allow it.
    expect(call?.headers.has('user-agent')).toBe(false)
    expect(call?.init?.credentials).toBe('omit')
  })

  it('leaves out an unknown album and a duration LRCLIB would reject', async () => {
    const { api, ctx, calls } = setup(() => json(fixtures.getCreep))
    await api.get({ trackName: 'Intro', artistName: 'Someone', duration: 0.4 }, ctx)
    await api.get({ trackName: 'A mix', artistName: 'Someone', duration: 3_600.6 }, ctx)
    await api.get({ trackName: 'Long', artistName: 'Someone', duration: 3_600.4 }, ctx)
    expect(calls.map(params)).toEqual([
      { track_name: 'Intro', artist_name: 'Someone' },
      { track_name: 'A mix', artist_name: 'Someone' },
      { track_name: 'Long', artist_name: 'Someone', duration: '3600' },
    ])
  })

  it('treats 404 and the 503 LRCLIB sends for a miss as no record', async () => {
    const { api, ctx } = setup((url) =>
      url.searchParams.get('track_name') === 'Gone'
        ? json(fixtures.notFound, { status: 404 })
        : busy(),
    )
    expect(await api.get({ trackName: 'Gone', artistName: 'Someone' }, ctx)).toBeNull()
    vi.useFakeTimers()
    try {
      expect(await api.get({ trackName: 'Busy', artistName: 'Someone' }, ctx)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a record it cannot read', async () => {
    const { api, ctx } = setup(() => json({ id: 'x', trackName: 'Creep' }))
    await expect(api.get(SIGNATURE, ctx)).rejects.toMatchObject({ code: 'Parse' })
  })

  it('rejects a body that is not JSON', async () => {
    const { api, ctx } = setup(() => new Response('<html>', { status: 200 }))
    const error = await api.get(SIGNATURE, ctx).catch((caught: unknown) => caught)
    expect(isFxmError(error, 'Parse')).toBe(true)
    expect((error as Error).cause).toBeInstanceOf(SyntaxError)
  })
})

describe('LrclibApi.search', () => {
  it('sends the query and returns the records it can read', async () => {
    const records = [...fixtures.searchRadioheadCreep.slice(0, 2), { id: 0 }, 'junk', null]
    const { api, ctx, calls } = setup(() => json(records))
    const found = await api.search('Radiohead Creep', ctx)
    expect(found.map((record) => record.id)).toEqual([30020794, 27196790])
    expect(calls[0]?.url.pathname).toBe('/api/search')
    expect(params(calls[0])).toEqual({ q: 'Radiohead Creep' })
    expect(calls[0]?.url.search).toBe('?q=Radiohead+Creep')
  })

  it('rejects results that are not a list', async () => {
    const { api, ctx } = setup(() => json({ results: [] }))
    await expect(api.search('x', ctx)).rejects.toMatchObject({ code: 'Parse' })
  })

  it('returns nothing on a 404, and asks to wait on a 503', async () => {
    const { api, ctx } = setup(() => json(fixtures.notFound, { status: 404 }))
    expect(await api.search('x', ctx)).toEqual([])
    const overloaded = setup(busy)
    vi.useFakeTimers()
    try {
      const waitMs = waitOf(await failure(overloaded.api.search('x', overloaded.ctx)))
      // Retry-After: 1, plus up to 30 % jitter.
      expect(waitMs).toBeGreaterThanOrEqual(1_000)
      expect(waitMs).toBeLessThanOrEqual(1_300)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('LrclibApi.getById', () => {
  it('loads one record by its ID', async () => {
    const { api, ctx, calls } = setup((url) =>
      url.pathname === '/api/get/496'
        ? json(fixtures.getCreep)
        : json(fixtures.notFound, { status: 404 }),
    )
    expect((await api.getById(496, ctx))?.trackName).toBe('Creep')
    expect(await api.getById(7, ctx)).toBeNull()
    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/get/496', '/api/get/7'])
    expect(calls[0]?.url.search).toBe('')
  })

  it('asks to wait when LRCLIB is busy, and rejects a record it cannot read', async () => {
    vi.useFakeTimers()
    try {
      const overloaded = setup(busy)
      await expect(overloaded.api.getById(496, overloaded.ctx)).rejects.toMatchObject({
        code: 'RateLimited',
      })
    } finally {
      vi.useRealTimers()
    }
    const { api, ctx } = setup(() => json([]))
    await expect(api.getById(496, ctx)).rejects.toMatchObject({ code: 'Parse' })
  })
})

describe('LrclibApi errors', () => {
  it.each([
    [500, 'UnknownError'],
    [400, 'Failed to deserialize query string: missing field `track_name`'],
    [401, 'InvalidAppIdError'],
  ])('maps HTTP %d to Unavailable', async (status, body) => {
    const { api, ctx } = setup(() => new Response(body, { status }))
    const error = await api.get(SIGNATURE, ctx).catch((caught: unknown) => caught)
    expect(isFxmError(error, 'Unavailable')).toBe(true)
    expect((error as Error).message).toContain(String(status))
  })

  it('maps a failed request to Network', async () => {
    const cause = new TypeError('fetch failed')
    const { api } = setup(() => new Response())
    const ctx = contextFor(async () => {
      throw cause
    })
    const error = await api.search('x', ctx).catch((caught: unknown) => caught)
    expect(isFxmError(error, 'Network')).toBe(true)
    expect((error as Error).cause).toBe(cause)
  })

  it('maps a request that takes too long to Network', async () => {
    const api = new LrclibApi({ ...OPTIONS, timeoutMs: 20 })
    const error = await api.search('x', contextFor(hangingFetch)).catch((caught: unknown) => caught)
    expect(isFxmError(error, 'Network')).toBe(true)
    expect((error as Error).message).toContain('20 ms')
  })

  it('maps a body that stalls past timeoutMs to Network, not Parse', async () => {
    const api = new LrclibApi({ ...OPTIONS, timeoutMs: 20 })
    const { fetch } = fakeLrclib((_url, init) => stalledBody(init?.signal))
    const error = await failure(api.search('x', contextFor(fetch)))
    expect(isFxmError(error, 'Network')).toBe(true)
    expect((error as Error).message).toBe('LRCLIB did not answer within 20 ms')
    expect((error as Error).cause).toMatchObject({ name: 'TimeoutError' })
  })

  it('maps a body that breaks off to Network, not Parse', async () => {
    const cause = new TypeError('terminated')
    const { api, ctx } = setup(() => brokenBody(cause))
    const error = await failure(api.search('x', ctx))
    expect(isFxmError(error, 'Network')).toBe(true)
    expect((error as Error).message).toBe('The answer from LRCLIB broke off')
    expect((error as Error).cause).toBe(cause)
  })

  it('rejects with the reason of a cancelled call, before or during the request', async () => {
    const { api, calls, ctx } = setup(() => json([]))
    const controller = new AbortController()
    controller.abort()
    await expect(api.search('x', contextFor(ctx.fetch, controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls).toHaveLength(0)

    const during = new AbortController()
    const request = api.search('x', contextFor(hangingFetch, during.signal))
    await Promise.resolve()
    during.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })

    const reading = new AbortController()
    const slowBody = setup(() => {
      reading.abort()
      return new Response('[', { status: 200 })
    })
    await expect(
      slowBody.api.search('x', contextFor(slowBody.ctx.fetch, reading.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('LrclibApi request pacing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends one request at a time, minIntervalMs after the one before it has finished', async () => {
    // Every body arrives a second after its headers: a request lasts until its body is read.
    const { api, ctx, calls } = setup(() => slowBody([], 1_000), { minIntervalMs: 250 })
    const all = Promise.all([api.search('a', ctx), api.search('b', ctx), api.search('c', ctx)])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await all).toEqual([[], [], []])
    const first = calls[0]?.at ?? 0
    expect(calls.map((call) => call.at - first)).toEqual([0, 1_250, 2_500])
    expect(calls.map((call) => params(call).q)).toEqual(['a', 'b', 'c'])
  })

  it('takes a cancelled call out of the queue', async () => {
    const { api, ctx, calls } = setup(() => slowBody([], 1_000))
    const first = api.search('a', ctx)
    const controller = new AbortController()
    const cancelled = failure(api.search('b', contextFor(ctx.fetch, controller.signal)))
    const third = api.search('c', ctx)
    controller.abort()
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect([await first, await third]).toEqual([[], []])
    expect(calls.map((call) => params(call).q)).toEqual(['a', 'c'])
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBe(1_000)
  })

  it('queues any number of calls instead of failing them', async () => {
    const { api, ctx, calls } = setup(() => json([]), { minIntervalMs: 250, maxWaitMs: 5_000 })
    const all = Promise.allSettled(Array.from({ length: 30 }, (_, i) => api.search(`${i}`, ctx)))
    await vi.advanceTimersByTimeAsync(30 * 250)
    const settled = await all
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([])
    expect(calls).toHaveLength(30)
  })

  it('waits out the Retry-After of a 503 before the next request', async () => {
    const { api, ctx, calls } = setup((url) => (url.pathname === '/api/get' ? busy() : json([])))
    expect(await api.get(SIGNATURE, ctx)).toBeNull()
    const search = api.search('x', ctx)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400)
    await search
    const gap = (calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)
    // At least the Retry-After, plus at most 30 % jitter.
    expect(gap).toBeGreaterThanOrEqual(1_000)
    expect(gap).toBeLessThanOrEqual(1_300)
  })

  it('fails fast while LRCLIB rate-limits, and lets a call through once the wait is over', async () => {
    let limited = true
    const { api, ctx, calls } = setup(() =>
      limited
        ? json(fixtures.rateLimited, { status: 429, headers: { 'retry-after': '30' } })
        : json([]),
    )
    const waitMs = waitOf(await failure(api.search('x', ctx)))
    // Retry-After: 30, plus up to 30 % jitter, which the error includes.
    expect(waitMs).toBeGreaterThanOrEqual(30_000)
    expect(waitMs).toBeLessThanOrEqual(39_000)
    expect(waitOf(await failure(api.search('y', ctx)))).toBe(waitMs)
    expect(calls).toHaveLength(1)
    limited = false
    await vi.advanceTimersByTimeAsync(waitMs - 1)
    expect(waitOf(await failure(api.search('z', ctx)))).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    // A call made exactly retryAfterMs after the 429 reaches LRCLIB.
    expect(await api.search('z', ctx)).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('fails instead of waiting when LRCLIB asks for longer than maxWaitMs', async () => {
    const { api, ctx, calls } = setup(
      () => json(fixtures.overloaded, { status: 503, headers: { 'retry-after': '120' } }),
      { maxWaitMs: 5_000 },
    )
    expect(await api.get(SIGNATURE, ctx)).toBeNull()
    expect(waitOf(await failure(api.search('x', ctx)))).toBeGreaterThanOrEqual(120_000)
    expect(calls).toHaveLength(1)
  })

  it('fails a queued call when the request before it gets a 429', async () => {
    const { api, ctx, calls } = setup(() =>
      json(fixtures.rateLimited, { status: 429, headers: { 'retry-after': '30' } }),
    )
    const [first, second] = await Promise.all([
      failure(api.search('a', ctx)),
      failure(api.search('b', ctx)),
    ])
    expect(waitOf(second)).toBe(waitOf(first))
    expect(calls).toHaveLength(1)
  })

  it('stops waiting when the call is cancelled', async () => {
    const { api, ctx, calls } = setup(() => json([]), { minIntervalMs: 10_000, maxWaitMs: 20_000 })
    await api.search('a', ctx)
    const controller = new AbortController()
    const waiting = api.search('b', contextFor(ctx.fetch, controller.signal))
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(1)
  })
})

describe('LrclibApi base URL', () => {
  it('reaches a self-hosted LRCLIB under a path', async () => {
    for (const baseUrl of [
      'https://lyrics.example.test/lrclib',
      'https://lyrics.example.test/lrclib/',
    ]) {
      const { api, ctx, calls } = setup(() => json([]), { baseUrl })
      await api.search('x', ctx)
      expect(calls[0]?.url.href).toBe('https://lyrics.example.test/lrclib/api/search?q=x')
    }
  })
})

describe('retryAfterMs', () => {
  const now = Date.UTC(2026, 9, 25, 12, 0, 0)

  it.each([
    ['1', 1_000],
    ['2.5', 2_500],
    [' 30 ', 30_000],
    ['Sun, 25 Oct 2026 12:00:10 GMT', 10_000],
    ['Sun, 25 Oct 2026 11:59:00 GMT', 0],
    ['999999', 3_600_000],
  ])('reads %j as %d ms', (header, ms) => {
    expect(retryAfterMs(header, 5, now)).toBe(ms)
  })

  it.each([[null], [''], ['soon'], ['-1']])('falls back for %j', (header) => {
    expect(retryAfterMs(header, 5, now)).toBe(5)
  })
})

describe('toRecord', () => {
  it('keeps what FXM uses and tells missing lyrics from none', () => {
    expect(
      toRecord({
        id: 1,
        name: 'Old name',
        artistName: 'Someone',
        albumName: ' ',
        duration: null,
        instrumental: 'yes',
        plainLyrics: null,
      }),
    ).toEqual({
      id: 1,
      trackName: 'Old name',
      artistName: 'Someone',
      instrumental: false,
      plainLyrics: null,
    })
    expect(toRecord({ id: 2, trackName: 'T', duration: -3, syncedLyrics: 5 })).toEqual({
      id: 2,
      trackName: 'T',
      artistName: '',
      instrumental: false,
      syncedLyrics: null,
    })
  })

  it('folds whitespace in names and caps their length, never inside a character', () => {
    const emoji = String.fromCodePoint(0x1f600)
    const record = toRecord({
      id: 3,
      trackName: ' Creep \n (Live)\t',
      artistName: `a${emoji.repeat(300)}`,
      albumName: `${'x'.repeat(MAX_NAME_LENGTH - 1)} y`,
    })
    expect(record?.trackName).toBe('Creep (Live)')
    // "a" and 249 emoji fit; the cut would split the 250th in half.
    expect(record?.artistName).toBe(`a${emoji.repeat(249)}`)
    expect(record?.albumName).toBe('x'.repeat(MAX_NAME_LENGTH - 1))
  })

  it.each([
    [null],
    ['record'],
    [[]],
    [{ trackName: 'No ID' }],
    [{ id: 1.5, trackName: 'Fraction' }],
    [{ id: -1, trackName: 'Negative' }],
    [{ id: 1, trackName: '  ' }],
  ])('rejects %j', (value) => {
    expect(toRecord(value)).toBeNull()
  })
})
