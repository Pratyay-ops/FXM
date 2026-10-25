import {
  type EntityId,
  FxmError,
  formatId,
  isFxmError,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { isSpotifyError, type SpotifyErrorReason } from './errors'
import {
  CREEP_ID,
  capabilities,
  contextFor,
  type FakeClock,
  type FakeSpotifyOptions,
  fakeClock,
  fakeSpotify,
  fixtures,
  json,
  PABLO_HONEY_ID,
  RADIOHEAD_ID,
  SECRET_URL,
} from './fixtures/testing'
import { hexToBase62 } from './ids'
import { createSpotifyProvider, type SpotifyProviderOptions } from './provider'
import type { SessionTokenSource } from './token'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const creep = CREEP_ID as EntityId<'track'>
const pabloHoney = PABLO_HONEY_ID as EntityId<'album'>
const radiohead = RADIOHEAD_ID as EntityId<'artist'>
const creepRadio = 'spotify:playlist:37i9dQZF1E8OvD4G5pVGhr' as EntityId<'playlist'>

interface Setup {
  spotify?: FakeSpotifyOptions
  provider?: SpotifyProviderOptions
  ctx?: Partial<ProviderContext>
}

function setup(options: Setup = {}) {
  const clock = options.spotify?.clock ?? fakeClock()
  const spotify = fakeSpotify({ ...options.spotify, clock })
  const onHealthChange = vi.fn()
  const provider = createSpotifyProvider({
    secretSources: [{ url: SECRET_URL }],
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    random: () => 0,
    timeZone: () => 'Asia/Kolkata',
    onHealthChange,
    ...options.provider,
  })
  return { clock, spotify, provider, onHealthChange, ctx: contextFor(spotify.fetch, options.ctx) }
}

/** A session source for a logged-in user, recording its calls. */
function loggedIn(clock: FakeClock, token = 'account-token') {
  const requestToken = vi.fn<SessionTokenSource['requestToken']>(async () => ({
    status: 200,
    json: {
      accessToken: token,
      accessTokenExpirationTimestampMs: clock.now() + HOUR,
      isAnonymous: false,
    },
  }))
  return { requestToken }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a failure')
    },
    (error: unknown) => error as Error,
  )
}

function expectReason(error: unknown, reason: SpotifyErrorReason): void {
  expect(isSpotifyError(error, reason), `expected ${reason}, got ${String(error)}`).toBe(true)
}

/** A track from YouTube Music, for radio seeds. */
function youtubeTrack(fields: Partial<Track> = {}): Track {
  return {
    id: formatId('ytm', 'track', 'abcdefghijk'),
    source: 'ytm',
    title: 'Creep',
    artists: [{ name: 'Radiohead' }],
    artwork: [],
    kind: 'song',
    ...fields,
  }
}

describe('gating', () => {
  it('refuses every call when the platform cannot reach Spotify, without a request', async () => {
    const { provider, spotify } = setup({ ctx: { capabilities: capabilities('unreachable') } })
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('unreachable') })
    const calls: Array<Promise<unknown>> = [
      provider.search('creep', { types: ['track'] }, ctx),
      provider.getTrack(creep, ctx),
      provider.getAlbum(pabloHoney, ctx),
      provider.getArtist(radiohead, ctx),
      provider.getRelatedArtists(radiohead, ctx),
      provider.getPlaylist(creepRadio, ctx),
      provider.getPlaylistTracks(creepRadio, {}, ctx),
      provider.radio(youtubeTrack(), ctx),
      provider.home(ctx),
      provider.getHomeSection('spotify:section:abc', {}, ctx),
      provider.getTrackDetails(creep, ctx),
      provider.getLibraryTracks({}, ctx),
      provider.getLibraryPlaylists({}, ctx),
    ]
    for (const call of calls) {
      const error = await failure(call)
      expectReason(error, 'unreachable')
      expect(isFxmError(error, 'Unsupported')).toBe(true)
    }
    expect(spotify.calls).toHaveLength(0)
    expect(await provider.status(ctx)).toEqual({ connected: false })
  })

  it('refuses every call while the user switched Spotify off, and resumes when on', async () => {
    let enabled = false
    const { provider, spotify, ctx } = setup({ provider: { isEnabled: () => enabled } })
    expectReason(await failure(provider.getTrack(creep, ctx)), 'disabled')
    expectReason(await failure(provider.home(ctx)), 'disabled')
    expect(await provider.status(ctx)).toEqual({ connected: false })
    expect(spotify.calls).toHaveLength(0)
    enabled = true
    expect((await provider.getTrack(creep, ctx)).title).toBe('Creep')
  })

  it('refuses IDs of other sources', async () => {
    const { provider, ctx } = setup()
    const error = await failure(
      provider.getTrack('ytm:track:abcdefghijk' as EntityId<'track'>, ctx),
    )
    expectReason(error, 'foreign-id')
  })
})

