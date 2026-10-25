import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSponsorBlockClient,
  NON_MUSIC_CATEGORY,
  parseBucket,
  SPONSORBLOCK_ORIGIN,
  toSegment,
} from './api'
import {
  contextFor,
  fakeSponsorBlock,
  fixtures,
  hangingFetch,
  json,
  VIDEO_ID,
} from './fixtures/testing'
import { hashPrefix } from './hash'

/** A SHA-256 whose digest starts with `prefix` (hex) for every input: one shared bucket. */
const digestStartingWith = (prefix: string) => async () => {
  const bytes = new Uint8Array(32)
  bytes.set([Number.parseInt(prefix.slice(0, 2), 16), Number.parseInt(prefix.slice(2, 4), 16)])
  return bytes.buffer
}

/** A fake SponsorBlock that answers every lookup with the fixture. */
const serving = (body: unknown = fixtures.bucket) => fakeSponsorBlock(() => json(body))

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error) => error,
  )

afterEach(() => {
  vi.useRealTimers()
})

describe('SponsorBlock client', () => {
  it('asks only for the hash prefix and the non-music category, without cookies or headers', async () => {
    const server = serving()
    const client = createSponsorBlockClient()

    await client.nonMusicSegments(VIDEO_ID, contextFor(server.fetch))

    expect(server.calls).toHaveLength(1)
    const [call] = server.calls
    const prefix = await hashPrefix(VIDEO_ID)
    expect(call?.url.origin).toBe(SPONSORBLOCK_ORIGIN)
    expect(call?.url.pathname).toBe(`/api/skipSegments/${prefix}`)
    expect([...(call?.url.searchParams ?? [])]).toEqual([['category', NON_MUSIC_CATEGORY]])
    expect(call?.url.href).not.toContain(VIDEO_ID)
    expect(call?.init?.credentials).toBe('omit')
    expect(call?.init?.headers).toBeUndefined()
    expect(call?.init?.method).toBeUndefined()
  })

  it("picks its own video's segments out of the answer, in order, in milliseconds", async () => {
    const client = createSponsorBlockClient()

    const segments = await client.nonMusicSegments(VIDEO_ID, contextFor(serving().fetch))

    expect(segments).toEqual([
      { startMs: 0, endMs: 14_500, videoDurationMs: 240_000, uuid: `${'3'.repeat(64)}7` },
      { startMs: 96_100, endMs: 103_350, videoDurationMs: 240_000, uuid: `${'4'.repeat(64)}7` },
      { startMs: 201_750, endMs: 240_000, videoDurationMs: 240_000, uuid: `${'2'.repeat(64)}7` },
    ])
  })

  it('leaves out a duration SponsorBlock does not know (0)', async () => {
    const client = createSponsorBlockClient()
    const segments = await client.nonMusicSegments('fxmVideoCCC', contextFor(serving().fetch))
    expect(segments[0]).toEqual({ startMs: 0, endMs: 3500, uuid: `${'5'.repeat(64)}7` })
    expect(segments[1]).toMatchObject({
      startMs: 180_000,
      endMs: 187_400,
      videoDurationMs: 187_400,
    })
  })

  it('finds nothing for a video the answer does not list', async () => {
    const client = createSponsorBlockClient()
    expect(await client.nonMusicSegments('fxmVideoZZZ', contextFor(serving().fetch))).toEqual([])
  })

  it('finds nothing when no video of the prefix has segments (404 with [])', async () => {
    const server = fakeSponsorBlock(() => json([], { status: 404 }))
    const client = createSponsorBlockClient()
    expect(await client.nonMusicSegments(VIDEO_ID, contextFor(server.fetch))).toEqual([])
  })

  it('asks nothing for a value that is not a videoId', async () => {
    const server = serving()
    const client = createSponsorBlockClient()
    for (const id of ['', 'spotify:track:x', 'fxmVideoAAAA', '../../admin']) {
      expect(await client.nonMusicSegments(id, contextFor(server.fetch))).toEqual([])
    }
    expect(server.calls).toHaveLength(0)
  })

  it('answers every video of a prefix from one request, also after a 404', async () => {
    for (const status of [200, 404]) {
      const server = fakeSponsorBlock(() => json(status === 200 ? fixtures.bucket : [], { status }))
      const client = createSponsorBlockClient({ sha256: digestStartingWith('6db9') })
      const ctx = contextFor(server.fetch)

      await client.nonMusicSegments('fxmVideoAAA', ctx)
      await client.nonMusicSegments('fxmVideoBBB', ctx)
      await client.nonMusicSegments('fxmVideoAAA', ctx)

      expect(server.calls).toHaveLength(1)
      expect(server.calls[0]?.url.pathname).toBe('/api/skipSegments/6db9')
    }
  })

  it('shares one request between lookups of the same prefix in flight', async () => {
    const server = serving()
    const client = createSponsorBlockClient({ sha256: digestStartingWith('abcd') })
    const ctx = contextFor(server.fetch)

    const [a, b] = await Promise.all([
      client.nonMusicSegments('fxmVideoAAA', ctx),
      client.nonMusicSegments('fxmVideoBBB', ctx),
    ])

    expect(server.calls).toHaveLength(1)
    expect(a).toHaveLength(3)
    expect(b).toEqual([
      { startMs: 0, endMs: 6250, videoDurationMs: 214_500, uuid: `${'1'.repeat(64)}7` },
    ])
  })

  it('asks again once an answer is older than cacheTtlMs', async () => {
    let now = 1_000_000
    const server = serving()
    const client = createSponsorBlockClient({ cacheTtlMs: 60_000, now: () => now })
    const ctx = contextFor(server.fetch)

    await client.nonMusicSegments(VIDEO_ID, ctx)
    now += 59_999
    await client.nonMusicSegments(VIDEO_ID, ctx)
    expect(server.calls).toHaveLength(1)

    now += 1
    await client.nonMusicSegments(VIDEO_ID, ctx)
    expect(server.calls).toHaveLength(2)
  })

  it('keeps the answers of the most recently used prefixes only', async () => {
    const server = serving()
    const client = createSponsorBlockClient({ maxCachedPrefixes: 2 })
    const ctx = contextFor(server.fetch)
    const ids = ['dQw4w9WgXcQ', 'sOnqjkJTMaA', 'fxmVideoAAA']
    const prefixes = await Promise.all(ids.map((id) => hashPrefix(id)))
    expect(new Set(prefixes).size).toBe(3)
    const [first, second, third] = ids as [string, string, string]

    await client.nonMusicSegments(first, ctx)
    await client.nonMusicSegments(second, ctx)
    await client.nonMusicSegments(first, ctx) // now the most recently used
    await client.nonMusicSegments(third, ctx) // drops `second`
    expect(server.calls).toHaveLength(3)

    await client.nonMusicSegments(first, ctx)
    await client.nonMusicSegments(third, ctx)
    expect(server.calls).toHaveLength(3)
    await client.nonMusicSegments(second, ctx)
    expect(server.calls).toHaveLength(4)
  })

  it('returns copies, so callers cannot change the cache', async () => {
    const client = createSponsorBlockClient()
    const ctx = contextFor(serving().fetch)
    const first = await client.nonMusicSegments(VIDEO_ID, ctx)
    if (first[0] !== undefined) first[0].startMs = 99
    expect((await client.nonMusicSegments(VIDEO_ID, ctx))[0]?.startMs).toBe(0)
  })

  it('takes another server, keeping its path', async () => {
    const server = serving()
    const client = createSponsorBlockClient({ baseUrl: 'https://mirror.example/sb' })
    await client.nonMusicSegments(VIDEO_ID, contextFor(server.fetch))
    expect(server.calls[0]?.url.href).toMatch(
      /^https:\/\/mirror\.example\/sb\/api\/skipSegments\/[0-9a-f]{4}\?category=music_offtopic$/,
    )
  })

  describe('errors', () => {
    it('fails with RateLimited on a 429, and asks nothing until the wait is over', async () => {
      let now = 5_000_000
      const server = fakeSponsorBlock(() =>
        json('slow down', { status: 429, headers: { 'retry-after': '30' } }),
      )
      const client = createSponsorBlockClient({ now: () => now })
      const ctx = contextFor(server.fetch)

      const error = await rejection(client.nonMusicSegments(VIDEO_ID, ctx))
      expect(isFxmError(error, 'RateLimited')).toBe(true)
      expect(error).toMatchObject({ retryAfterMs: 30_000 })

      now += 10_000
      const again = await rejection(client.nonMusicSegments('dQw4w9WgXcQ', ctx))
      expect(again).toMatchObject({ code: 'RateLimited', retryAfterMs: 20_000 })
      expect(server.calls).toHaveLength(1)

      now += 20_000
      await rejection(client.nonMusicSegments(VIDEO_ID, ctx))
      expect(server.calls).toHaveLength(2)
    })

    it('waits a minute after a 429 without Retry-After', async () => {
      const server = fakeSponsorBlock(() => json('', { status: 429 }))
      const error = await rejection(
        createSponsorBlockClient().nonMusicSegments(VIDEO_ID, contextFor(server.fetch)),
      )
      expect(error).toMatchObject({ code: 'RateLimited', retryAfterMs: 60_000 })
    })

    it('fails with Unavailable on another HTTP error, without caching it', async () => {
      const server = fakeSponsorBlock(
        () => new Response('Hash prefix does not match format requirements.', { status: 400 }),
      )
      const client = createSponsorBlockClient()
      const ctx = contextFor(server.fetch)
      expect(await rejection(client.nonMusicSegments(VIDEO_ID, ctx))).toMatchObject({
        code: 'Unavailable',
        message: 'SponsorBlock answered HTTP 400',
      })
      await rejection(client.nonMusicSegments(VIDEO_ID, ctx))
      expect(server.calls).toHaveLength(2)
    })

    it('fails with Parse on a body that is not JSON, or not a list', async () => {
      for (const body of ['<html>', '{"videoID":"fxmVideoAAA"}']) {
        const server = fakeSponsorBlock(() => new Response(body, { status: 200 }))
        const error = await rejection(
          createSponsorBlockClient().nonMusicSegments(VIDEO_ID, contextFor(server.fetch)),
        )
        expect(isFxmError(error, 'Parse')).toBe(true)
      }
    })

    it('fails with Network when the request fails', async () => {
      const server = fakeSponsorBlock(() => {
        throw new TypeError('Failed to fetch')
      })
      const error = await rejection(
        createSponsorBlockClient().nonMusicSegments(VIDEO_ID, contextFor(server.fetch)),
      )
      expect(error).toMatchObject({ code: 'Network', message: 'SponsorBlock could not be reached' })
      expect((error as Error).cause).toBeInstanceOf(TypeError)
    })

    it('fails with Network after timeoutMs', async () => {
      vi.useFakeTimers()
      const client = createSponsorBlockClient({ timeoutMs: 2000 })
      const lookup = rejection(client.nonMusicSegments(VIDEO_ID, contextFor(hangingFetch)))
      await vi.advanceTimersByTimeAsync(2000)
      expect(await lookup).toMatchObject({
        code: 'Network',
        message: 'SponsorBlock did not answer within 2000 ms',
      })
    })
  })

  describe('cancelling', () => {
    it('rejects with the reason of a signal that already aborted, and asks nothing', async () => {
      const server = serving()
      const controller = new AbortController()
      controller.abort(new Error('not needed'))
      const error = await rejection(
        createSponsorBlockClient().nonMusicSegments(
          VIDEO_ID,
          contextFor(server.fetch, controller.signal),
        ),
      )
      expect(error).toMatchObject({ message: 'not needed' })
      expect(server.calls).toHaveLength(0)
    })

    it('stops waiting when the signal aborts, while the answer still fills the cache', async () => {
      let answer: (response: Response) => void = () => {}
      const server = fakeSponsorBlock(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve
          }),
      )
      const client = createSponsorBlockClient()
      const controller = new AbortController()
      const waiting = rejection(
        client.nonMusicSegments(VIDEO_ID, contextFor(server.fetch, controller.signal)),
      )
      await vi.waitFor(() => expect(server.calls).toHaveLength(1))

      controller.abort(new Error('skipped'))
      expect(await waiting).toMatchObject({ message: 'skipped' })
      expect(server.calls[0]?.init?.signal?.aborted).toBe(false)

      answer(json(fixtures.bucket))
      await vi.waitFor(async () =>
        expect(await client.nonMusicSegments(VIDEO_ID, contextFor(server.fetch))).toHaveLength(3),
      )
      expect(server.calls).toHaveLength(1)
    })
  })
})

