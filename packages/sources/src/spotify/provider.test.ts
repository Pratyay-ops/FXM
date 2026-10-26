import {
  type EntityId,
  FxmError,
  formatId,
  isFxmError,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SPOTIFY_CONFIG, parseSpotifyConfig } from './config'
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
import { gidToSpotifyId } from './ids'
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

/** Provider options for a platform with a login source and the account connected. */
function withAccount(session: SessionTokenSource): SpotifyProviderOptions {
  return { session, isAccountEnabled: () => true }
}

/** A provider context on a platform with a login source. */
function accountContext(spotify: { fetch: typeof fetch }): ProviderContext {
  return contextFor(spotify.fetch, { capabilities: capabilities('account') })
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

  it('says whether Spotify is available from its own switch and the platform', () => {
    let enabled = true
    const { provider, ctx } = setup({ provider: { isEnabled: () => enabled } })
    expect(provider.isAvailable(ctx)).toBe(true)
    expect(provider.isAvailable({ capabilities: capabilities('unreachable') })).toBe(false)
    enabled = false
    expect(provider.isAvailable(ctx)).toBe(false)
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

  it('caps the page size, and refuses cursors it did not make with a typed error', async () => {
    const { provider, spotify, ctx } = setup()
    await provider.search('creep', { types: ['track'], limit: 500 }, ctx)
    expect(spotify.callsOf('graphql')[0]?.variables).toMatchObject({ limit: 50 })
    for (const call of [
      provider.search('creep', { types: ['track'], cursor: 'abc' }, ctx),
      provider.getPlaylistTracks(creepRadio, { cursor: '-1' }, ctx),
      provider.getHomeSection('spotify:section:abc', { cursor: '1e3' }, ctx),
    ]) {
      const error = await failure(call)
      expectReason(error, 'bad-cursor')
      expect(error).toMatchObject({ code: 'Unsupported' })
    }
    expect(spotify.callsOf('graphql')).toHaveLength(1)
  })

  it('gives every missing type its own empty page', async () => {
    const { provider, ctx } = setup()
    const results = await provider.search('   ', { types: ['album', 'artist', 'playlist'] }, ctx)
    expect(results.albums).toEqual({ items: [] })
    expect(results.albums).not.toBe(results.artists)
    expect(results.artists).not.toBe(results.playlists)
  })

  it('uses the typed searches when the config has no searchDesktop', async () => {
    const operations = Object.fromEntries(
      Object.entries(DEFAULT_SPOTIFY_CONFIG.operations).filter(
        ([name]) => name !== 'searchDesktop',
      ),
    )
    const config = parseSpotifyConfig({ ...DEFAULT_SPOTIFY_CONFIG, operations })
    const { provider, spotify, ctx } = setup({ provider: { config } })
    const results = await provider.search('radiohead', { types: ['track', 'artist'] }, ctx)
    // The typed searches run concurrently.
    expect(
      spotify
        .callsOf('graphql')
        .map((c) => c.operationName)
        .sort(),
    ).toEqual(['searchArtists', 'searchTracks'])
    expect(results.tracks?.items.length).toBeGreaterThan(0)
    expect(results.artists?.items.length).toBeGreaterThan(0)
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
              const id = gidToSpotifyId(n.toString(16).padStart(32, '0'))
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

  it('hands every caller its own copy, so changing a result never changes the cache', async () => {
    const { provider, spotify, ctx } = setup()
    const [a, b] = await Promise.all([
      provider.getAlbum(pabloHoney, ctx),
      provider.getAlbum(pabloHoney, ctx),
    ])
    expect(a).not.toBe(b)
    a.tracks?.reverse()
    a.name = 'Changed'
    const again = await provider.getAlbum(pabloHoney, ctx)
    expect(again.name).toBe('Pablo Honey')
    expect(again.tracks?.map((t) => t.title)).toEqual(['You', 'Creep', 'How Do You?'])
    const results = await provider.search('creep', { types: ['album', 'artist'] }, ctx)
    const albums = results.albums?.items ?? []
    albums.push(...albums)
    const cached = await provider.search('creep', { types: ['album', 'artist'] }, ctx)
    expect(cached.albums?.items).toHaveLength(2)
    expect(spotify.callsOf('graphql', 'getAlbum')).toHaveLength(1)
    expect(spotify.callsOf('graphql', 'searchDesktop')).toHaveLength(1)
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

  it('loads the personal home feed with the account token when connected', async () => {
    const clock = fakeClock()
    const session = loggedIn(clock)
    const { provider, spotify } = setup({ spotify: { clock }, provider: withAccount(session) })
    await provider.home(accountContext(spotify))
    expect(spotify.callsOf('graphql', 'home')[0]?.token).toBe('account-token')
    expect(session.requestToken.mock.calls[0]?.[0]).toMatchObject({ reason: 'transport' })
    expect(spotify.callsOf('token')).toHaveLength(0)
  })

  it('leaves the account alone until the user connects it in FXM', async () => {
    const clock = fakeClock()
    const session = loggedIn(clock)
    const { provider, spotify } = setup({ spotify: { clock }, provider: { session } })
    await provider.home(accountContext(spotify))
    expect(spotify.callsOf('graphql', 'home')[0]?.token).toBe('fixture-token-1')
    expect(session.requestToken).not.toHaveBeenCalled()
  })

  it('falls back to the generic feed when the user is not logged in', async () => {
    const session: SessionTokenSource = {
      requestToken: async () => ({
        status: 200,
        json: { accessToken: 'x', accessTokenExpirationTimestampMs: 0, isAnonymous: true },
      }),
    }
    const { provider, spotify } = setup({ provider: withAccount(session) })
    await provider.home(accountContext(spotify))
    expect(spotify.callsOf('graphql', 'home')[0]?.token).toBe('fixture-token-1')
  })

  it('falls back to the generic feed when the login is switched off near the token expiry', async () => {
    const clock = fakeClock()
    let off = false
    const requestToken = vi.fn<SessionTokenSource['requestToken']>(async () => {
      if (off) throw new FxmError('AuthRequired', 'login-disabled')
      return {
        status: 200,
        json: {
          accessToken: 'account-token',
          accessTokenExpirationTimestampMs: clock.now() + HOUR,
          isAnonymous: false,
        },
      }
    })
    const { provider, spotify } = setup({
      spotify: { clock },
      provider: withAccount({ requestToken }),
    })
    const ctx = accountContext(spotify)
    await provider.home(ctx)
    clock.advance(59 * MINUTE + 30_000)
    off = true
    await provider.home(ctx)
    expect(spotify.callsOf('graphql', 'home').map((c) => c.token)).toEqual([
      'account-token',
      'fixture-token-1',
    ])
    expect(await provider.status(ctx)).toEqual({ connected: false })
  })

  it('loads a page of a section, and refuses IDs that are not Spotify sections', async () => {
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
    expectReason(await failure(provider.getHomeSection('spotify:track:x', {}, ctx)), 'foreign-id')
    expectReason(
      await failure(provider.getHomeSection('spotify:section:no-dashes', {}, ctx)),
      'not-found',
    )
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
    const { provider, spotify } = setup({ provider: { isAccountEnabled: () => true } })
    expect(await provider.status(accountContext(spotify))).toEqual({ connected: false })
    expect(spotify.calls).toHaveLength(0)
  })

  it('is not connected, and asks nothing, until the user connects the account', async () => {
    const clock = fakeClock()
    const session = loggedIn(clock)
    let account = false
    const { provider, spotify } = setup({
      spotify: { clock },
      provider: { session, isAccountEnabled: () => account },
    })
    const ctx = accountContext(spotify)
    expect(await provider.status(ctx)).toEqual({ connected: false })
    expect(session.requestToken).not.toHaveBeenCalled()
    account = true
    expect(await provider.status(ctx)).toMatchObject({ connected: true })
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
      provider: withAccount(loggedIn(clock)),
    })
    const ctx = accountContext(spotify)
    expect(await provider.status(ctx)).toEqual({ connected: true, displayName: 'Fixture User' })
    expect(spotify.callsOf('graphql', 'profileAttributes')[0]?.token).toBe('account-token')
    // The name is cached.
    await provider.status(ctx)
    expect(spotify.callsOf('graphql', 'profileAttributes')).toHaveLength(1)
  })

  it('reads the profile again once the account token changes', async () => {
    const clock = fakeClock()
    let n = 0
    const requestToken = vi.fn<SessionTokenSource['requestToken']>(async () => ({
      status: 200,
      json: {
        accessToken: `account-token-${++n}`,
        accessTokenExpirationTimestampMs: clock.now() + HOUR,
        isAnonymous: false,
      },
    }))
    const { provider, spotify } = setup({
      spotify: {
        clock,
        graphql: {
          profileAttributes: () => json({ data: { me: { profile: { name: `User ${n}` } } } }),
        },
      },
      provider: withAccount({ requestToken }),
    })
    const ctx = accountContext(spotify)
    expect(await provider.status(ctx)).toEqual({ connected: true, displayName: 'User 1' })
    clock.advance(HOUR)
    // Another account may be logged in now: its name, not the cached one.
    expect(await provider.status(ctx)).toEqual({ connected: true, displayName: 'User 2' })
  })

  it('is connected without a name when the profile cannot be read', async () => {
    const clock = fakeClock()
    const { provider, spotify } = setup({
      spotify: { clock, graphql: { profileAttributes: () => json({}, { status: 404 }) } },
      provider: withAccount(loggedIn(clock)),
    })
    expect(await provider.status(accountContext(spotify))).toEqual({ connected: true })
  })

  it('is not connected when the session is logged out or the bridge refuses', async () => {
    const loggedOut: SessionTokenSource = {
      requestToken: async () => ({ status: 401, json: null }),
    }
    const a = setup({ provider: withAccount(loggedOut) })
    expect(await a.provider.status(accountContext(a.spotify))).toEqual({ connected: false })
    for (const refusal of [
      new FxmError('AuthRequired', 'login-disabled'),
      new FxmError('Unsupported', 'private-tab'),
    ]) {
      const refused: SessionTokenSource = { requestToken: () => Promise.reject(refusal) }
      const b = setup({ provider: withAccount(refused) })
      expect(await b.provider.status(accountContext(b.spotify))).toEqual({ connected: false })
    }
  })

  it('reports other failures of the session as typed errors', async () => {
    for (const thrown of [new FxmError('Network', 'bridge unreachable'), new TypeError('gone')]) {
      const broken: SessionTokenSource = { requestToken: () => Promise.reject(thrown) }
      const { provider, spotify } = setup({ provider: withAccount(broken) })
      const error = await failure(provider.status(accountContext(spotify)))
      expectReason(error, 'network')
      expect(error.cause).toBe(thrown)
    }
  })

  it('stops using the account on disconnect, until connect', async () => {
    const clock = fakeClock()
    const session = loggedIn(clock)
    const { provider, spotify } = setup({ spotify: { clock }, provider: withAccount(session) })
    const ctx = accountContext(spotify)
    await provider.home(ctx)
    provider.disconnect()
    expect(await provider.status(ctx)).toEqual({ connected: false })
    await provider.home(ctx)
    expectReason(await failure(provider.getLibraryPlaylists({}, ctx)), 'account-disabled')
    expect(session.requestToken).toHaveBeenCalledTimes(1)
    expect(spotify.callsOf('graphql', 'home').map((c) => c.token)).toEqual([
      'account-token',
      'fixture-token-1',
    ])
    provider.connect()
    await provider.home(ctx)
    expect(session.requestToken).toHaveBeenCalledTimes(2)
    expect(spotify.callsOf('graphql', 'home').at(-1)?.token).toBe('account-token')
  })

  it('asks the login source again at once after connect', async () => {
    const clock = fakeClock()
    let loggedOut = true
    const requestToken = vi.fn<SessionTokenSource['requestToken']>(async () => ({
      status: 200,
      json: {
        accessToken: 'account-token',
        accessTokenExpirationTimestampMs: clock.now() + HOUR,
        isAnonymous: loggedOut,
      },
    }))
    const { provider, spotify } = setup({
      spotify: { clock },
      provider: withAccount({ requestToken }),
    })
    const ctx = accountContext(spotify)
    expect(await provider.status(ctx)).toEqual({ connected: false })
    loggedOut = false
    // The logged-out answer is remembered for a minute...
    expect(await provider.status(ctx)).toEqual({ connected: false })
    expect(requestToken).toHaveBeenCalledTimes(1)
    // ...unless the app says the user just logged in.
    provider.connect()
    expect(await provider.status(ctx)).toMatchObject({ connected: true })
    expect(requestToken).toHaveBeenCalledTimes(2)
  })
})

describe('library (logged in)', () => {
  const library = {
    fetchLibraryTracks: () =>
      json({
        data: {
          me: {
            library: {
              tracks: {
                __typename: 'UserLibraryTrackPage',
                totalCount: 1,
                items: [
                  {
                    addedAt: { isoString: '2026-10-01T10:00:00Z' },
                    track: { _uri: CREEP_ID, data: fixtures.getTrack.data.trackUnion },
                  },
                ],
              },
            },
          },
        },
      }),
    libraryV3: () =>
      json({
        data: { me: { libraryV3: { __typename: 'LibraryPage', items: [], totalCount: 0 } } },
      }),
  }

  it('reads liked songs, with when they were liked, and saved playlists', async () => {
    const clock = fakeClock()
    const { provider, spotify } = setup({
      spotify: { clock, graphql: library },
      provider: withAccount(loggedIn(clock)),
    })
    const ctx = accountContext(spotify)
    const liked = await provider.getLibraryTracks({ limit: 20, cursor: '40' }, ctx)
    expect(liked.items.map(({ track, addedAt }) => [track.id, addedAt])).toEqual([
      [CREEP_ID, '2026-10-01T10:00:00Z'],
    ])
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

  it('reads the user name and display name, with the account token, and caches them', async () => {
    const clock = fakeClock()
    const { provider, spotify } = setup({
      spotify: {
        clock,
        graphql: {
          profileAttributes: () =>
            json({ data: { me: { profile: { name: 'Fixture User', username: 'fixture-user' } } } }),
        },
      },
      provider: withAccount(loggedIn(clock)),
    })
    const ctx = accountContext(spotify)
    expect(await provider.getAccountProfile(ctx)).toEqual({
      username: 'fixture-user',
      displayName: 'Fixture User',
    })
    expect(await provider.status(ctx)).toEqual({ connected: true, displayName: 'Fixture User' })
    const calls = spotify.callsOf('graphql', 'profileAttributes')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.token).toBe('account-token')
    expect(calls[0]?.variables).toEqual({})
    const missing = setup({
      spotify: { clock, graphql: { profileAttributes: () => json({ data: { me: null } }) } },
      provider: withAccount(loggedIn(clock)),
    })
    expectReason(
      await failure(missing.provider.getAccountProfile(accountContext(missing.spotify))),
      'bad-response',
    )
  })

  it("lists saved playlists with their revision, and reads one's pages with the account", async () => {
    const clock = fakeClock()
    const uri = 'spotify:playlist:37i9dQZF1E8OvD4G5pVGhr'
    const { provider, spotify } = setup({
      spotify: {
        clock,
        graphql: {
          libraryV3: () =>
            json({
              data: {
                me: {
                  libraryV3: {
                    __typename: 'LibraryPage',
                    totalCount: 51,
                    items: [
                      {
                        item: {
                          __typename: 'PlaylistResponseWrapper',
                          _uri: uri,
                          data: {
                            ...fixtures.playlistRadio.data.playlistV2,
                            revisionId: 'AAAAB2fixture-revision',
                            content: undefined,
                          },
                        },
                      },
                    ],
                  },
                },
              },
            }),
          fetchPlaylist: () =>
            json({
              data: {
                playlistV2: {
                  ...fixtures.playlistRadio.data.playlistV2,
                  revisionId: 'AAAAB2fixture-revision',
                },
              },
            }),
        },
      },
      provider: withAccount(loggedIn(clock)),
    })
    const ctx = accountContext(spotify)
    const saved = await provider.getLibraryPlaylists({}, ctx)
    expect(saved.items.map(({ playlist, revisionId }) => [playlist.id, revisionId])).toEqual([
      [creepRadio, 'AAAAB2fixture-revision'],
    ])
    expect(saved.nextCursor).toBe('50')
    const page = await provider.getLibraryPlaylistTracks(creepRadio, { cursor: '100' }, ctx)
    expect(page.revisionId).toBe('AAAAB2fixture-revision')
    expect(page.tracks.items.map((track) => track.title)).toHaveLength(3)
    expect(page.tracks.total).toBe(50)
    const [call] = spotify.callsOf('graphql', 'fetchPlaylist')
    expect(call?.token).toBe('account-token')
    expect(call?.variables).toEqual({
      uri,
      offset: 100,
      limit: 100,
      enableWatchFeedEntrypoint: false,
      includeEpisodeContentRatingsV2: false,
    })
    // Never cached: a sync wants what Spotify holds now.
    await provider.getLibraryPlaylistTracks(creepRadio, { cursor: '100' }, ctx)
    expect(spotify.callsOf('graphql', 'fetchPlaylist')).toHaveLength(2)
  })

  it("reads a playlist's pages only with a connected account", async () => {
    const { provider, ctx } = setup()
    expectReason(
      await failure(provider.getLibraryPlaylistTracks(creepRadio, {}, ctx)),
      'account-unsupported',
    )
    const clock = fakeClock()
    const gone = setup({
      spotify: {
        clock,
        graphql: {
          fetchPlaylist: () => json({ data: { playlistV2: { __typename: 'NotFound' } } }),
        },
      },
      provider: withAccount(loggedIn(clock)),
    })
    expectReason(
      await failure(
        gone.provider.getLibraryPlaylistTracks(creepRadio, {}, accountContext(gone.spotify)),
      ),
      'not-found',
    )
    expectReason(
      await failure(
        gone.provider.getLibraryPlaylistTracks(
          'spotify:album:x' as unknown as EntityId<'playlist'>,
          {},
          accountContext(gone.spotify),
        ),
      ),
      'foreign-id',
    )
  })

  it('reads the personal home only with the account, never the generic one', async () => {
    const clock = fakeClock()
    const { provider, spotify } = setup({
      spotify: { clock },
      provider: withAccount(loggedIn(clock)),
    })
    const ctx = accountContext(spotify)
    const shelves = await provider.getAccountHome(ctx)
    expect(shelves.length).toBeGreaterThan(0)
    expect(spotify.callsOf('graphql', 'home').map((c) => c.token)).toEqual(['account-token'])
    // The same cache as the personal feed of home().
    await provider.home(ctx)
    expect(spotify.callsOf('graphql', 'home')).toHaveLength(1)
    const loggedOut = setup({
      spotify: { clock },
      provider: withAccount({ requestToken: async () => ({ status: 401, json: null }) }),
    })
    expectReason(
      await failure(loggedOut.provider.getAccountHome(accountContext(loggedOut.spotify))),
      'login-required',
    )
    expect(loggedOut.spotify.callsOf('graphql', 'home')).toHaveLength(0)
    const { provider: anonymous, ctx: anonymousCtx } = setup()
    expectReason(await failure(anonymous.getAccountHome(anonymousCtx)), 'account-unsupported')
  })

  it('needs a login source and a connected account', async () => {
    const { provider, ctx } = setup()
    expectReason(await failure(provider.getLibraryTracks({}, ctx)), 'account-unsupported')
    const clock = fakeClock()
    const off = setup({ spotify: { clock }, provider: { session: loggedIn(clock) } })
    expectReason(
      await failure(off.provider.getLibraryTracks({}, accountContext(off.spotify))),
      'account-disabled',
    )
    expect(off.spotify.calls).toHaveLength(0)
  })

  it('stops reading the library once the platform loses the account capability', async () => {
    const clock = fakeClock()
    const session = loggedIn(clock)
    const { provider, spotify } = setup({
      spotify: { clock, graphql: library },
      provider: withAccount(session),
    })
    await provider.getLibraryTracks({}, accountContext(spotify))
    // E.g. the user turned off "Use my Spotify login" in FXM Connect.
    const anonymous = contextFor(spotify.fetch)
    expect(await provider.status(anonymous)).toEqual({ connected: false })
    expectReason(await failure(provider.getLibraryTracks({}, anonymous)), 'account-unsupported')
    expectReason(await failure(provider.getLibraryPlaylists({}, anonymous)), 'account-unsupported')
    expect(spotify.calls.filter((c) => c.token === 'account-token')).toHaveLength(1)
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
      provider: withAccount(loggedIn(clock)),
    })
    const ctx = accountContext(spotify)
    expectReason(await failure(provider.getLibraryTracks({}, ctx)), 'bad-response')
    expectReason(await failure(provider.getLibraryPlaylists({}, ctx)), 'bad-response')
  })
})

describe('track details', () => {
  it('reads the ISRC, label, date and album type from spclient by the hex gid', async () => {
    const { provider, spotify, ctx } = setup()
    expect(await provider.getTrackDetails(creep, ctx)).toEqual({
      isrc: 'GBAYE9200070',
      label: 'XL Recordings',
      releaseDate: '1993-02-22',
      albumType: 'album',
      popularity: 93,
    })
    const [call] = spotify.callsOf('spclient')
    expect(call?.url.pathname).toBe('/metadata/4/track/e666c6ccc4c7437f83552aa9bf4f2cfd')
    expect(call?.url.searchParams.get('market')).toBe('from_token')
  })

  it('adds what a Spotify track lacks, and includes a known ISRC in getTrack', async () => {
    const { provider, spotify, ctx } = setup()
    const track = await provider.getTrack(creep, ctx)
    const enriched = await provider.enrichTrack({ ...track, releaseDate: '1993' }, ctx)
    expect(enriched).toMatchObject({ isrc: 'GBAYE9200070', popularity: 93, releaseDate: '1993' })
    expect((await provider.getTrack(creep, ctx)).isrc).toBe('GBAYE9200070')
    const plain = youtubeTrack()
    expect(await provider.enrichTrack(plain, ctx)).toBe(plain)
    expect(spotify.callsOf('spclient')).toHaveLength(1)
  })

  it("adds only the ISRC to another source's track, not Spotify's release facts", async () => {
    const { provider, ctx } = setup()
    const compilation = youtubeTrack({ externalIds: { spotify: '70LcF31zb1H0PyJoS1Sx1r' } })
    const enriched = await provider.enrichTrack(compilation, ctx)
    expect(enriched.isrc).toBe('GBAYE9200070')
    expect(enriched).not.toHaveProperty('releaseDate')
    expect(enriched).not.toHaveProperty('popularity')
    const known = await provider.enrichTrack({ ...compilation, isrc: 'USABC0000001' }, ctx)
    expect(known.isrc).toBe('USABC0000001')
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

  it('does not pause Spotify when an early token refresh is rate limited', async () => {
    const clock = fakeClock()
    let issued = 0
    const { provider, spotify, ctx } = setup({
      spotify: {
        clock,
        token: () =>
          ++issued > 1
            ? json({}, { status: 429 })
            : json({
                accessToken: 'still-good',
                accessTokenExpirationTimestampMs: clock.now() + HOUR,
                isAnonymous: true,
              }),
      },
    })
    await provider.getTrack(creep, ctx)
    clock.advance(HOUR - 30_000)
    expect((await provider.getArtist(radiohead, ctx)).name).toBe('Radiohead')
    expect(spotify.callsOf('token')).toHaveLength(2)
    expect(spotify.callsOf('graphql', 'queryArtistOverview')[0]?.token).toBe('still-good')
    expect(provider.health()).toEqual({ brokenOperations: [] })
  })

  it('answers with the typed searches when searchDesktop breaks', async () => {
    const { provider, spotify, ctx } = setup({
      spotify: { graphql: { searchDesktop: () => json('Invalid query hash', { status: 412 }) } },
    })
    const first = await provider.search('creep', { types: ['track', 'album'] }, ctx)
    expect(first.tracks?.items).toHaveLength(2)
    expect(first.albums?.items).toHaveLength(2)
    expect(provider.health().brokenOperations).toEqual(['searchDesktop'])
    const second = await provider.search('creep', { types: ['track', 'artist'] }, ctx)
    expect(second.artists?.items.length).toBeGreaterThan(0)
    const operations = spotify.callsOf('graphql').map((c) => c.operationName)
    expect(operations[0]).toBe('searchDesktop')
    expect(operations.slice(1).sort()).toEqual(['searchAlbums', 'searchArtists', 'searchTracks'])
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
    expect(provider.health().secretPaused).toMatchObject({ reason: 'secret-rejected' })
    provider.setSecretSources([{ json: JSON.stringify({ '9': [1, 2, 3, 4, 5, 6] }) }])
    expect(provider.health().secretPaused).toBeUndefined()
    expect((await provider.getTrack(creep, ctx)).title).toBe('Creep')
    expect(spotify.callsOf('token').at(-1)?.url.searchParams.get('totpVer')).toBe('9')
  })

  it('pauses and says so when no secret source can be read', async () => {
    const { provider, spotify, clock, onHealthChange, ctx } = setup({
      spotify: { secret: () => json({ message: 'gone' }, { status: 404 }) },
    })
    expectReason(await failure(provider.getTrack(creep, ctx)), 'secret-unavailable')
    expect(provider.health()).toEqual({
      secretPaused: { until: clock.now() + MINUTE, reason: 'secret-unavailable' },
      brokenOperations: [],
    })
    expect(onHealthChange).toHaveBeenLastCalledWith(provider.health())
    // Every call fails at once now, without asking the secret source again.
    for (let i = 0; i < 5; i++) {
      expectReason(await failure(provider.getArtist(radiohead, ctx)), 'secret-unavailable')
    }
    expect(spotify.callsOf('secret')).toHaveLength(1)
    expect(spotify.callsOf('token')).toHaveLength(0)
    provider.resume()
    expect(provider.health()).toEqual({ brokenOperations: [] })
  })

  it('keeps a rate-limit pause when the secret sources change', async () => {
    const { provider, spotify, ctx } = setup({
      spotify: {
        graphql: { getTrack: () => json({}, { status: 429, headers: { 'retry-after': '3600' } }) },
      },
    })
    expectReason(await failure(provider.getTrack(creep, ctx)), 'paused')
    const pausedUntil = provider.health().pausedUntil
    provider.setSecretSources([{ json: JSON.stringify({ '9': [1, 2, 3] }) }])
    expect(provider.health().pausedUntil).toBe(pausedUntil)
    expectReason(await failure(provider.getArtist(radiohead, ctx)), 'paused')
    expect(spotify.callsOf('graphql')).toHaveLength(1)
  })

  it('checks new secret sources before using them, and can go back to the defaults', async () => {
    const { provider, spotify, ctx } = setup()
    for (const url of ['http://secrets.example.test/s.json', 'https://192.168.1.1/admin.json']) {
      expect(() => provider.setSecretSources([{ url }])).toThrow(TypeError)
    }
    // Nothing changed: the configured source still serves the secret.
    await provider.getTrack(creep, ctx)
    expect(spotify.callsOf('secret')).toHaveLength(1)
    // Back to the bundled sources, on GitHub, which the offline fake refuses to reach.
    const fresh = setup()
    fresh.provider.setSecretSources()
    const error = await failure(fresh.provider.getTrack(creep, fresh.ctx))
    expectReason(error, 'secret-unavailable')
    expect(error.message).toContain('raw.githubusercontent.com')
  })

  it('reports a refused User-Agent, also in its health', async () => {
    const { provider, onHealthChange, ctx } = setup({
      spotify: { graphql: { getTrack: () => json(fixtures.error403Client, { status: 403 }) } },
    })
    expectReason(await failure(provider.getTrack(creep, ctx)), 'client-rejected')
    expect(provider.health()).toEqual({ clientRejected: true, brokenOperations: [] })
    expect(onHealthChange).toHaveBeenLastCalledWith({ clientRejected: true, brokenOperations: [] })
    provider.resume()
    expect(provider.health()).toEqual({ brokenOperations: [] })
  })

  it('applies a newer config to the running provider', async () => {
    const { provider, spotify, ctx } = setup({
      spotify: {
        graphql: {
          getTrack: (_variables, call) =>
            call.sha256Hash === 'a'.repeat(64)
              ? json(fixtures.getTrack)
              : json('Invalid query hash', { status: 412 }),
        },
      },
    })
    expectReason(await failure(provider.getTrack(creep, ctx)), 'operation-broken')
    expect(provider.health().brokenOperations).toEqual(['getTrack'])
    const newer = parseSpotifyConfig({
      ...DEFAULT_SPOTIFY_CONFIG,
      version: DEFAULT_SPOTIFY_CONFIG.version + 1,
      userAgent: 'Mozilla/5.0 (fixture) Chrome/151.0.0.0',
      operations: {
        ...DEFAULT_SPOTIFY_CONFIG.operations,
        getTrack: { sha256Hash: 'a'.repeat(64) },
      },
    })
    provider.setConfig(newer)
    expect(provider.health().brokenOperations).toEqual([])
    const desktop = contextFor(spotify.fetch, { platform: 'desktop' })
    expect((await provider.getTrack(creep, desktop)).title).toBe('Creep')
    const last = spotify.callsOf('graphql', 'getTrack').at(-1)
    expect(last?.headers.get('user-agent')).toBe('Mozilla/5.0 (fixture) Chrome/151.0.0.0')
    // The token minted before the change is still used.
    expect(spotify.callsOf('token')).toHaveLength(1)
    expect(() => provider.setConfig({ ...newer, userAgent: '' })).toThrow(TypeError)
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
    const s = setup({ provider: { cacheTtls: { search: MINUTE } } })
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
