import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contextFor, fakeService, hangingFetch, json } from '../shared/fake-fetch'
import {
  MUSICBRAINZ_USER_AGENT,
  MusicBrainzClient,
  type MusicBrainzOptions,
  phrase,
  recordingQuery,
} from './api'
import busy from './fixtures/busy.json'
import isrcCreep from './fixtures/isrc-creep.json'
import notFound from './fixtures/not-found.json'
import recordingCreep from './fixtures/recording-creep.json'
import searchCreep from './fixtures/search-creep.json'
import searchRid from './fixtures/search-rid.json'
import urlBatch from './fixtures/url-batch.json'
import urlBatchNone from './fixtures/url-batch-none.json'
import urlCreep from './fixtures/url-creep.json'
import { RequestQueue } from './queue'

const CREEP_URL = 'https://open.spotify.com/track/70LcF31zb1H0PyJoS1Sx1r'
const CREEP_MBID = '70595637-9310-45f2-a266-58f8de4874a7'

/** A fake MusicBrainz that answers from the recorded fixtures, 404 for anything else. */
function musicBrainz(overrides: (url: URL) => Response | undefined = () => undefined) {
  return fakeService((url) => {
    const override = overrides(url)
    if (override !== undefined) return override
    const path = url.pathname
    const resources = url.searchParams.getAll('resource')
    if (path === '/ws/2/url') {
      if (resources.length > 1) {
        return json(resources.includes(CREEP_URL) ? urlBatch : urlBatchNone)
      }
      return resources[0] === CREEP_URL ? json(urlCreep) : json(notFound, { status: 404 })
    }
    if (path === `/ws/2/recording/${CREEP_MBID}`) return json(recordingCreep)
    if (path === '/ws/2/isrc/GBAYE9200070') return json(isrcCreep)
    if (path === '/ws/2/recording') {
      return json(url.searchParams.get('query')?.startsWith('rid:') ? searchRid : searchCreep)
    }
    return json(notFound, { status: 404 })
  })
}

/** A client with its own queue, so tests never wait on each other. */
function client(options: MusicBrainzOptions = {}): MusicBrainzClient {
  return new MusicBrainzClient({ queue: new RequestQueue(0), ...options })
}

