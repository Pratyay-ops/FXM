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
  FIXED_INPUTS,
  INPUT_PLANS,
  type InputProviders,
  type InputSource,
  MIN_PLANNED_HELD_OUT,
  passesFilter,
  poolTrackOf,
  projectedSplits,
  provenanceLine,
  sourceKeyOf,
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

  it('name only the main artist in the data-export row, as the export does', () => {
    const duet = spotifyInput({ ...POOL, artists: ['Gurdas Maan', 'Diljit Dosanjh', 'Ikky'] }, {})
    const variants = buildVariants({ slice: 'spotify', source: duet }, null, 'INW262300319')
    expect(variants[1]?.source.artists).toEqual([{ name: 'Gurdas Maan' }])
    expect(variants[2]?.source.artists).toEqual(duet.artists)
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

  it('come from plans that hold enough distinct tracks for the gate, with room to spare', () => {
    // Each source takes tracks no earlier source took, so the takes add up to distinct tracks.
    const total = INPUT_PLANS.full.reduce((sum, source) => sum + source.take, 0)
    expect(total + FIXED_INPUTS.length).toBeGreaterThanOrEqual(360)
    // About 70 % are held out; the margin covers the split's spread (about ±9) and a few
    // sources that cannot be read or groups that fail to record.
    expect((total + FIXED_INPUTS.length) * 0.7).toBeGreaterThan(MIN_PLANNED_HELD_OUT + 35)
    expect(MIN_PLANNED_HELD_OUT).toBeGreaterThan(matchingEval.EVAL_GATE.minHeldOutGroups)
    expect(INPUT_PLANS.proof.reduce((sum, source) => sum + source.take, 0)).toBeLessThanOrEqual(20)
    expect(new Set(INPUT_PLANS.full.map((source) => source.key)).size).toBe(INPUT_PLANS.full.length)
  })

  it('name their source in the provenance, which says who created each group', () => {
    const [global] = INPUT_PLANS.full
    if (global === undefined) throw new Error('no source')
    const line = provenanceLine(global, 4, '2026-10-25')
    expect(line).toBe('Top 50 - Global #5 (playlist:37i9dQZEVXbMDoHDwVN2tF), read 2026-10-25')
    expect(sourceKeyOf(line)).toBe(global.key)
    expect(
      sourceKeyOf(
        'Spotify search "Taylor\'s Version" #1 (search:Taylor\'s Version), read 2026-10-25',
      ),
    ).toBe("search:Taylor's Version")
    expect(
      sourceKeyOf('research 2026-10-25: Deezer maps GBAYE0601696 to this track'),
    ).toBeUndefined()
  })

  it('project the split of a set from its IDs', () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `sp:${index}`)
    const { heldOut, calibration } = projectedSplits(ids)
    expect(heldOut + calibration).toBe(1000)
    expect(calibration).toBe(ids.filter((id) => matchingEval.splitOf(id) === 'calibration').length)
  })
})

/** Fake Spotify and MusicBrainz, counting their calls. */
function fakeProviders(
  calls: string[],
  options: {
    failDetails?: Record<string, FxmError>
    playlists?: Record<string, Track[]>
    fuzzy?: (title: string) => Promise<IsrcFinding | null>
  } = {},
): InputProviders {
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
          tracks: { items: options.playlists?.[id] ?? playlistTracks },
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
        const failure = options.failDetails?.[id]
        if (failure !== undefined) throw failure
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
      return options.fuzzy === undefined ? null : options.fuzzy(track.title)
    },
  }
}

/** Runs `body` with `plan` as the plan named `name`. */
async function withPlan<T>(
  name: keyof typeof INPUT_PLANS,
  plan: readonly InputSource[],
  body: () => Promise<T>,
): Promise<T> {
  const original = INPUT_PLANS[name]
  Object.assign(INPUT_PLANS, { [name]: plan })
  try {
    return await body()
  } finally {
    Object.assign(INPUT_PLANS, { [name]: original })
  }
}

const CHART: InputSource = {
  key: 'playlist:chart',
  kind: 'playlist',
  ref: 'chart',
  name: 'Chart',
  take: 2,
}

const SINGLES: InputSource = {
  key: 'search:Spotify Singles',
  kind: 'search',
  ref: 'Spotify Singles',
  name: 'Search',
  take: 1,
  filter: 'spotify-singles',
}