describe('search', () => {
  it('answers several types with one searchDesktop call', async () => {
    const { provider, spotify, ctx } = setup()
    const results = await provider.search(
      '  radiohead creep ',
      { types: ['track', 'album', 'artist', 'playlist'] },
      ctx,
    )
    const calls = spotify.callsOf('graphql')
    expect(calls.map((c) => c.operationName)).toEqual(['searchDesktop'])
    expect(calls[0]?.variables).toMatchObject({
      searchTerm: 'radiohead creep',
      offset: 0,
      limit: 20,
      numberOfTopResults: 5,
      sectionFilters: ['GENERIC'],
      includeAudiobooks: false,
    })
    expect(results.tracks?.items.map((t) => t.title)).toEqual(['Creep', 'Creep - Acoustic'])
    expect(results.albums?.items).toHaveLength(2)
    expect(results.artists?.items[0]?.name).toBe('Radiohead')
    expect(results.playlists?.items).toHaveLength(2)
    expect(results).not.toHaveProperty('videos')
  })

  it('uses the typed search for one type, and for later pages', async () => {
    const { provider, spotify, ctx } = setup()
    const first = await provider.search('radiohead creep', { types: ['track'], limit: 3 }, ctx)
    expect(first.tracks).toMatchObject({ nextCursor: '3', total: 4 })
    await provider.search('radiohead', { types: ['album', 'artist'], cursor: '3', limit: 3 }, ctx)
    const calls = spotify.callsOf('graphql')
    expect(calls.map((c) => c.operationName)).toEqual([
      'searchTracks',
      'searchAlbums',
      'searchArtists',
    ])
    expect(calls[0]?.variables).toMatchObject({
      searchTerm: 'radiohead creep',
      offset: 0,
      limit: 3,
    })
    expect(calls[1]?.variables).toMatchObject({ offset: 3, limit: 3 })
  })

  it('has no videos: an empty page in Music + Video mode, and no request for it', async () => {
    const { provider, spotify, ctx } = setup()
    const results = await provider.search('creep', { types: ['video'] }, { ...ctx, mode: 'all' })
    expect(results).toEqual({ videos: { items: [] } })
    expect(spotify.calls).toHaveLength(0)
  })

  it('answers an empty query with empty pages and no request', async () => {
    const { provider, spotify, ctx } = setup()
    expect(await provider.search('   ', { types: ['track', 'artist'] }, ctx)).toEqual({
      tracks: { items: [] },
      artists: { items: [] },
    })
    expect(spotify.calls).toHaveLength(0)
  })

  it('caps the page size, and refuses cursors it did not make', async () => {
    const { provider, spotify, ctx } = setup()
    await provider.search('creep', { types: ['track'], limit: 500 }, ctx)
    expect(spotify.callsOf('graphql')[0]?.variables).toMatchObject({ limit: 50 })
    await expect(
      provider.search('creep', { types: ['track'], cursor: 'abc' }, ctx),
    ).rejects.toThrow(RangeError)
  })

  it('sends a browser User-Agent from native apps', async () => {
    const { provider, spotify } = setup()
    await provider.search(
      'creep',
      { types: ['track'] },
      contextFor(spotify.fetch, { platform: 'desktop' }),
    )
    expect(spotify.callsOf('graphql')[0]?.headers.get('user-agent')).toMatch(/Chrome\//u)
  })
})

describe('entities', () => {
  it('loads a track', async () => {
    const { provider, spotify, ctx } = setup()
    const track = await provider.getTrack(creep, ctx)
    expect(track).toMatchObject({ id: CREEP_ID, title: 'Creep', kind: 'song' })
    expect(spotify.callsOf('graphql', 'getTrack')[0]?.variables).toEqual({ uri: CREEP_ID })
  })

  it('reports a track that does not exist as NotFound', async () => {
    const { provider, ctx } = setup({
      spotify: { graphql: { getTrack: () => json(fixtures.errorNotFound) } },
    })
    const error = await failure(provider.getTrack(creep, ctx))
    expectReason(error, 'not-found')
    expect(error).toMatchObject({ code: 'NotFound' })
  })

  it('reports other error typenames as unavailable', async () => {
    const { provider, ctx } = setup({
      spotify: {
        graphql: {
          getTrack: () =>
            json({ data: { trackUnion: { __typename: 'GenericError', message: 'x' } } }),
        },
      },
    })
    expectReason(await failure(provider.getTrack(creep, ctx)), 'graphql')
  })

  it('loads an album with all its tracks, page by page', async () => {
    const total = 120
    const albumPage = (offset: number) => ({
      data: {
        albumUnion: {
          __typename: 'Album',
          uri: PABLO_HONEY_ID,
          name: 'Long album',
          tracksV2: {
            totalCount: total,
            items: Array.from({ length: Math.min(50, total - offset) }, (_, i) => {
              const n = offset + i + 1
              const id = hexToBase62(n.toString(16).padStart(32, '0'))
              return { track: { uri: `spotify:track:${id}`, name: `Track ${n}`, trackNumber: n } }
            }),
          },
        },
      },
    })
    const { provider, spotify, ctx } = setup({
      spotify: { graphql: { getAlbum: (variables) => json(albumPage(Number(variables.offset))) } },
    })
    const album = await provider.getAlbum(pabloHoney, ctx)
    expect(album.tracks).toHaveLength(total)
    expect(album.tracks?.[119]?.title).toBe('Track 120')
    expect(spotify.callsOf('graphql', 'getAlbum').map((c) => c.variables?.offset)).toEqual([
      0, 50, 100,
    ])
    expect(spotify.callsOf('graphql', 'getAlbum')[0]?.variables).toEqual({
      uri: PABLO_HONEY_ID,
      locale: '',
      offset: 0,
      limit: 50,
    })
  })

  it('loads an album of one page with one call', async () => {
    const { provider, spotify, ctx } = setup()
    const album = await provider.getAlbum(pabloHoney, ctx)
    expect(album.tracks?.map((t) => t.title)).toEqual(['You', 'Creep', 'How Do You?'])
    expect(spotify.callsOf('graphql', 'getAlbum')).toHaveLength(1)
  })

  it('loads an artist and its related artists', async () => {
    const { provider, spotify, ctx } = setup()
    const artist = await provider.getArtist(radiohead, ctx)
    expect(artist.topTracks).toHaveLength(3)
    expect(spotify.callsOf('graphql', 'queryArtistOverview')[0]?.variables).toEqual({
      uri: RADIOHEAD_ID,
      locale: '',
      preReleaseV2: false,
    })
    const related = await provider.getRelatedArtists(radiohead, ctx)
    expect(related.map((a) => a.name)).toEqual(['The Smiths', 'Nirvana', 'Jeff Buckley'])
    expect(spotify.callsOf('graphql', 'queryArtistRelated')[0]?.variables).toEqual({
      uri: RADIOHEAD_ID,
    })
  })

  it('reports related artists of an unknown artist as NotFound', async () => {
    const { provider, ctx } = setup({
      spotify: {
        graphql: {
          queryArtistRelated: () =>
            json({ data: { artistUnion: { __typename: 'NotFound', message: 'no' } } }),
        },
      },
    })
    expectReason(await failure(provider.getRelatedArtists(radiohead, ctx)), 'not-found')
  })

  it('loads a playlist with its first page, and further pages', async () => {
    const { provider, spotify, ctx } = setup()
    const playlist = await provider.getPlaylist(creepRadio, ctx)
    expect(playlist).toMatchObject({ name: 'Creep Radio', trackCount: 50 })
    expect(playlist.tracks?.items).toHaveLength(3)
    expect(spotify.callsOf('graphql', 'fetchPlaylist')[0]?.variables).toEqual({
      uri: creepRadio,
      offset: 0,
      limit: 50,
      enableWatchFeedEntrypoint: false,
      includeEpisodeContentRatingsV2: false,
    })
    const page = await provider.getPlaylistTracks(creepRadio, { cursor: '25', limit: 25 }, ctx)
    expect(spotify.callsOf('graphql', 'fetchPlaylist')[1]?.variables).toMatchObject({
      offset: 25,
      limit: 25,
    })
    expect(page.items).toHaveLength(3)
    expect(page).not.toHaveProperty('nextCursor')
  })
})

describe('radio', () => {
  it("plays Spotify's radio playlist for a track, without the seed", async () => {
    const { provider, spotify, ctx } = setup()
    const seed = await provider.getTrack(creep, ctx)
    const tracks = await provider.radio(seed, ctx)
    expect(tracks.map((t) => t.title)).toEqual([
      'Wonderwall - Remastered',
      'Come As You Are - Remastered',
    ])
    expect(spotify.callsOf('spclient')[0]?.url.pathname).toBe(
      `/inspiredby-mix/v2/seed_to_playlist/${CREEP_ID}`,
    )
    expect(spotify.callsOf('spclient')[0]?.url.searchParams.get('response-format')).toBe('json')
    expect(spotify.callsOf('graphql', 'fetchPlaylist')[0]?.variables).toMatchObject({
      uri: creepRadio,
      offset: 0,
      limit: 50,
    })
  })

  it('plays artist radio', async () => {
    const { provider, spotify, ctx } = setup()
    await provider.radio({ id: radiohead, name: 'Radiohead' }, ctx)
    expect(spotify.callsOf('spclient')[0]?.url.pathname).toBe(
      `/inspiredby-mix/v2/seed_to_playlist/${RADIOHEAD_ID}`,
    )
    expect(spotify.callsOf('graphql', 'fetchPlaylist')[0]?.variables?.uri).toBe(
      'spotify:playlist:37i9dQZF1E4EgTnU7Hvt0A',
    )
  })

  it('uses the Spotify ID a seed from another source carries', async () => {
    const { provider, spotify, ctx } = setup()
    await provider.radio(youtubeTrack({ externalIds: { spotify: '70LcF31zb1H0PyJoS1Sx1r' } }), ctx)
    expect(spotify.callsOf('graphql', 'searchTracks')).toHaveLength(0)
    expect(spotify.callsOf('spclient')[0]?.url.pathname).toContain(CREEP_ID)
  })

  it('looks a foreign seed up by title and artist, ignoring video noise', async () => {
    const { provider, spotify, ctx } = setup()
    const video = youtubeTrack({
      title: 'Radiohead - Creep (Official Music Video)',
      kind: 'music-video',
    })
    const tracks = await provider.radio(video, ctx)
    expect(spotify.callsOf('graphql', 'searchTracks')[0]?.variables).toMatchObject({
      searchTerm: 'Radiohead Creep',
      limit: 5,
    })
    expect(tracks).toHaveLength(2)
  })

  it('looks an artist seed up by name', async () => {
    const { provider, spotify, ctx } = setup()
    await provider.radio({ name: 'radiohead' }, ctx)
    expect(spotify.callsOf('graphql', 'searchArtists')).toHaveLength(1)
    expect(spotify.callsOf('spclient')[0]?.url.pathname).toContain(RADIOHEAD_ID)
  })

  it('refuses seeds it cannot map', async () => {
    const { provider, spotify, ctx } = setup()
    expectReason(
      await failure(provider.radio(youtubeTrack({ title: 'Some Other Song' }), ctx)),
      'unsupported-seed',
    )
    expectReason(await failure(provider.radio({ name: 'Nobody At All' }, ctx)), 'unsupported-seed')
    expectReason(
      await failure(provider.radio(youtubeTrack({ artists: [] }), ctx)),
      'unsupported-seed',
    )
    const strict = setup({ provider: { lookupForeignSeeds: false } })
    expectReason(
      await failure(strict.provider.radio(youtubeTrack(), strict.ctx)),
      'unsupported-seed',
    )
    expect(strict.spotify.calls).toHaveLength(0)
    expect(spotify.callsOf('spclient')).toHaveLength(0)
  })

  it('reports a seed without radio as NotFound', async () => {
    const { provider, ctx } = setup({
      spotify: { spclient: () => json({ total: 0, mediaItems: [] }) },
    })
    expectReason(
      await failure(provider.radio({ id: radiohead, name: 'Radiohead' }, ctx)),
      'not-found',
    )
  })
})

describe('home', () => {
  it('loads the generic home feed anonymously', async () => {
    const { provider, spotify, ctx } = setup()
    const shelves = await provider.home(ctx)
    expect(shelves.map((s) => s.title)).toEqual([
      'Trending songs',
      'Popular artists',
      'Popular albums and singles',
      'Popular radio',
    ])
    const [call] = spotify.callsOf('graphql', 'home')
    expect(call?.variables).toEqual({
      includeHomeChapterVideoCards: false,
      homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
      timeZone: 'Asia/Kolkata',
      sp_t: '',
      facet: '',
      sectionItemsLimit: 10,
      includeEpisodeContentRatingsV2: false,
    })
    expect(call?.token).toBe('fixture-token-1')
  })

  it('loads the personal home feed with the account token when logged in', async () => {
    const clock = fakeClock()
    const session = loggedIn(clock)
    const { provider, spotify } = setup({ spotify: { clock }, provider: { session } })
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('account') })
    await provider.home(ctx)
    expect(spotify.callsOf('graphql', 'home')[0]?.token).toBe('account-token')
    expect(session.requestToken.mock.calls[0]?.[0]).toMatchObject({ reason: 'transport' })
    expect(spotify.callsOf('token')).toHaveLength(0)
  })

  it('falls back to the generic feed when the user is not logged in', async () => {
    const session: SessionTokenSource = {
      requestToken: async () => ({
        status: 200,
        json: { accessToken: 'x', accessTokenExpirationTimestampMs: 0, isAnonymous: true },
      }),
    }
    const { provider, spotify } = setup({ provider: { session } })
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('account') })
    await provider.home(ctx)
    expect(spotify.callsOf('graphql', 'home')[0]?.token).toBe('fixture-token-1')
  })

  it('loads a page of a section', async () => {
    const { provider, spotify, ctx } = setup()
    const page = await provider.getHomeSection(
      'spotify:section:0JQ5DAnM3wGh0gz1MXnu3C',
      { cursor: '20' },
      ctx,
    )
    expect(page).toMatchObject({ nextCursor: '20', total: 50 })
    expect(page.shelf.items).toHaveLength(3)
    expect(spotify.callsOf('graphql', 'homeSection')[0]?.variables).toMatchObject({
      uri: 'spotify:section:0JQ5DAnM3wGh0gz1MXnu3C',
      sectionItemsOffset: 20,
      sectionItemsLimit: 20,
      homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
    })
    expectReason(await failure(provider.getHomeSection('spotify:track:x', {}, ctx)), 'not-found')
    const empty = setup({
      spotify: {
        graphql: { homeSection: () => json({ data: { homeSections: { sections: [] } } }) },
      },
    })
    expectReason(
      await failure(empty.provider.getHomeSection('spotify:section:abc', {}, empty.ctx)),
      'not-found',
    )
  })
})

