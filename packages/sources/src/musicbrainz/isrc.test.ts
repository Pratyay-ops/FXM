import { formatId, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { contextFor, fakeService, json } from '../shared/fake-fetch'
import { MusicBrainzClient, type MusicBrainzLookups, type MusicBrainzRecording } from './api'
import notFound from './fixtures/not-found.json'
import recordingCreep from './fixtures/recording-creep.json'
import searchCreep from './fixtures/search-creep.json'
import searchRid from './fixtures/search-rid.json'
import urlBatch from './fixtures/url-batch.json'
import urlCreep from './fixtures/url-creep.json'
import { findExactIsrc, findExactIsrcs, findIsrcHint, spotifyTrackUrl } from './isrc'
import { RequestQueue } from './queue'

const CREEP_ID = '70LcF31zb1H0PyJoS1Sx1r'
const CREEP_URL = `https://open.spotify.com/track/${CREEP_ID}`
const CREEP_MBID = '70595637-9310-45f2-a266-58f8de4874a7'

/** A fake MusicBrainz answering from the fixtures; `urlAnswer` replaces the Creep URL lookup. */
function musicBrainz(urlAnswer: unknown = urlCreep) {
  return fakeService((url) => {
    const resources = url.searchParams.getAll('resource')
    if (url.pathname === '/ws/2/url') {
      if (resources.length > 1) return json(urlBatch)
      if (resources[0] === CREEP_URL) return json(urlAnswer)
    }
    if (url.pathname === `/ws/2/recording/${CREEP_MBID}`) return json(recordingCreep)
    if (url.pathname === '/ws/2/recording') {
      return json(url.searchParams.get('query')?.startsWith('rid:') ? searchRid : searchCreep)
    }
    return json(notFound, { status: 404 })
  })
}

function client(): MusicBrainzClient {
  return new MusicBrainzClient({ queue: new RequestQueue(0) })
}

/** Creep as Spotify describes it. */
function creep(overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('spotify', 'track', CREEP_ID),
    source: 'spotify',
    title: 'Creep',
    artists: [{ name: 'Radiohead' }],
    album: { name: 'Pablo Honey' },
    durationMs: 238_640,
    artwork: [],
    kind: 'song',
    ...overrides,
  }
}

describe('spotifyTrackUrl', () => {
  it.each([
    CREEP_ID,
    `spotify:track:${CREEP_ID}`,
    `https://open.spotify.com/track/${CREEP_ID}`,
    `https://open.spotify.com/track/${CREEP_ID}?si=abc123&context=x`,
    `https://open.spotify.com/intl-de/track/${CREEP_ID}#top`,
    `https://open.spotify.com/intl-pt-br/track/${CREEP_ID}`,
    `open.spotify.com/track/${CREEP_ID}`,
    `http://play.spotify.com/track/${CREEP_ID}`,
    `  ${CREEP_ID}\n`,
  ])('reads %s', (reference) => {
    expect(spotifyTrackUrl(reference)).toBe(CREEP_URL)
  })

  it.each([
    '',
    'Creep',
    `${CREEP_ID}x`,
    `spotify:album:${CREEP_ID}`,
    `https://open.spotify.com/album/${CREEP_ID}`,
    `https://example.com/track/${CREEP_ID}`,
    'https://open.spotify.com/track/short',
  ])('refuses %j', (reference) => {
    expect(spotifyTrackUrl(reference)).toBeNull()
  })
})