describe('buildInputs', () => {
  it('creates one group per track, with its inputs, and resumes without asking twice', async () => {
    await withPlan('proof', [CHART, SINGLES], async () => {
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
      expect(summary.heldOut + summary.calibration).toBe(3)
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
      expect(store.checkpoint.inputs.readAt['playlist:chart']).toBe('2026-10-26')

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
      expect(second.completed).toEqual([])
      expect(again).toEqual([])
    })
  })

  it("counts toward a source's take only the groups it created", async () => {
    // The search gives a track the chart took first, and still takes one Spotify Single.
    const overlap: InputSource = {
      key: 'search:Spotify Singles',
      kind: 'search',
      ref: 'Spotify Singles',
      name: 'Search',
      take: 2,
    }
    await withPlan('proof', [CHART, overlap], async () => {
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
        'sp:bbbbbbbbbbbbbbbbbbbbb2',
      ])
      const two = await store.readGroup('sp:aaaaaaaaaaaaaaaaaaaaa2')
      expect(two?.provenance).toEqual(['Chart #2 (playlist:chart), read 2026-10-26'])
      // Resuming counts the same: nothing more to take.
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
      expect(again.filter((call) => call.startsWith('details'))).toEqual([])
    })
  })

  it('reports a source that gives fewer tracks than it should', async () => {
    await withPlan('proof', [{ ...CHART, take: 5 }], async () => {
      const store = memoryStore()
      const summary = await buildInputs({
        providers: fakeProviders([]),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-26',
      })
      expect(summary.short).toEqual({ 'playlist:chart': 2 })
    })
  })

  it('stops at the limit, records failed tracks, and adds the fixed inputs to the full plan', async () => {
    await withPlan('full', [CHART, SINGLES], async () => {
      const store = memoryStore()
      const calls: string[] = []
      const summary = await buildInputs({
        providers: fakeProviders(calls, {
          failDetails: { 'spotify:track:aaaaaaaaaaaaaaaaaaaaa1': new FxmError('NotFound', 'gone') },
        }),
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
      // The chart has no third track to make up for the one Spotify lost; the search, which the
      // limit kept from being read, is not short.
      expect(summary.short).toEqual({ 'playlist:chart': 1 })
      expect(store.checkpoint.inputs.failed).toEqual({
        'sp:aaaaaaaaaaaaaaaaaaaaa1': 'FxmError: gone',
      })
      const squatter = await store.readGroup('fx:squatter-gbaye0601696')
      expect(squatter?.variants).toEqual([
        { slice: 'fixed', source: expect.objectContaining({ isrc: 'GBAYE0601696' }) },
      ])
      expect(matchingEval.splitOf(squatter?.id ?? '')).toBe(squatter?.split)
    })
  })

  it('tries a track again on the next run unless Spotify does not know it', async () => {
    await withPlan('proof', [CHART], async () => {
      const store = memoryStore()
      const network = new FxmError('Network', 'offline')
      const first = await buildInputs({
        providers: fakeProviders([], {
          failDetails: { 'spotify:track:aaaaaaaaaaaaaaaaaaaaa1': network },
        }),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-26',
      })
      expect(first.created).toEqual(['sp:aaaaaaaaaaaaaaaaaaaaa2'])
      expect(first.failed).toEqual({ 'sp:aaaaaaaaaaaaaaaaaaaaa1': 'FxmError: offline' })
      expect(store.checkpoint.inputs.failed).toEqual({})
      const second = await buildInputs({
        providers: fakeProviders([]),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-27',
      })
      expect(second.created).toEqual(['sp:aaaaaaaaaaaaaaaaaaaaa1'])
    })
  })

  it('stops reading Spotify at its rate limit, and the next run resumes', async () => {
    await withPlan('proof', [CHART, SINGLES], async () => {
      const store = memoryStore()
      const calls: string[] = []
      const limited = new FxmError('RateLimited', 'slow down', { retryAfterMs: 60_000 })
      const summary = await buildInputs({
        providers: fakeProviders(calls, {
          failDetails: { 'spotify:track:aaaaaaaaaaaaaaaaaaaaa1': limited },
        }),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-26',
      })
      expect(summary.stopped).toMatch(/rate-limited/u)
      expect(summary.created).toEqual([])
      // No request after the rate limit: the search was never read.
      expect(
        calls.filter((call) => call.startsWith('search') || call.startsWith('details')),
      ).toEqual(['details spotify:track:aaaaaaaaaaaaaaaaaaaaa1'])
      expect(store.checkpoint.inputs.failed).toEqual({})
      const second = await buildInputs({
        providers: fakeProviders([]),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-27',
      })
      expect(second.created).toEqual([
        'sp:aaaaaaaaaaaaaaaaaaaaa1',
        'sp:aaaaaaaaaaaaaaaaaaaaa2',
        'sp:bbbbbbbbbbbbbbbbbbbbb1',
      ])
    })
  })

  it("leaves MusicBrainz's fuzzy path alone after three failures in a row", async () => {
    await withPlan(
      'proof',
      [
        { ...CHART, take: 2 },
        { ...SINGLES, take: 2 },
      ],
      async () => {
        const store = memoryStore()
        const calls: string[] = []
        const summary = await buildInputs({
          providers: fakeProviders(calls, {
            fuzzy: () => Promise.reject(new FxmError('Network', 'MusicBrainz is down')),
          }),
          spotifyCtx: ctx,
          musicBrainzCtx: ctx,
          store,
          plan: 'proof',
          today: '2026-10-26',
        })
        expect(calls.filter((call) => call.startsWith('fuzzy'))).toHaveLength(3)
        expect(summary.stopped).toMatch(/fuzzy path failed 3 times/u)
        const group = await store.readGroup('sp:aaaaaaaaaaaaaaaaaaaaa1')
        expect(group?.musicBrainz?.fuzzy).toBeUndefined()
        expect(group?.variants).toHaveLength(1)
      },
    )
  })

  it('builds the inputs again when the rules that make them changed', async () => {
    await withPlan('proof', [CHART], async () => {
      const store = memoryStore()
      await buildInputs({
        providers: fakeProviders([]),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-26',
      })
      // An older recorder wrote the data-export row with every credited artist.
      const group = await store.readGroup('sp:aaaaaaaaaaaaaaaaaaaaa1')
      const row = group?.variants[1]
      if (group === undefined || row === undefined) throw new Error('no group')
      row.source = { ...row.source, artists: [{ name: 'Artist' }, { name: 'Guest' }] }
      await store.writeGroup(group)
      const calls: string[] = []
      const summary = await buildInputs({
        providers: fakeProviders(calls),
        spotifyCtx: ctx,
        musicBrainzCtx: ctx,
        store,
        plan: 'proof',
        today: '2026-10-27',
      })
      expect(calls).toEqual([])
      expect(summary.completed).toEqual(['sp:aaaaaaaaaaaaaaaaaaaaa1'])
      const rebuilt = await store.readGroup('sp:aaaaaaaaaaaaaaaaaaaaa1')
      expect(rebuilt?.variants[1]?.source.artists).toEqual([{ name: 'Artist' }])
    })
  })
})