describe('account', () => {
  it('is not connected without a login source, and asks nothing', async () => {
    const { provider, spotify } = setup()
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('account') })
    expect(await provider.status(ctx)).toEqual({ connected: false })
    expect(spotify.calls).toHaveLength(0)
  })

  it('is connected, with the display name, when the session is logged in', async () => {
    const clock = fakeClock()
    const { provider, spotify } = setup({
      spotify: {
        clock,
        graphql: {
          profileAttributes: () => json({ data: { me: { profile: { name: 'Fixture User' } } } }),
        },
      },
      provider: { session: loggedIn(clock) },
    })
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('account') })
    expect(await provider.status(ctx)).toEqual({ connected: true, displayName: 'Fixture User' })
    expect(spotify.callsOf('graphql', 'profileAttributes')[0]?.token).toBe('account-token')
    // The name is cached.
    await provider.status(ctx)
    expect(spotify.callsOf('graphql', 'profileAttributes')).toHaveLength(1)
  })

  it('is connected without a name when the profile cannot be read', async () => {
    const clock = fakeClock()
    const { provider, spotify } = setup({
      spotify: { clock, graphql: { profileAttributes: () => json({}, { status: 404 }) } },
      provider: { session: loggedIn(clock) },
    })
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('account') })
    expect(await provider.status(ctx)).toEqual({ connected: true })
  })

  it('is not connected when the session is logged out or the bridge refuses', async () => {
    const loggedOut: SessionTokenSource = {
      requestToken: async () => ({ status: 401, json: null }),
    }
    const a = setup({ provider: { session: loggedOut } })
    expect(await a.provider.status({ ...a.ctx, capabilities: capabilities('account') })).toEqual({
      connected: false,
    })
    const refused: SessionTokenSource = {
      requestToken: async () => {
        throw new FxmError('AuthRequired', 'login-disabled')
      },
    }
    const b = setup({ provider: { session: refused } })
    expect(await b.provider.status({ ...b.ctx, capabilities: capabilities('account') })).toEqual({
      connected: false,
    })
  })

  it('passes other failures of the session through', async () => {
    const broken: SessionTokenSource = {
      requestToken: async () => {
        throw new FxmError('Network', 'bridge unreachable')
      },
    }
    const { provider, ctx } = setup({ provider: { session: broken } })
    await expect(
      provider.status({ ...ctx, capabilities: capabilities('account') }),
    ).rejects.toThrow('bridge unreachable')
  })

  it('forgets the account on disconnect', async () => {
    const clock = fakeClock()
    const session = loggedIn(clock)
    const { provider, spotify } = setup({ spotify: { clock }, provider: { session } })
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('account') })
    await provider.home(ctx)
    provider.disconnect()
    await provider.home(ctx)
    expect(session.requestToken).toHaveBeenCalledTimes(2)
    expect(spotify.callsOf('graphql', 'home')).toHaveLength(2)
  })
})

