import {
  type AudioCandidate,
  type AudioSource,
  type EntityId,
  FxmError,
  formatId,
  type ProviderContext,
  type SearchResults,
  type Track,
} from '@fxm/core'
import type { TrackMatchRequest } from '@fxm/player'
import type { IsrcFinding } from '@fxm/sources/musicbrainz'
import { describe, expect, it, vi } from 'vitest'
import { createTrackMatcher, type MatcherSearches, matchDetails } from './matcher'

const ISRC = 'GBAYE9200070'

function song(videoId: string, overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('ytm', 'track', videoId),
    source: 'ytm',
    title: 'Creep',
    artists: [{ name: 'Radiohead' }],
    album: { id: formatId('ytm', 'album', 'MPREb_pablo'), name: 'Pablo Honey' },
    durationMs: 238_000,
    artwork: [],
    kind: 'song',
    ...overrides,
  }
}

const SPOTIFY: Track = {
  id: formatId('spotify', 'track', '70LcF31zb1H0PyJoS1Sx1r'),
  source: 'spotify',
  title: 'Creep',
  artists: [{ name: 'Radiohead' }],
  album: { name: 'Pablo Honey' },
  durationMs: 238_640,
  artwork: [],
  kind: 'song',
}

const RIGHT = song('right1')
const COVER = song('cover1', {
  title: 'Creep (Acoustic Cover)',
  artists: [{ name: 'Someone Else' }],
  durationMs: 201_000,
})

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as ProviderContext['fetch'],
    platform: 'web',
    capabilities: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
    mode: 'music',
    ...overrides,
  }
}

function request(overrides: Partial<TrackMatchRequest> = {}): TrackMatchRequest {
  const signal = overrides.signal ?? new AbortController().signal
  return {
    target: 'song',
    ctx: ctx({ signal }),
    exclude: [],
    priority: 'current-track',
    signal,
    ...overrides,
  }
}

/** Searches that answer every songs query with `songs`, and record the queries. */
function searches(songs: readonly Track[], options: { fail?: boolean } = {}) {
  const queries: string[] = []
  const search = vi.fn(async (query: string, { types }: { types: readonly string[] }) => {
    queries.push(`${types.join()}:${query}`)
    if (options.fail) throw new FxmError('Network', 'offline')
    const results: SearchResults = types.includes('track')
      ? { tracks: { items: [...songs] } }
      : { videos: { items: [] } }
    return results
  })
  const found: MatcherSearches = {
    music: {
      search,
      topResult: vi.fn(async () => undefined),
      getDescription: vi.fn(async () => undefined),
    },
    video: { search },
  }
  return { found, queries }
}

function candidate(source: 'archive' | 'jamendo', ref: string, extra: Partial<AudioCandidate>) {
  return {
    source,
    ref,
    kind: 'song',
    title: 'Creep',
    artists: ['Radiohead'],
    confidence: 0.7,
    evidence: [`${source} ${ref}`],
    ...extra,
  } satisfies AudioCandidate
}

function lossless(...answers: (readonly AudioCandidate[] | Error)[]): AudioSource[] {
  return answers.map((answer, index) => ({
    id: index === 0 ? 'archive' : 'jamendo',
    match: async () => {
      if (answer instanceof Error) throw answer
      return [...answer]
    },
    resolve: async () => [],
  }))
}