describe('MusicBrainzClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('looks a Spotify track URL up through its URL relationships', async () => {
    const service = musicBrainz()
    const recordings = await client().lookupUrl(CREEP_URL, contextFor(service.fetch))
    // A relationship names the recording without its credit or ISRCs, so neither is claimed.
    expect(recordings).toEqual([
      {
        id: CREEP_MBID,
        title: 'Creep',
        lengthMs: 236666,
        disambiguation: 'You’re so fucking special',
        video: false,
      },
    ])
    const [call] = service.calls
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe('https://musicbrainz.org/ws/2/url')
    expect(call?.url.searchParams.get('resource')).toBe(CREEP_URL)
    expect(call?.url.searchParams.get('inc')).toBe('recording-rels')
    expect(call?.url.searchParams.get('fmt')).toBe('json')
  })

  it('answers an unknown URL with no recordings', async () => {
    const service = musicBrainz()
    const url = 'https://open.spotify.com/track/0000000000000000000000'
    await expect(client().lookupUrl(url, contextFor(service.fetch))).resolves.toEqual([])
  })

  it('looks up to 100 URLs up in one request', async () => {
    const service = musicBrainz()
    const unknown = Array.from(
      { length: 120 },
      (_, index) => `https://open.spotify.com/track/${String(index).padStart(22, '0')}`,
    )
    const found = await client().lookupUrls([CREEP_URL, ...unknown], contextFor(service.fetch))
    expect([...found.keys()]).toEqual([CREEP_URL])
    expect(found.get(CREEP_URL)?.map((recording) => recording.id)).toEqual([CREEP_MBID])
    expect(service.calls.map((call) => call.url.searchParams.getAll('resource').length)).toEqual([
      100, 21,
    ])
  })

  it('skips values that are not web URLs instead of failing the batch', async () => {
    const service = musicBrainz()
    const found = await client().lookupUrls(
      ['spotify:local:Artist:Album:Title:215', 'not a url', CREEP_URL, 'ftp://x.test/a'],
      contextFor(service.fetch),
    )
    expect([...found.keys()]).toEqual([CREEP_URL])
    expect(service.calls.map((call) => call.url.searchParams.getAll('resource'))).toEqual([
      [CREEP_URL],
    ])
    await expect(client().lookupUrls(['nothing'], contextFor(service.fetch))).resolves.toEqual(
      new Map(),
    )
    expect(service.calls).toHaveLength(1)
  })

  it('reads the single-entity answer of a batch of one', async () => {
    const service = musicBrainz()
    const found = await client().lookupUrls([CREEP_URL, CREEP_URL], contextFor(service.fetch))
    expect(found.get(CREEP_URL)?.[0]?.lengthMs).toBe(236666)
    expect(service.calls).toHaveLength(1)
  })

  it('loads a recording with its ISRCs and artist credit', async () => {
    const service = musicBrainz()
    const recording = await client().getRecording(CREEP_MBID, contextFor(service.fetch))
    expect(recording).toMatchObject({
      id: CREEP_MBID,
      title: 'Creep',
      artists: ['Radiohead'],
      credits: [{ name: 'Radiohead', id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', joinPhrase: '' }],
      isrcs: ['GBAYE9200070'],
      lengthMs: 236666,
      firstReleaseDate: '1992-09-21',
    })
    const inc = service.calls[0]?.url.href.match(/[?&]inc=([^&]*)/u)?.[1]
    expect(inc).toBe('isrcs+artist-credits')
  })

  it('rejects with NotFound for an unknown recording', async () => {
    const service = musicBrainz()
    const error = await client()
      .getRecording('00000000-0000-0000-0000-000000000000', contextFor(service.fetch))
      .catch((caught: unknown) => caught)
    expect(isFxmError(error, 'NotFound')).toBe(true)
  })

  it('refuses a value that is not an MBID, without a request', async () => {
    const service = musicBrainz()
    const ctx = contextFor(service.fetch)
    await expect(client().getRecording('junk', ctx)).rejects.toThrow(RangeError)
    const found = await client().getRecordings(['junk', CREEP_MBID], ctx)
    expect([...found.keys()]).toEqual([CREEP_MBID])
    expect(service.calls.map((call) => call.url.searchParams.get('query'))).toEqual([
      `rid:"${CREEP_MBID}"`,
    ])
  })

  it('loads many recordings through one search by MBID, then looks up the rest', async () => {
    const service = musicBrainz()
    const missing = '11111111-1111-1111-1111-111111111111'
    const found = await client().getRecordings(
      [CREEP_MBID, missing, CREEP_MBID],
      contextFor(service.fetch),
    )
    expect([...found.keys()]).toEqual([CREEP_MBID])
    expect(found.get(CREEP_MBID)).toMatchObject({ isrcs: ['GBAYE9200070'], artists: ['Radiohead'] })
    expect(found.get(CREEP_MBID)).not.toHaveProperty('releases')
    const query = service.calls[0]?.url.searchParams.get('query')
    expect(query).toBe(`rid:"${CREEP_MBID}" OR rid:"${missing}"`)
    expect(service.calls[0]?.url.searchParams.get('limit')).toBe('2')
    expect(service.calls.map((call) => call.url.pathname)).toEqual([
      '/ws/2/recording',
      `/ws/2/recording/${missing}`,
    ])
  })

  it('finds the recordings that carry an ISRC', async () => {
    const service = musicBrainz()
    const recordings = await client().lookupIsrc('gb-aye-92-00070', contextFor(service.fetch))
    expect(recordings.map((recording) => recording.id)).toEqual([
      '1f9f17c7-6085-4d52-9bd0-13a94cc449bc',
      CREEP_MBID,
    ])
    expect(recordings.every((recording) => recording.isrcs.includes('GBAYE9200070'))).toBe(true)
    expect(service.calls[0]?.url.pathname).toBe('/ws/2/isrc/GBAYE9200070')
  })

  it('answers an unknown ISRC with no recordings, and refuses a malformed one', async () => {
    const service = musicBrainz()
    const ctx = contextFor(service.fetch)
    await expect(client().lookupIsrc('USUM71703861', ctx)).resolves.toEqual([])
    await expect(client().lookupIsrc('not an isrc', ctx)).rejects.toThrow(RangeError)
    expect(service.calls).toHaveLength(1)
  })

  it('searches recordings by title and artist within a window around the duration', async () => {
    const service = musicBrainz()
    const hits = await client().searchRecordings(
      { title: 'Creep', artist: 'Radiohead', durationMs: 238_640 },
      contextFor(service.fetch),
    )
    expect(hits).toHaveLength(10)
    expect(hits[0]).toMatchObject({ score: 100, disambiguation: expect.stringMatching(/^live/u) })
    const canonical = hits.find((hit) => hit.id === CREEP_MBID)
    expect(canonical?.releases).toHaveLength(130)
    expect(canonical?.releases[0]).toEqual({
      id: expect.any(String),
      title: 'Pablo Honey',
      status: 'Official',
      primaryType: 'Album',
      secondaryTypes: [],
    })
    const params = service.calls[0]?.url.searchParams
    expect(params?.get('query')).toBe(
      'recording:"Creep" AND artist:"Radiohead" AND dur:[226708 TO 250572]',
    )
    expect(params?.get('limit')).toBe('25')
  })

  it('builds Lucene phrases that a title cannot break out of', () => {
    expect(phrase('Say "Hi" \\ Bye')).toBe('"Say \\"Hi\\" \\\\ Bye"')
    expect(recordingQuery({ title: 'A) OR (b', artist: 'X' })).toBe(
      'recording:"A) OR (b" AND artist:"X"',
    )
    expect(recordingQuery({ title: 'T', artist: 'A', durationMs: 4_000, windowMs: 5_000 })).toBe(
      'recording:"T" AND artist:"A" AND dur:[0 TO 9000]',
    )
  })

  describe('User-Agent', () => {
    it.each([
      ['web', undefined, null],
      ['desktop', undefined, MUSICBRAINZ_USER_AGENT],
      ['android', undefined, MUSICBRAINZ_USER_AGENT],
      ['web', 'Custom/1.0 ( https://example.test )', 'Custom/1.0 ( https://example.test )'],
      ['desktop', false, null],
    ] as const)('on %s with the option %s sends %s', async (platform, userAgent, expected) => {
      const service = musicBrainz()
      const ctx = contextFor(service.fetch, { platform })
      const mb = client(userAgent === undefined ? {} : { userAgent })
      await mb.lookupUrl(CREEP_URL, ctx)
      expect(service.calls[0]?.headers.get('user-agent')).toBe(expected)
      expect(mb.userAgentFor(ctx)).toBe(expected ?? undefined)
    })

    it('names FXM, its version and its project page, as MusicBrainz asks', () => {
      expect(MUSICBRAINZ_USER_AGENT).toMatch(
        /^FXM\/\d+\.\d+\.\d+ \( https:\/\/github\.com\/Pratyay-ops\/FXM \)$/u,
      )
    })

    it('sends no headers at all from a web page, so no request needs a CORS preflight', async () => {
      const service = musicBrainz()
      await client().lookupUrl(CREEP_URL, contextFor(service.fetch))
      expect([...(service.calls[0]?.headers.keys() ?? [])]).toEqual([])
      expect(service.calls[0]?.init?.credentials).toBe('omit')
    })
  })

  describe('when MusicBrainz is busy', () => {
    it('waits at least a second, doubling each time, and tries again', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      let answered = 0
      const service = musicBrainz(() =>
        answered++ < 2 ? json(busy, { status: 503, headers: { 'retry-after': '0' } }) : undefined,
      )
      const mb = client({ queue: new RequestQueue(1000) })
      const lookup = mb.lookupUrl(CREEP_URL, contextFor(service.fetch))
      await vi.advanceTimersByTimeAsync(3000)
      await expect(lookup).resolves.toHaveLength(1)
      expect(service.calls.map((call) => call.at)).toEqual([0, 1000, 3000])
    })

    it('honours a longer Retry-After', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      let answered = 0
      const service = musicBrainz(() =>
        answered++ === 0 ? json(busy, { status: 503, headers: { 'retry-after': '7' } }) : undefined,
      )
      const lookup = client().lookupUrl(CREEP_URL, contextFor(service.fetch))
      await vi.advanceTimersByTimeAsync(7000)
      await expect(lookup).resolves.toHaveLength(1)
      expect(service.calls.map((call) => call.at)).toEqual([0, 7000])
    })

    it('rejects at once rather than wait out a long Retry-After, and keeps the queue paused', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      let busyFor = 1
      const service = musicBrainz(() =>
        busyFor-- > 0 ? json(busy, { status: 503, headers: { 'retry-after': '3600' } }) : undefined,
      )
      const queue = new RequestQueue(1000)
      const mb = client({ queue })
      const ctx = contextFor(service.fetch)
      // The matcher's call gets the 503; an import with a patient limit waits behind it.
      const first = mb.lookupUrl(CREEP_URL, ctx).catch((caught: unknown) => caught)
      const patient = client({ queue, maxWaitMs: 7_200_000 }).lookupIsrc('GBAYE9200070', ctx)
      const waiting = mb.getRecording(CREEP_MBID, ctx).catch((caught: unknown) => caught)
      await vi.advanceTimersByTimeAsync(0)
      expect(service.calls).toHaveLength(1)
      const [refused, alsoRefused] = await Promise.all([first, waiting])
      expect(isFxmError(refused, 'RateLimited')).toBe(true)
      expect(refused).toMatchObject({ retryAfterMs: 3_600_000 })
      expect(alsoRefused).toMatchObject({ code: 'RateLimited', retryAfterMs: 3_600_000 })
      const later = await mb.lookupIsrc('USUM71703861', ctx).catch((caught: unknown) => caught)
      expect(later).toMatchObject({ code: 'RateLimited' })
      expect(service.calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(3_600_000)
      await expect(patient).resolves.toHaveLength(2)
      expect(service.calls.map((call) => call.at)).toEqual([0, 3_600_000])
    })

    it('gives up with RateLimited after the last try', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const service = musicBrainz(() => json(busy, { status: 503 }))
      const error = client({ maxAttempts: 2 })
        .lookupUrl(CREEP_URL, contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      await vi.advanceTimersByTimeAsync(1000)
      const caught = await error
      expect(isFxmError(caught, 'RateLimited')).toBe(true)
      expect(caught).toMatchObject({ retryAfterMs: 2000 })
      expect(service.calls).toHaveLength(2)
    })
  })

  it('maps other failures to typed errors', async () => {
    const badRequest = musicBrainz(() => json({ error: 'Invalid query' }, { status: 400 }))
    const error = await client()
      .lookupUrl(CREEP_URL, contextFor(badRequest.fetch))
      .catch((caught: unknown) => caught)
    expect(isFxmError(error, 'Unavailable')).toBe(true)

    const offline = fakeService(() => {
      throw new TypeError('Failed to fetch')
    })
    const network = await client()
      .lookupUrl(CREEP_URL, contextFor(offline.fetch))
      .catch((caught: unknown) => caught)
    expect(isFxmError(network, 'Network')).toBe(true)

    const garbled = musicBrainz(() => new Response('<html>busy</html>', { status: 200 }))
    const parse = await client()
      .lookupUrl(CREEP_URL, contextFor(garbled.fetch))
      .catch((caught: unknown) => caught)
    expect(isFxmError(parse, 'Parse')).toBe(true)
  })

  it('rejects with the caller’s reason when the caller cancels', async () => {
    const controller = new AbortController()
    const lookup = client().lookupUrl(
      CREEP_URL,
      contextFor(hangingFetch, { signal: controller.signal }),
    )
    const reason = new Error('left the page')
    controller.abort(reason)
    await expect(lookup).rejects.toBe(reason)
  })

  it('times out a request that never answers', async () => {
    const error = await client({ timeoutMs: 10 })
      .lookupUrl(CREEP_URL, contextFor(hangingFetch))
      .catch((caught: unknown) => caught)
    expect(isFxmError(error, 'Network')).toBe(true)
    expect(String((error as Error).message)).toMatch(/10 ms/u)
  })

  it('answers the same lookup from memory, whatever the platform', async () => {
    const service = musicBrainz()
    const mb = client()
    await mb.lookupUrl(CREEP_URL, contextFor(service.fetch))
    await mb.lookupUrl(CREEP_URL, contextFor(service.fetch, { platform: 'desktop' }))
    await Promise.all([
      mb.getRecording(CREEP_MBID, contextFor(service.fetch)),
      mb.getRecording(CREEP_MBID, contextFor(service.fetch)),
    ])
    expect(service.calls).toHaveLength(2)
  })

  it('forgets lookups after their lifetime', async () => {
    let now = 0
    const service = musicBrainz()
    const mb = client({ lookupTtlMs: 1000, now: () => now })
    await mb.lookupUrl(CREEP_URL, contextFor(service.fetch))
    now = 999
    await mb.lookupUrl(CREEP_URL, contextFor(service.fetch))
    now = 1000
    await mb.lookupUrl(CREEP_URL, contextFor(service.fetch))
    expect(service.calls).toHaveLength(2)
  })

  it('starts the call for the playing track before an import’s', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const queue = new RequestQueue(1000)
    const service = musicBrainz()
    const ctx = contextFor(service.fetch)
    const mb = client({ queue })
    const bulk = Promise.all([
      mb.lookupIsrc('GBAYE9200070', ctx, { priority: 'bulk' }),
      mb.lookupIsrc('USUM71703861', ctx, { priority: 'bulk' }),
      mb.lookupIsrc('USUM71703862', ctx, { priority: 'bulk' }),
    ])
    const playing = mb.lookupUrl(CREEP_URL, ctx, { priority: 'current-track' })
    await vi.advanceTimersByTimeAsync(3000)
    await Promise.all([bulk, playing])
    expect(service.calls.map((call) => call.url.pathname)).toEqual([
      '/ws/2/isrc/GBAYE9200070',
      '/ws/2/url',
      '/ws/2/isrc/USUM71703861',
      '/ws/2/isrc/USUM71703862',
    ])
  })

  it('spaces the requests of every client that shares a queue', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const queue = new RequestQueue(1000)
    const service = musicBrainz()
    const ctx = contextFor(service.fetch)
    const lookups = Promise.all([
      client({ queue }).lookupUrl(CREEP_URL, ctx),
      client({ queue }).getRecording(CREEP_MBID, ctx),
      client({ queue }).lookupIsrc('GBAYE9200070', ctx),
    ])
    await vi.advanceTimersByTimeAsync(2000)
    await lookups
    expect(service.calls.map((call) => call.at)).toEqual([0, 1000, 2000])
  })
})