describe('library (logged in)', () => {
  it('reads liked songs and saved playlists with the account token', async () => {
    const clock = fakeClock()
    const { provider, spotify } = setup({
      spotify: {
        clock,
        graphql: {
          fetchLibraryTracks: () =>
            json({
              data: {
                me: {
                  library: {
                    tracks: { __typename: 'UserLibraryTrackPage', items: [], totalCount: 0 },
                  },
                },
              },
            }),
          libraryV3: () =>
            json({
              data: { me: { libraryV3: { __typename: 'LibraryPage', items: [], totalCount: 0 } } },
            }),
        },
      },
      provider: { session: loggedIn(clock) },
    })
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('account') })
    expect(await provider.getLibraryTracks({ limit: 20, cursor: '40' }, ctx)).toEqual({
      items: [],
      total: 0,
    })
    expect(await provider.getLibraryPlaylists({}, ctx)).toEqual({ items: [], total: 0 })
    const [tracksCall] = spotify.callsOf('graphql', 'fetchLibraryTracks')
    expect(tracksCall?.variables).toEqual({ offset: 40, limit: 20 })
    expect(tracksCall?.token).toBe('account-token')
    expect(spotify.callsOf('graphql', 'libraryV3')[0]?.variables).toMatchObject({
      filters: ['Playlists'],
      flatten: true,
      offset: 0,
      limit: 50,
    })
  })

  it('needs a login', async () => {
    const { provider, ctx } = setup()
    expectReason(await failure(provider.getLibraryTracks({}, ctx)), 'account-unavailable')
  })

  it('refuses answers that are not library pages', async () => {
    const clock = fakeClock()
    const { provider, spotify } = setup({
      spotify: {
        clock,
        graphql: {
          fetchLibraryTracks: () => json({ data: { me: null } }),
          libraryV3: () =>
            json({ data: { me: { libraryV3: { __typename: 'LibraryInvalidFilterIdError' } } } }),
        },
      },
      provider: { session: loggedIn(clock) },
    })
    const ctx = contextFor(spotify.fetch, { capabilities: capabilities('account') })
    expectReason(await failure(provider.getLibraryTracks({}, ctx)), 'bad-response')
    expectReason(await failure(provider.getLibraryPlaylists({}, ctx)), 'bad-response')
  })
})

