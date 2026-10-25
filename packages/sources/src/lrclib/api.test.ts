import { isFxmError } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LRCLIB_CLIENT,
  LRCLIB_ORIGIN,
  LrclibApi,
  type LrclibApiOptions,
  retryAfterMs,
  toRecord,
} from './api'
import {
  busy,
  type Call,
  contextFor,
  fakeLrclib,
  fixtures,
  hangingFetch,
  json,
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
      await expect(overloaded.api.search('x', overloaded.ctx)).rejects.toMatchObject({
        code: 'RateLimited',
        retryAfterMs: 1_000,
      })
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

  it('starts requests at least minIntervalMs apart', async () => {
    const { api, ctx, calls } = setup(() => json([]), { minIntervalMs: 250 })
    const both = Promise.all([api.search('a', ctx), api.search('b', ctx)])
    await vi.advanceTimersByTimeAsync(1_000)
    await both
    expect(calls).toHaveLength(2)
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(250)
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

  it('fails fast while LRCLIB rate-limits, then tries again', async () => {
    let limited = true
    const { api, ctx, calls } = setup(() =>
      limited
        ? json(fixtures.rateLimited, { status: 429, headers: { 'retry-after': '30' } })
        : json([]),
    )
    await expect(api.search('x', ctx)).rejects.toMatchObject({
      code: 'RateLimited',
      retryAfterMs: 30_000,
    })
    const error = await api.search('y', ctx).catch((caught: unknown) => caught)
    expect(isFxmError(error, 'RateLimited')).toBe(true)
    const waitMs = (error as { retryAfterMs: number }).retryAfterMs
    expect(waitMs).toBeGreaterThan(29_000)
    expect(waitMs).toBeLessThanOrEqual(39_000)
    expect(calls).toHaveLength(1)
    limited = false
    await vi.advanceTimersByTimeAsync(39_001)
    expect(await api.search('z', ctx)).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('fails instead of waiting longer than maxWaitMs', async () => {
    const { api, ctx, calls } = setup(
      () => json(fixtures.overloaded, { status: 503, headers: { 'retry-after': '120' } }),
      { maxWaitMs: 5_000 },
    )
    expect(await api.get(SIGNATURE, ctx)).toBeNull()
    await expect(api.search('x', ctx)).rejects.toMatchObject({ code: 'RateLimited' })
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