describe('createTrackMatcher, for songs', () => {
  it('verifies the song by the ISRC Spotify gives, and waits for the Auto setting', async () => {
    const { found, queries } = searches([RIGHT, COVER])
    const details = vi.fn(async () => ({ isrc: ISRC, label: 'XL', releaseDate: '1993-02-22' }))
    const off = createTrackMatcher({
      youtube: async () => found,
      lossless: async () => [],
      details,
    })
    const on = createTrackMatcher({
      youtube: async () => found,
      lossless: async () => [],
      details,
      autoMatch: () => true,
    })

    const suggested = await off.match(SPOTIFY, request())
    const auto = await on.match(SPOTIFY, request())

    expect(queries[0]).toBe(`track:${ISRC}`)
    expect(suggested.best?.ref).toBe('right1')
    expect(suggested.best?.signals?.isrcVerified).toBe(true)
    expect(suggested.band).toBe('suggest')
    expect(auto.band).toBe('auto')
    expect(details).toHaveBeenCalledWith(SPOTIFY, expect.objectContaining({ target: 'song' }))
  })

  it('matches by text without an ISRC, with the alternatives behind the best', async () => {
    const { found, queries } = searches([COVER, RIGHT])
    const matcher = createTrackMatcher({ youtube: async () => found, lossless: async () => [] })

    const outcome = await matcher.match(SPOTIFY, request())

    expect(queries[0]).toBe('track:Radiohead Creep')
    expect(outcome.best?.ref).toBe('right1')
    expect(outcome.alternatives.map((alternative) => alternative.ref)).not.toContain('right1')
    expect(outcome.incomplete).toBe(false)
  })

  it('never offers a candidate Smart Replace found gone', async () => {
    const { found } = searches([RIGHT, song('right2')])
    const matcher = createTrackMatcher({ youtube: async () => found, lossless: async () => [] })
    const gone: AudioCandidate = { ...candidate('archive', 'x', {}), source: 'ytm', ref: 'right1' }

    const outcome = await matcher.match(SPOTIFY, request({ exclude: [gone] }))

    const refs = [outcome.best, ...outcome.alternatives].map((match) => match?.ref)
    expect(refs).not.toContain('right1')
    expect(outcome.best?.ref).toBe('right2')
  })

  it('skips a page it could not fetch, reports why, and says the match is incomplete', async () => {
    const { found } = searches([], { fail: true })
    const report = vi.fn()
    const matcher = createTrackMatcher({
      youtube: async () => found,
      lossless: async () => [],
      report,
    })

    const outcome = await matcher.match(SPOTIFY, request())

    expect(outcome.band).toBe('none')
    expect(outcome.incomplete).toBe(true)
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: 'Network' }))
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    const { found } = searches([RIGHT])
    found.music.search = vi.fn(async () => {
      controller.abort(new DOMException('Cancelled', 'AbortError'))
      throw new FxmError('Network', 'aborted')
    })
    const matcher = createTrackMatcher({ youtube: async () => found, lossless: async () => [] })

    await expect(
      matcher.match(SPOTIFY, request({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it("matches an official video to its song in Music mode, by the video's title", async () => {
    const { found, queries } = searches([RIGHT])
    const matcher = createTrackMatcher({ youtube: async () => found, lossless: async () => [] })
    const video = song('video1', {
      title: 'Radiohead - Creep (Official Video)',
      kind: 'music-video',
      durationMs: 241_000,
    })

    const outcome = await matcher.match(video, request())

    expect(queries).toEqual(['track:Radiohead Creep'])
    expect(outcome.best?.ref).toBe('right1')
    expect(outcome.best?.kind).toBe('song')
  })
})

describe('createTrackMatcher, for lossless copies', () => {
  it('puts an ISRC-verified copy first, from either source', async () => {
    const verified = candidate('jamendo', '1', {
      confidence: 1,
      signals: { isrcVerified: true, sourceAlbumMatch: false },
    })
    const text = candidate('archive', 'item/01.flac', { confidence: 0.79 })
    const matcher = createTrackMatcher({
      youtube: async () => searches([]).found,
      lossless: async () => lossless([text], [verified]),
    })

    const outcome = await matcher.match(SPOTIFY, request({ target: 'lossless' }))

    expect(outcome.best).toBe(verified)
    expect(outcome.alternatives).toEqual([text])
    // A text-only copy is a suggestion at most; the policy plays only a verified one first.
    expect(outcome.band).toBe('suggest')
  })

  it('goes on without a source that failed, and leaves out excluded copies', async () => {
    const report = vi.fn()
    const kept = candidate('archive', 'item/02.flac', {})
    const gone = candidate('archive', 'item/01.flac', {})
    const matcher = createTrackMatcher({
      youtube: async () => searches([]).found,
      lossless: async () => lossless([gone, kept], new FxmError('RateLimited', 'quota')),
      report,
    })

    const outcome = await matcher.match(SPOTIFY, request({ target: 'lossless', exclude: [gone] }))

    expect(outcome.best).toBe(kept)
    expect(outcome.incomplete).toBe(true)
    expect(report).toHaveBeenCalledOnce()
  })

  it('finds nothing without copies', async () => {
    const matcher = createTrackMatcher({
      youtube: async () => searches([]).found,
      lossless: async () => lossless([]),
    })

    const outcome = await matcher.match(SPOTIFY, request({ target: 'lossless' }))

    expect(outcome).toEqual({ band: 'none', alternatives: [], evidence: [], incomplete: false })
  })
})

describe('the release facts', () => {
  it('reads the descriptions the engine asks for, keyed by track', async () => {
    const { found } = searches([RIGHT, song('right2', { album: { name: 'Creep (EP)' } })])
    const getDescription = vi.fn(
      async (id: EntityId<'track'>) =>
        `Provided to YouTube by XL Recordings\n\nCreep · Radiohead\n\n℗ 1993 XL\n\nReleased on: 1993-02-22\n${id}`,
    )
    found.music.getDescription = getDescription
    const matcher = createTrackMatcher({
      youtube: async () => found,
      lossless: async () => [],
      details: async () => ({ label: 'XL Recordings', releaseDate: '1993-02-22' }),
    })

    await matcher.match(SPOTIFY, request())

    expect(getDescription).toHaveBeenCalled()
    expect(getDescription.mock.calls[0]?.[0]).toMatch(/^ytm:track:/)
  })
})

describe('matchDetails, what the engine reads about a Spotify track', () => {
  /** Spotify's answer for SPOTIFY, as `getTrackDetails` gives it. */
  const DETAILS = {
    label: 'XL Recordings',
    releaseDate: '1993-02-22',
    albumType: 'album' as const,
  }
  const FINDING: IsrcFinding = {
    origin: 'musicbrainz-exact',
    isrc: ISRC,
    isrcs: [ISRC],
    recording: {
      id: 'mbid-creep',
      title: 'Creep',
      lengthMs: 238_000,
      video: false,
      credits: [],
      artists: ['Radiohead'],
      isrcs: [ISRC],
    },
  }

  function setUp(answers: { spotify?: object | 'off' | Error; exact?: object | null | Error }) {
    const getTrackDetails = vi.fn(async () => {
      if (answers.spotify instanceof Error) throw answers.spotify
      return answers.spotify as object
    })
    const spotify = { isAvailable: vi.fn(() => true), getTrackDetails }
    const exactIsrc = vi.fn(async () => {
      if (answers.exact instanceof Error) throw answers.exact
      return (answers.exact ?? null) as IsrcFinding | null
    })
    const report = vi.fn()
    const details = matchDetails({
      spotify: async () => (answers.spotify === 'off' ? undefined : spotify),
      exactIsrc,
      report,
    })
    return { details, getTrackDetails, exactIsrc, report }
  }

  it("reads nothing for other sources' tracks", async () => {
    const { details, getTrackDetails, exactIsrc } = setUp({ spotify: DETAILS })

    await expect(details(RIGHT, request())).resolves.toBeUndefined()
    expect(getTrackDetails).not.toHaveBeenCalled()
    expect(exactIsrc).not.toHaveBeenCalled()
  })

  it("takes Spotify's details as they are when they have an ISRC", async () => {
    const { details, exactIsrc } = setUp({ spotify: { ...DETAILS, isrc: ISRC } })

    await expect(details(SPOTIFY, request())).resolves.toEqual({ ...DETAILS, isrc: ISRC })
    expect(exactIsrc).not.toHaveBeenCalled()
  })

  it("adds MusicBrainz's exact ISRC to Spotify's details when Spotify has none", async () => {
    const { details } = setUp({ spotify: DETAILS, exact: FINDING })

    await expect(details(SPOTIFY, request())).resolves.toEqual({
      ...DETAILS,
      isrc: ISRC,
      isrcOrigin: 'musicbrainz-exact',
    })
  })

  it("asks MusicBrainz alone where Spotify can't be asked, with the recording's length", async () => {
    const { details, getTrackDetails } = setUp({ spotify: 'off', exact: FINDING })
    const { durationMs: _durationMs, ...withoutDuration } = SPOTIFY

    await expect(details(withoutDuration, request())).resolves.toEqual({
      isrc: ISRC,
      isrcOrigin: 'musicbrainz-exact',
      durationMs: 238_000,
    })
    expect(getTrackDetails).not.toHaveBeenCalled()
  })

  it('asks no one for an ISRC the track has', async () => {
    const { details, exactIsrc } = setUp({ spotify: 'off', exact: FINDING })

    await expect(details({ ...SPOTIFY, isrc: ISRC }, request())).resolves.toBeUndefined()
    expect(exactIsrc).not.toHaveBeenCalled()
  })

  it('goes on to MusicBrainz when Spotify fails, and reports why', async () => {
    const failure = new FxmError('BotCheck', 'Spotify wants a check')
    const { details, report } = setUp({ spotify: failure, exact: FINDING })

    await expect(details(SPOTIFY, request())).resolves.toMatchObject({ isrc: ISRC })
    expect(report).toHaveBeenCalledWith(failure)
  })

  it("keeps Spotify's details when MusicBrainz fails or finds nothing", async () => {
    const failed = setUp({ spotify: DETAILS, exact: new FxmError('Network', 'offline') })
    const none = setUp({ spotify: 'off', exact: null })

    await expect(failed.details(SPOTIFY, request())).resolves.toEqual(DETAILS)
    await expect(none.details(SPOTIFY, request())).resolves.toBeUndefined()
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    const { details } = setUp({ spotify: new FxmError('Network', 'cut off') })

    await expect(details(SPOTIFY, request({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