describe('track details', () => {
  it('reads the ISRC, label and date from spclient by the hex gid', async () => {
    const { provider, spotify, ctx } = setup()
    expect(await provider.getTrackDetails(creep, ctx)).toEqual({
      isrc: 'GBAYE9200070',
      label: 'XL Recordings',
      releaseDate: '1993-02-22',
      popularity: 93,
    })
    const [call] = spotify.callsOf('spclient')
    expect(call?.url.pathname).toBe('/metadata/4/track/e666c6ccc4c7437f83552aa9bf4f2cfd')
    expect(call?.url.searchParams.get('market')).toBe('from_token')
  })

  it('adds what it lacks to a track, and includes a known ISRC in getTrack', async () => {
    const { provider, spotify, ctx } = setup()
    const track = await provider.getTrack(creep, ctx)
    const enriched = await provider.enrichTrack({ ...track, releaseDate: '1993' }, ctx)
    expect(enriched).toMatchObject({ isrc: 'GBAYE9200070', popularity: 93, releaseDate: '1993' })
    expect((await provider.getTrack(creep, ctx)).isrc).toBe('GBAYE9200070')
    const foreign = await provider.enrichTrack(
      youtubeTrack({ externalIds: { spotify: '70LcF31zb1H0PyJoS1Sx1r' }, isrc: 'USABC0000001' }),
      ctx,
    )
    expect(foreign.isrc).toBe('USABC0000001')
    const plain = youtubeTrack()
    expect(await provider.enrichTrack(plain, ctx)).toBe(plain)
    expect(spotify.callsOf('spclient')).toHaveLength(1)
  })
})

