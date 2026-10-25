import {
  type EntityId,
  FxmError,
  formatId,
  matchingEval,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { IsrcFinding } from '../musicbrainz'
import type { SpotifyTrackDetails } from '../spotify'
import {
  buildInputs,
  buildVariants,
  exactOf,
  INPUT_PLANS,
  type InputProviders,
  passesFilter,
  poolTrackOf,
  spotifyInput,
} from './inputs'
import { memoryStore, type PoolTrack } from './store'

const ctx: ProviderContext = {
  fetch: () => Promise.reject(new Error('no network in tests')),
  platform: 'desktop',
  capabilities: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
  mode: 'music',
}

function spotifyTrack(id: string, title: string, album = title): Track {
  return {
    id: formatId('spotify', 'track', id),
    source: 'spotify',
    title,
    artists: [{ name: 'Artist', id: formatId('spotify', 'artist', 'a') }],
    album: { name: album },
    durationMs: 200_000,
    explicit: false,
    releaseDate: '2020-01-01',
    artwork: [],
    kind: 'song',
  }
}

const POOL: PoolTrack = {
  id: '70LcF31zb1H0PyJoS1Sx1r',
  title: 'Creep',
  artists: ['Radiohead'],
  album: 'Pablo Honey',
  durationMs: 238_640,
  explicit: false,
  releaseDate: '1993-02-22',
}

const DETAILS: SpotifyTrackDetails = {
  isrc: 'GBAYE9200070',
  label: 'XL Recordings',
  releaseDate: '1993-02-22',
  albumType: 'album',
  popularity: 87,
}

const EXACT = {
  recording: 'mbid',
  title: 'Creep',
  artists: ['Radiohead'],
  lengthMs: 238_666,
  isrcs: ['GBAYE9200070'],
  firstReleaseDate: '1992-09-21',
}

describe('the inputs of a track', () => {
  it("are Spotify's metadata with metadata/4's facts", () => {
    expect(spotifyInput(POOL, DETAILS)).toEqual({
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      album: { name: 'Pablo Honey' },
      durationMs: 238_640,
      isrc: 'GBAYE9200070',
      isrcOrigin: 'catalog',
      explicit: false,
      releaseDate: '1993-02-22',
      label: 'XL Recordings',
      albumType: 'album',
    })
  })

  it('add a data-export row that MusicBrainz fills in, and both MusicBrainz inputs', () => {
    const primary = { slice: 'spotify' as const, source: spotifyInput(POOL, DETAILS) }
    const variants = buildVariants(primary, EXACT, 'GBAYE9200070')
    expect(variants.map((variant) => variant.slice)).toEqual([
      'spotify',
      'data-export',
      'musicbrainz-exact',
      'musicbrainz-fuzzy',
    ])
    expect(variants[1]?.source).toEqual({
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      album: { name: 'Pablo Honey' },
      isrc: 'GBAYE9200070',
      isrcOrigin: 'musicbrainz-exact',
      durationMs: 238_666,
    })
    expect(variants[2]?.source).toEqual({
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      durationMs: 238_666,
      isrc: 'GBAYE9200070',
      isrcOrigin: 'musicbrainz-exact',
      releaseDate: '1992-09-21',
    })
    expect(variants[3]?.source).toMatchObject({
      isrc: 'GBAYE9200070',
      isrcOrigin: 'musicbrainz-fuzzy',
      durationMs: 238_640,
    })
  })

  it('leave a data-export row without duration or ISRC when MusicBrainz has no recording', () => {
    const primary = { slice: 'spotify' as const, source: spotifyInput(POOL, DETAILS) }
    const variants = buildVariants(primary, null, undefined)
    expect(variants.map((variant) => variant.slice)).toEqual(['spotify', 'data-export'])
    expect(variants[1]?.source).toEqual({
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      album: { name: 'Pablo Honey' },
    })
    const several = buildVariants(primary, { ...EXACT, isrcs: ['A', 'B'] }, undefined)
    expect(several[1]?.source.isrcOrigin).toBe('musicbrainz-exact-several')
  })

  it("keep what MusicBrainz's exact path found", () => {
    const finding = {
      origin: 'musicbrainz-exact',
      isrc: 'GBAYE9200070',
      isrcs: ['GBAYE9200070'],
      recording: {
        id: 'mbid',
        title: 'Creep',
        lengthMs: 238_666,
        video: false,
        credits: [],
        artists: ['Radiohead'],
        isrcs: ['GBAYE9200070'],
        firstReleaseDate: '1992-09-21',
      },
    } as IsrcFinding
    expect(exactOf(finding)).toEqual(EXACT)
    expect(exactOf(undefined)).toBeNull()
  })

  it('come from Spotify tracks only, filtered by what a source is for', () => {
    expect(poolTrackOf(spotifyTrack('x', 'Song'))).toMatchObject({ id: 'x', title: 'Song' })
    expect(
      poolTrackOf({
        ...spotifyTrack('x', 'Song'),
        id: formatId('ytm', 'track', 'x'),
        source: 'ytm',
      }),
    ).toBeUndefined()
    const track = (title: string, album = title) => ({ id: 'x', title, artists: ['A'], album })
    expect(passesFilter(track('Challa - Spotify Singles'), 'spotify-singles')).toBe(true)
    expect(passesFilter(track('Challa'), 'spotify-singles')).toBe(false)
    expect(passesFilter(track("Love Story (Taylor's Version)"), 're-recording')).toBe(true)
    expect(passesFilter(track('Song', 'Greatest Hits'), 'compilation')).toBe(true)
    expect(
      passesFilter(track('Symphony No. 5 in C Minor, Op. 67: I. Allegro con brio'), 'classical'),
    ).toBe(true)
    expect(passesFilter(track('Song'), undefined)).toBe(true)
  })

  it('come from plans that hold enough groups for the gate', () => {
    const total = INPUT_PLANS.full.reduce((sum, source) => sum + source.take, 0)
    expect(total * 0.7).toBeGreaterThan(220)
    expect(INPUT_PLANS.proof.reduce((sum, source) => sum + source.take, 0)).toBeLessThanOrEqual(20)
    expect(new Set(INPUT_PLANS.full.map((source) => source.key)).size).toBe(INPUT_PLANS.full.length)
  })
})

/** Fake Spotify and MusicBrainz, counting their calls. */
function fakeProviders(calls: string[], failDetailsFor: string[] = []): InputProviders {
  const playlistTracks = [
    spotifyTrack('aaaaaaaaaaaaaaaaaaaaa1', 'One'),
    spotifyTrack('aaaaaaaaaaaaaaaaaaaaa2', 'Two'),
  ]
  return {
    spotify: {
      async getPlaylist(id: EntityId<'playlist'>) {
        calls.push(`playlist ${id}`)
        return {
          id,
          source: 'spotify',
          name: 'Chart',
          artwork: [],
          tracks: { items: playlistTracks },
        }
      },
      async getPlaylistTracks() {
        calls.push('playlist page')
        return { items: [] }
      },
      async search(query) {
        calls.push(`search ${query}`)
        return {
          tracks: {
            items: [
              spotifyTrack('aaaaaaaaaaaaaaaaaaaaa2', 'Two'),
              spotifyTrack('bbbbbbbbbbbbbbbbbbbbb1', 'Hit - Spotify Singles'),
              spotifyTrack('bbbbbbbbbbbbbbbbbbbbb2', 'Plain'),
            ],
          },
        }
      },
      async getTrackDetails(id: EntityId<'track'>) {
        calls.push(`details ${id}`)
        if (failDetailsFor.includes(id)) throw new FxmError('NotFound', 'gone')
        return {
          isrc: `ISRC${id.slice(-6)}`,
          label: 'Label',
          releaseDate: '2020-01-01',
          albumType: 'single',
          popularity: 70,
        }
      },
    },
    async findExactIsrcs(references) {
      calls.push(`exact ${references.length}`)
      return new Map(
        references
          .filter((reference) => reference.endsWith('1'))
          .map((reference) => [
            reference,
            {
              origin: 'musicbrainz-exact',
              isrc: 'MBISRC000001',
              isrcs: ['MBISRC000001'],
              recording: {
                id: 'mbid',
                title: 'MB title',
                video: false,
                credits: [],
                artists: ['Artist'],
                isrcs: ['MBISRC000001'],
                lengthMs: 201_000,
              },
            } as IsrcFinding,
          ]),
      )
    },
    async findIsrcHint(track) {
      calls.push(`fuzzy ${track.title}`)
      return null
    },
  }
}

describe('buildInputs', () => {
  const plan = [
    { key: 'playlist:chart', kind: 'playlist', ref: 'chart', name: 'Chart', take: 2 },
    {
      key: 'search:Spotify Singles',
      kind: 'search',
      ref: 'Spotify Singles',
      name: 'Search',
      take: 1,
      filter: 'spotify-singles',
    },
  ] as const

  it('creates one group per track, with its inputs, and resumes without asking twice', async () => {
    const original = INPUT_PLANS.proof
    Object.assign(INPUT_PLANS, { proof: plan })
    try {
      const store = memoryStore()
      const calls: string[] = []
      const summary = await buildInputs({
        providers: fakeProviders(calls),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-26',
      })
      expect(summary.created).toEqual([
        'sp:aaaaaaaaaaaaaaaaaaaaa1',
        'sp:aaaaaaaaaaaaaaaaaaaaa2',
        'sp:bbbbbbbbbbbbbbbbbbbbb1',
      ])
      expect(calls.filter((call) => call.startsWith('exact'))).toEqual(['exact 3'])
      const one = await store.readGroup('sp:aaaaaaaaaaaaaaaaaaaaa1')
      expect(one).toMatchObject({
        categories: ['mainstream'],
        provenance: ['Chart #1 (playlist:chart), read 2026-10-26'],
        spotify: { id: 'aaaaaaaaaaaaaaaaaaaaa1', popularity: 70, albumType: 'single' },
        musicBrainz: { exact: { recording: 'mbid', isrcs: ['MBISRC000001'] }, fuzzy: null },
      })
      expect(one?.variants.map((variant) => variant.slice)).toEqual([
        'spotify',
        'data-export',
        'musicbrainz-exact',
      ])
      const singles = await store.readGroup('sp:bbbbbbbbbbbbbbbbbbbbb1')
      expect(singles?.categories).toEqual(['spotify-singles'])
      expect(store.checkpoint.inputs.pools['playlist:chart']).toHaveLength(2)

      const again: string[] = []
      const second = await buildInputs({
        providers: fakeProviders(again),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-27',
      })
      expect(second.created).toEqual([])
      expect(again).toEqual([])
    } finally {
      Object.assign(INPUT_PLANS, { proof: original })
    }
  })

  it('stops at the limit, records failed tracks, and adds the fixed inputs to the full plan', async () => {
    const original = INPUT_PLANS.full
    Object.assign(INPUT_PLANS, { full: plan })
    try {
      const store = memoryStore()
      const calls: string[] = []
      const summary = await buildInputs({
        providers: fakeProviders(calls, ['spotify:track:aaaaaaaaaaaaaaaaaaaaa1']),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'full',
        limit: 3,
        today: '2026-10-26',
      })
      expect(summary.created).toEqual([
        'fx:squatter-gbaye0601696',
        'fx:squatter-qmfmf2447070',
        'sp:aaaaaaaaaaaaaaaaaaaaa2',
      ])
      expect(summary.failed).toEqual({ 'sp:aaaaaaaaaaaaaaaaaaaaa1': 'FxmError: gone' })
      const squatter = await store.readGroup('fx:squatter-gbaye0601696')
      expect(squatter?.variants).toEqual([
        { slice: 'fixed', source: expect.objectContaining({ isrc: 'GBAYE0601696' }) },
      ])
      expect(matchingEval.splitOf(squatter?.id ?? '')).toBe(squatter?.split)
    } finally {
      Object.assign(INPUT_PLANS, { full: original })
    }
  })
})