describe('toSegment', () => {
  const valid = {
    category: 'music_offtopic',
    actionType: 'skip',
    segment: [1.5, 9.25],
    UUID: 'abc',
    videoDuration: 200.123,
    locked: 0,
    votes: 3,
    description: '',
  }

  it('reads a non-music segment to skip', () => {
    expect(toSegment(valid)).toEqual({
      startMs: 1500,
      endMs: 9250,
      videoDurationMs: 200_123,
      uuid: 'abc',
    })
  })

  it('takes a segment without an action type as one to skip', () => {
    const { actionType: _actionType, ...rest } = valid
    expect(toSegment(rest)).toMatchObject({ startMs: 1500 })
  })

  it('refuses other categories and actions', () => {
    expect(toSegment({ ...valid, category: 'sponsor' })).toBeNull()
    for (const actionType of ['mute', 'full', 'poi', 'chapter', 42]) {
      expect(toSegment({ ...valid, actionType })).toBeNull()
    }
  })

  it('refuses times that are missing, reversed, negative, too long or not numbers', () => {
    for (const segment of [
      undefined,
      [],
      [1],
      [1, 2, 3],
      [5, 5],
      [6, 5],
      [-1, 5],
      [0, 86_401],
      [0, Number.NaN],
      ['0', '5'],
      { 0: 1, 1: 2 },
    ]) {
      expect(toSegment({ ...valid, segment })).toBeNull()
    }
    expect(toSegment('music_offtopic')).toBeNull()
    expect(toSegment(null)).toBeNull()
  })

  it('drops a duration or UUID that is malformed', () => {
    expect(toSegment({ ...valid, videoDuration: 0, UUID: 7 })).toEqual({
      startMs: 1500,
      endMs: 9250,
    })
    expect(toSegment({ ...valid, videoDuration: -3, UUID: '' })).toEqual({
      startMs: 1500,
      endMs: 9250,
    })
    expect(toSegment({ ...valid, UUID: 'x'.repeat(129) })).not.toHaveProperty('uuid')
  })
})