describe('resilience', () => {
  it('pauses after repeated 429s, fails fast, reports it, and resumes', async () => {
    let limited = true
    const { provider, spotify, clock, onHealthChange, ctx } = setup({
      spotify: {
        graphql: {
          getTrack: () => (limited ? json({}, { status: 429 }) : json(fixtures.getTrack)),
        },
      },
    })
    const error = await failure(provider.getTrack(creep, ctx))
    expectReason(error, 'paused')
    expect(error).toMatchObject({ code: 'RateLimited', retryAfterMs: 5 * MINUTE })
    expect(spotify.callsOf('graphql')).toHaveLength(4)
    expect(provider.health()).toEqual({
      pausedUntil: clock.now() + 5 * MINUTE,
      brokenOperations: [],
    })
    expect(onHealthChange).toHaveBeenCalled()
    expectReason(await failure(provider.getArtist(radiohead, ctx)), 'paused')
    expect(spotify.callsOf('graphql')).toHaveLength(4)
    limited = false
    provider.resume()
    expect(provider.health()).toEqual({ brokenOperations: [] })
    expect((await provider.getTrack(creep, ctx)).title).toBe('Creep')
  })

  it('reports a broken operation and keeps the others working', async () => {
    const { provider, ctx } = setup({
      spotify: { graphql: { searchDesktop: () => json('Invalid query hash', { status: 412 }) } },
    })
    expectReason(
      await failure(provider.search('creep', { types: ['track', 'album'] }, ctx)),
      'operation-broken',
    )
    expect(provider.health().brokenOperations).toEqual(['searchDesktop'])
    expect((await provider.search('creep', { types: ['track'] }, ctx)).tracks?.items).toHaveLength(
      2,
    )
    provider.resetOperations()
    expect(provider.health().brokenOperations).toEqual([])
  })

  it('pauses on a refused secret, says so, and resumes with new sources', async () => {
    const { provider, spotify, ctx } = setup({
      spotify: {
        token: (params) =>
          params.get('totpVer') === '9'
            ? json({
                accessToken: 'ok',
                accessTokenExpirationTimestampMs: Date.UTC(2027, 0),
                isAnonymous: true,
              })
            : json({}, { status: 400 }),
      },
    })
    expectReason(await failure(provider.getTrack(creep, ctx)), 'secret-rejected')
    expect(provider.health().secretPausedUntil).toBeGreaterThan(0)
    provider.setSecretSources([{ json: JSON.stringify({ '9': [1, 2, 3, 4, 5, 6] }) }])
    expect(provider.health().secretPausedUntil).toBeUndefined()
    expect((await provider.getTrack(creep, ctx)).title).toBe('Creep')
    expect(spotify.callsOf('token').at(-1)?.url.searchParams.get('totpVer')).toBe('9')
  })

  it('reports a refused User-Agent', async () => {
    const { provider, ctx } = setup({
      spotify: { graphql: { getTrack: () => json(fixtures.error403Client, { status: 403 }) } },
    })
    expectReason(await failure(provider.getTrack(creep, ctx)), 'client-rejected')
  })
})