describe('findExactIsrc', () => {
  it('reads the ISRC and length of the recording linked to the Spotify track', async () => {
    const service = musicBrainz()
    const finding = await findExactIsrc(client(), creep().id, contextFor(service.fetch))
    expect(finding).toMatchObject({
      origin: 'musicbrainz-exact',
      isrc: 'GBAYE9200070',
      isrcs: ['GBAYE9200070'],
      recording: { id: CREEP_MBID, lengthMs: 236666, artists: ['Radiohead'] },
    })
    expect(service.calls.map((call) => call.url.pathname)).toEqual([
      '/ws/2/url',
      `/ws/2/recording/${CREEP_MBID}`,
    ])
  })

  it('finds nothing for a track MusicBrainz does not link, in one request', async () => {
    const service = musicBrainz()
    const unknown = '0'.repeat(22)
    await expect(findExactIsrc(client(), unknown, contextFor(service.fetch))).resolves.toBeNull()
    expect(service.calls).toHaveLength(1)
  })

  it('finds nothing when the URL is linked to two recordings, which leaves the ISRC unsure', async () => {
    const relation = urlCreep.relations[0]
    const twice = {
      ...urlCreep,
      relations: [
        relation,
        { ...relation, recording: { ...relation?.recording, id: 'another-recording' } },
      ],
    }
    const service = musicBrainz(twice)
    await expect(findExactIsrc(client(), CREEP_URL, contextFor(service.fetch))).resolves.toBeNull()
    expect(service.calls).toHaveLength(1)
  })

  it('still returns the length when the recording has no ISRC', async () => {
    const { isrcs: _isrcs, ...withoutIsrcs } = recordingCreep
    const service = fakeService((url) =>
      url.pathname === '/ws/2/url' ? json(urlCreep) : json(withoutIsrcs),
    )
    const finding = await findExactIsrc(client(), CREEP_ID, contextFor(service.fetch))
    expect(finding).toMatchObject({
      origin: 'musicbrainz-exact',
      isrcs: [],
      recording: { lengthMs: 236666 },
    })
    expect(finding).not.toHaveProperty('isrc')
  })

  it('refuses a reference that is not a Spotify track', async () => {
    const service = musicBrainz()
    await expect(findExactIsrc(client(), 'Creep', contextFor(service.fetch))).rejects.toThrow(
      RangeError,
    )
    expect(service.calls).toHaveLength(0)
  })
})

describe('findExactIsrcs', () => {
  it('looks many tracks up with one URL request and one recording search', async () => {
    const service = musicBrainz()
    const unknown = '0'.repeat(22)
    const findings = await findExactIsrcs(
      client(),
      [`spotify:track:${CREEP_ID}`, unknown, CREEP_URL],
      contextFor(service.fetch),
    )
    expect([...findings.keys()]).toEqual([`spotify:track:${CREEP_ID}`, CREEP_URL])
    expect(findings.get(CREEP_URL)).toMatchObject({
      origin: 'musicbrainz-exact',
      isrc: 'GBAYE9200070',
    })
    expect(service.calls.map((call) => call.url.pathname)).toEqual(['/ws/2/url', '/ws/2/recording'])
    expect(service.calls[0]?.url.searchParams.getAll('resource')).toEqual([
      CREEP_URL,
      `https://open.spotify.com/track/${unknown}`,
    ])
  })

  it('makes no request for an empty list', async () => {
    const service = musicBrainz()
    await expect(findExactIsrcs(client(), [], contextFor(service.fetch))).resolves.toEqual(
      new Map(),
    )
    expect(service.calls).toHaveLength(0)
  })

  it('leaves out what is not a Spotify track instead of failing the whole import', async () => {
    const service = musicBrainz()
    const ctx = contextFor(service.fetch)
    const findings = await findExactIsrcs(
      client(),
      [
        CREEP_ID,
        'spotify:local:Artist:Album:Title:215',
        'spotify:episode:0Q86acNRm6V9GYx55SXKwf',
        'not a track',
        `https://open.spotify.com/track/${CREEP_ID}?si=x`,
      ],
      ctx,
    )
    expect([...findings.keys()]).toEqual([
      CREEP_ID,
      `https://open.spotify.com/track/${CREEP_ID}?si=x`,
    ])
    expect(service.calls[0]?.url.searchParams.getAll('resource')).toEqual([CREEP_URL])
    await expect(findExactIsrcs(client(), ['spotify:local:a:b:c:1', ''], ctx)).resolves.toEqual(
      new Map(),
    )
    expect(service.calls).toHaveLength(2)
  })
})