describe('parseBucket', () => {
  it('maps each videoId to its segments', () => {
    const videos = parseBucket(fixtures.bucket)
    expect([...videos.keys()]).toEqual(['fxmVideoBBB', 'fxmVideoAAA', 'fxmVideoCCC'])
  })

  it('skips entries without a videoId or a list of segments, and repeats', () => {
    const videos = parseBucket([
      null,
      { videoID: 'not an id', segments: [] },
      { videoID: 'fxmVideoAAA' },
      { videoID: 'fxmVideoAAA', segments: [{ category: 'music_offtopic', segment: [0, 1] }] },
      { videoID: 'fxmVideoAAA', segments: [{ category: 'music_offtopic', segment: [5, 9] }] },
    ])
    expect([...videos]).toEqual([['fxmVideoAAA', [{ startMs: 0, endMs: 1000 }]]])
  })

  it('keeps at most 64 segments of a video', () => {
    const segments = Array.from({ length: 80 }, (_, index) => ({
      category: 'music_offtopic',
      segment: [index * 2, index * 2 + 1],
    }))
    expect(parseBucket([{ videoID: 'fxmVideoAAA', segments }]).get('fxmVideoAAA')).toHaveLength(64)
  })

  it('fails with Parse when the answer is not a list', () => {
    for (const body of [null, {}, 'segments', 7]) {
      let error: unknown
      try {
        parseBucket(body)
      } catch (caught) {
        error = caught
      }
      expect(isFxmError(error, 'Parse')).toBe(true)
    }
  })
})