describe('caching', () => {
  const cases: Array<{
    name: string
    ttl: number
    call: (p: ReturnType<typeof setup>) => Promise<unknown>
    count: (p: ReturnType<typeof setup>) => number
  }> = [
    {
      name: 'search for 10 minutes',
      ttl: 10 * MINUTE,
      call: ({ provider, ctx }) => provider.search('creep', { types: ['track'] }, ctx),
      count: ({ spotify }) => spotify.callsOf('graphql', 'searchTracks').length,
    },
    {
      name: 'tracks for 6 hours',
      ttl: 6 * HOUR,
      call: ({ provider, ctx }) => provider.getTrack(creep, ctx),
      count: ({ spotify }) => spotify.callsOf('graphql', 'getTrack').length,
    },
    {
      name: 'albums for 6 hours',
      ttl: 6 * HOUR,
      call: ({ provider, ctx }) => provider.getAlbum(pabloHoney, ctx),
      count: ({ spotify }) => spotify.callsOf('graphql', 'getAlbum').length,
    },
    {
      name: 'artists for 6 hours',
      ttl: 6 * HOUR,
      call: ({ provider, ctx }) => provider.getArtist(radiohead, ctx),
      count: ({ spotify }) => spotify.callsOf('graphql', 'queryArtistOverview').length,
    },
    {
      name: 'related artists for 6 hours',
      ttl: 6 * HOUR,
      call: ({ provider, ctx }) => provider.getRelatedArtists(radiohead, ctx),
      count: ({ spotify }) => spotify.callsOf('graphql', 'queryArtistRelated').length,
    },
    {
      name: 'playlists for 6 hours',
      ttl: 6 * HOUR,
      call: ({ provider, ctx }) => provider.getPlaylist(creepRadio, ctx),
      count: ({ spotify }) => spotify.callsOf('graphql', 'fetchPlaylist').length,
    },
    {
      name: 'track details for 24 hours',
      ttl: 24 * HOUR,
      call: ({ provider, ctx }) => provider.getTrackDetails(creep, ctx),
      count: ({ spotify }) => spotify.callsOf('spclient').length,
    },
    {
      name: 'the home feed for 30 minutes',
      ttl: 30 * MINUTE,
      call: ({ provider, ctx }) => provider.home(ctx),
      count: ({ spotify }) => spotify.callsOf('graphql', 'home').length,
    },
    {
      name: 'home sections for 30 minutes',
      ttl: 30 * MINUTE,
      call: ({ provider, ctx }) => provider.getHomeSection('spotify:section:abc', {}, ctx),
      count: ({ spotify }) => spotify.callsOf('graphql', 'homeSection').length,
    },
    {
      name: 'radio for 30 minutes',
      ttl: 30 * MINUTE,
      call: ({ provider, ctx }) => provider.radio({ id: radiohead, name: 'Radiohead' }, ctx),
      count: ({ spotify }) => spotify.callsOf('spclient').length,
    },
  ]

  for (const { name, ttl, call, count } of cases) {
    it(`keeps ${name}`, async () => {
      const s = setup()
      await call(s)
      await call(s)
      expect(count(s)).toBe(1)
      s.clock.advance(ttl - 1)
      await call(s)
      expect(count(s)).toBe(1)
      s.clock.advance(1)
      await call(s)
      expect(count(s)).toBe(2)
    })
  }

  it('takes other lifetimes from the options', async () => {
    const s = setup({ provider: { cacheTtlMs: { search: MINUTE } } })
    await s.provider.search('creep', { types: ['track'] }, s.ctx)
    s.clock.advance(MINUTE)
    await s.provider.search('creep', { types: ['track'] }, s.ctx)
    expect(s.spotify.callsOf('graphql', 'searchTracks')).toHaveLength(2)
  })

  it('shares one request between concurrent callers', async () => {
    const { provider, spotify, ctx } = setup()
    await Promise.all([provider.getArtist(radiohead, ctx), provider.getArtist(radiohead, ctx)])
    expect(spotify.callsOf('graphql', 'queryArtistOverview')).toHaveLength(1)
    expect(spotify.callsOf('token')).toHaveLength(1)
  })
})