describe('the lookups a finder needs', () => {
  const recording: MusicBrainzRecording = {
    id: CREEP_MBID,
    title: 'Creep',
    credits: [],
    artists: ['Radiohead'],
    lengthMs: 236666,
    isrcs: ['GBAYE9200070', 'GBAYE9200071'],
    video: false,
  }

  it('takes any object with those methods, e.g. a fake in a test', async () => {
    const fake: Pick<MusicBrainzLookups, 'lookupUrl' | 'getRecording'> = {
      lookupUrl: async () => [{ id: CREEP_MBID, title: 'Creep', video: false }],
      getRecording: async () => recording,
    }
    const service = fakeService(() => json(notFound, { status: 404 }))
    const finding = await findExactIsrc(fake, CREEP_ID, contextFor(service.fetch))
    // Two ISRCs: nothing says which one Spotify uses, so there is no single one to feed.
    expect(finding).toEqual({ origin: 'musicbrainz-exact', isrcs: recording.isrcs, recording })
    expect(service.calls).toHaveLength(0)
  })

  it('takes the matching engine’s source track, whose artists are read-only', async () => {
    const service = musicBrainz()
    const source = {
      title: 'Creep',
      artists: [{ name: 'Radiohead' }] as const,
      durationMs: 238_640,
    }
    const finding = await findIsrcHint(client(), source, contextFor(service.fetch))
    expect(finding?.origin).toBe('musicbrainz-fuzzy')
  })
})

describe('findIsrcHint', () => {
  it('prefers the recording on the most releases over MusicBrainz’s first hit', async () => {
    const service = musicBrainz()
    const finding = await findIsrcHint(client(), creep(), contextFor(service.fetch))
    expect(finding).toMatchObject({
      origin: 'musicbrainz-fuzzy',
      isrc: 'GBAYE9200070',
      isrcs: ['GBAYE9200070'],
      recording: { id: CREEP_MBID, lengthMs: 236666 },
    })
    expect(finding?.recording).not.toHaveProperty('releases')
    expect(service.calls[0]?.url.searchParams.get('query')).toBe(
      'recording:"Creep" AND artist:"Radiohead" AND dur:[226708 TO 250572]',
    )
  })

  it('searches the title without its version qualifiers or presentation noise', async () => {
    const service = musicBrainz()
    const { durationMs: _durationMs, ...withoutDuration } = creep({
      title: 'Creep (Official Video) - 2009 Remaster',
    })
    await findIsrcHint(client(), withoutDuration, contextFor(service.fetch))
    expect(service.calls[0]?.url.searchParams.get('query')).toBe(
      'recording:"Creep" AND artist:"Radiohead"',
    )
  })

  it('keeps live recordings for a live track, and only those', async () => {
    const service = musicBrainz()
    const finding = await findIsrcHint(
      client(),
      creep({ title: 'Creep - Live', durationMs: 244_000 }),
      contextFor(service.fetch),
    )
    expect(finding?.recording.disambiguation).toMatch(/^live, 1993‐06‐30/u)
    expect(finding?.isrcs).toEqual([])
  })

  it('leaves out recordings whose length is outside the window', async () => {
    const service = musicBrainz()
    const finding = await findIsrcHint(
      client(),
      creep({ durationMs: 300_000 }),
      contextFor(service.fetch),
    )
    expect(finding).toBeNull()
  })

  it('finds nothing when the artist does not fit', async () => {
    const service = musicBrainz()
    const finding = await findIsrcHint(
      client(),
      creep({ artists: [{ name: 'TLC' }] }),
      contextFor(service.fetch),
    )
    expect(finding).toBeNull()
  })

  it('makes no request without a title or an artist', async () => {
    const service = musicBrainz()
    const ctx = contextFor(service.fetch)
    await expect(findIsrcHint(client(), creep({ artists: [] }), ctx)).resolves.toBeNull()
    await expect(findIsrcHint(client(), creep({ title: '  ' }), ctx)).resolves.toBeNull()
    expect(service.calls).toHaveLength(0)
  })
})
