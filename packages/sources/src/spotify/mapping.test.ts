import { describe, expect, it } from 'vitest'
import { CREEP_ID, fixtures, PABLO_HONEY_ID, RADIOHEAD_ID } from './fixtures/testing'
import {
  mapAlbum,
  mapArtist,
  mapArtwork,
  mapDate,
  mapHome,
  mapHomeSection,
  mapLibraryPlaylists,
  mapLibraryTracks,
  mapPlaylist,
  mapPlaylistContent,
  mapProfile,
  mapRelatedArtists,
  mapSearch,
  mapShelfItem,
  mapTrack,
  mapTrackDetails,
  pageOf,
  plainText,
  radioPlaylistId,
  revisionOf,
  unionOf,
} from './mapping'

const RADIOHEAD = { id: RADIOHEAD_ID, name: 'Radiohead' }

describe('mapTrack', () => {
  it('maps getTrack to a song with its album, release date and Spotify ID', () => {
    const track = mapTrack(fixtures.getTrack.data.trackUnion)
    expect(track).toMatchObject({
      id: CREEP_ID,
      source: 'spotify',
      title: 'Creep',
      artists: [RADIOHEAD],
      album: { id: PABLO_HONEY_ID, name: 'Pablo Honey' },
      durationMs: 238_640,
      explicit: true,
      kind: 'song',
      trackNumber: 2,
      releaseDate: '1993-02-22',
      externalIds: { spotify: '70LcF31zb1H0PyJoS1Sx1r' },
    })
    expect(track?.artwork.map((a) => a.width)).toEqual([640, 300, 64])
    expect(track).not.toHaveProperty('isrc')
    expect(track).not.toHaveProperty('popularity')
  })

  it('reads playlist items, whose duration field differs', () => {
    const item = fixtures.playlistRadio.data.playlistV2.content.items[1]
    expect(mapTrack(item?.itemV2.data)).toMatchObject({
      title: 'Wonderwall - Remastered',
      artists: [{ name: 'Oasis' }],
      durationMs: 258_773,
      discNumber: 1,
      releaseDate: '1995-10-02',
    })
  })

  it('leaves out what is not a readable track', () => {
    expect(mapTrack({ __typename: 'Episode', uri: CREEP_ID, name: 'x' })).toBeUndefined()
    expect(mapTrack({ uri: 'spotify:track:bad', name: 'x' })).toBeUndefined()
    expect(mapTrack({ uri: CREEP_ID, name: ' ' })).toBeUndefined()
    expect(mapTrack(null)).toBeUndefined()
    expect(mapTrack([])).toBeUndefined()
  })

  it('takes the album and cover from its page when the track has none', () => {
    const track = mapTrack(
      { uri: CREEP_ID, name: 'Creep', contentRating: { label: 'NONE' } },
      { album: { name: 'Pablo Honey' }, artwork: [{ url: 'https://i.scdn.co/image/x' }] },
    )
    expect(track).toMatchObject({
      album: { name: 'Pablo Honey' },
      artwork: [{ url: 'https://i.scdn.co/image/x' }],
      explicit: false,
      artists: [],
    })
  })

  it('reads explicitness from either rating field', () => {
    const base = { uri: CREEP_ID, name: 'Creep' }
    expect(mapTrack({ ...base, contentRatingV2: { labels: ['EXPLICIT'] } })?.explicit).toBe(true)
    expect(mapTrack({ ...base, contentRatingV2: { labels: ['MOGEF_19'] } })?.explicit).toBe(false)
    expect(mapTrack(base)).not.toHaveProperty('explicit')
  })
})

describe('mapAlbum', () => {
  it('maps getAlbum with its tracks in order', () => {
    const album = mapAlbum(fixtures.getAlbum.data.albumUnion)
    expect(album).toMatchObject({
      id: PABLO_HONEY_ID,
      name: 'Pablo Honey',
      artists: [RADIOHEAD],
      type: 'album',
      releaseDate: '1993-02-22',
      trackCount: 12,
      explicit: true,
    })
    expect(album?.tracks?.map((t) => [t.trackNumber, t.title, t.explicit])).toEqual([
      [1, 'You', false],
      [2, 'Creep', true],
      [3, 'How Do You?', false],
    ])
    // Album tracks inherit the album, its cover and its date.
    expect(album?.tracks?.[0]).toMatchObject({
      album: { id: PABLO_HONEY_ID, name: 'Pablo Honey' },
      releaseDate: '1993-02-22',
    })
    expect(album?.tracks?.[0]?.artwork.length).toBe(3)
  })

  it('reads only the album types it knows, whatever the case', () => {
    const album = (type: string) =>
      mapAlbum({ __typename: 'Album', uri: PABLO_HONEY_ID, name: 'Pablo Honey', type })
    expect(album('Compilation')?.type).toBe('compilation')
    for (const type of ['constructor', 'toString', 'PODCAST']) {
      expect(album(type), type).not.toHaveProperty('type')
    }
  })

  it('maps search results without tracks', () => {
    const albums = mapSearch(fixtures.searchDesktop.data.searchV2, 0, 5).albums
    expect(albums?.items.map((a) => [a.name, a.type, a.releaseDate])).toEqual([
      ['Creep', 'single', '1992'],
      ['Creep EP', 'ep', '1992'],
    ])
    expect(albums?.items[0]).not.toHaveProperty('tracks')
  })

  it('reads the album type under either field name', () => {
    const home = fixtures.home.data.home.sectionContainer.sections.items[2]
    const item = mapShelfItem(home?.sectionItems.items[0])
    expect(item).toMatchObject({ type: 'album', album: { name: 'Aashiqui 2' } })
    expect(mapAlbum({ uri: PABLO_HONEY_ID, name: 'x', albumType: 'COMPILATION' })?.type).toBe(
      'compilation',
    )
    expect(mapAlbum({ __typename: 'PreRelease', uri: PABLO_HONEY_ID, name: 'x' })).toBeUndefined()
  })
})

describe('mapArtist', () => {
  it('maps the artist page: biography, top tracks, releases and related artists', () => {
    const artist = mapArtist(fixtures.artistOverview.data.artistUnion)
    expect(artist).toMatchObject({
      id: RADIOHEAD_ID,
      name: 'Radiohead',
      description: 'Fixture biography of Radiohead, an English band & more.',
    })
    expect(artist?.artwork[0]?.width).toBe(640)
    expect(artist?.topTracks?.map((t) => t.title)).toEqual(['Creep', 'Let Down', 'No Surprises'])
    // Top tracks carry the play count beyond 2^31 in Spotify's answer; FXM keeps the track.
    expect(artist?.topTracks?.[0]).toMatchObject({ id: CREEP_ID, durationMs: 238_640 })
    expect(artist?.albums?.map((a) => [a.name, a.type])).toEqual([
      ['Hail to the Thief (Live Recordings 2003-2009)', 'album'],
      ['KID A MNESIA', 'album'],
      ['Follow Me Around', 'single'],
      ['If You Say the Word', 'single'],
    ])
    expect(artist?.albums?.every((a) => a.artists[0]?.id === RADIOHEAD_ID)).toBe(true)
    expect(artist?.related?.map((a) => a.name)).toEqual(['The Smiths', 'Nirvana', 'Jeff Buckley'])
  })

  it('falls back to popular releases when the discography lists none', () => {
    const union = fixtures.artistOverview.data.artistUnion
    const discography = { ...union.discography, albums: { items: [] }, singles: { items: [] } }
    const artist = mapArtist({ ...union, discography })
    expect(artist?.albums?.map((a) => a.name)).toEqual(['OK Computer', 'Pablo Honey'])
  })

  it('maps related artists and search results', () => {
    expect(mapRelatedArtists(fixtures.artistRelated.data.artistUnion).map((a) => a.name)).toEqual([
      'The Smiths',
      'Nirvana',
      'Jeff Buckley',
    ])
    const artists = mapSearch(fixtures.searchArtists.data.searchV2, 0, 3).artists
    expect(artists?.items.map((a) => a.name)).toEqual(['Radiohead', 'TV Girl'])
    expect(artists?.items[0]).not.toHaveProperty('topTracks')
  })
})

describe('mapPlaylist', () => {
  it('maps a radio playlist with its first page', () => {
    const playlist = mapPlaylist(fixtures.playlistRadio.data.playlistV2, { offset: 0, limit: 50 })
    expect(playlist).toMatchObject({
      id: 'spotify:playlist:37i9dQZF1E8OvD4G5pVGhr',
      name: 'Creep Radio',
      owner: { name: 'Spotify', id: 'spotify' },
      description: 'With Radiohead, Nirvana, Oasis and more',
      trackCount: 50,
    })
    expect(playlist?.tracks?.items.map((t) => t.title)).toEqual([
      'Creep',
      'Wonderwall - Remastered',
      'Come As You Are - Remastered',
    ])
    expect(playlist?.tracks?.total).toBe(50)
    expect(playlist?.tracks).not.toHaveProperty('nextCursor')
  })

  it('pages by the requested limit', () => {
    const playlist = mapPlaylist(fixtures.playlistRadio.data.playlistV2, { offset: 0, limit: 25 })
    expect(playlist?.tracks?.nextCursor).toBe('25')
  })

  it('maps search results without tracks, keeping placeholder owners', () => {
    const playlists = mapSearch(fixtures.searchPlaylists.data.searchV2, 0, 3).playlists
    expect(playlists?.items.map((p) => [p.name, p.owner?.name])).toEqual([
      ['THE BEST OF RADIOHEAD', 'Fixture User'],
      ['This Is Radiohead', 'Spotify'],
    ])
    expect(playlists?.items[0]).not.toHaveProperty('tracks')
    expect(playlists?.items[0]).not.toHaveProperty('description')
  })
})

describe('mapSearch', () => {
  it('maps every type of searchDesktop, paging by the totals', () => {
    const pages = mapSearch(fixtures.searchDesktop.data.searchV2, 0, 5)
    expect(pages.tracks?.items.map((t) => t.title)).toEqual(['Creep', 'Creep - Acoustic'])
    expect(pages.tracks).toMatchObject({ total: 6, nextCursor: '5' })
    expect(pages.albums).toMatchObject({ total: 8, nextCursor: '5' })
    expect(pages.artists).toMatchObject({ total: 5 })
    expect(pages.artists).not.toHaveProperty('nextCursor')
    expect(pages.playlists?.items).toHaveLength(2)
  })

  it('follows the next offset of typed searches', () => {
    const pages = mapSearch(fixtures.searchTracks.data.searchV2, 0, 3)
    expect(pages.tracks).toMatchObject({ total: 4, nextCursor: '3' })
    expect(Object.keys(pages)).toEqual(['tracks'])
    const last = mapSearch(
      { tracksV2: { items: [], totalCount: 4, pagingInfo: { nextOffset: null } } },
      3,
      3,
    )
    expect(last.tracks).toEqual({ items: [], total: 4 })
  })

  it('returns nothing for answers it cannot read', () => {
    expect(mapSearch(undefined, 0, 10)).toEqual({})
    expect(mapSearch({ tracksV2: { items: 'x' } }, 0, 10).tracks).toEqual({ items: [] })
  })
})

describe('mapHome and sections', () => {
  it('maps the generic home feed into shelves of every item type', () => {
    const shelves = mapHome(fixtures.home.data.home)
    expect(shelves.map((s) => s.title)).toEqual([
      'Trending songs',
      'Popular artists',
      'Popular albums and singles',
      'Popular radio',
    ])
    expect(shelves.map((s) => s.items.map((i) => i.type))).toEqual([
      ['track', 'track'],
      ['artist', 'artist'],
      ['album', 'album'],
      ['playlist', 'playlist'],
    ])
    expect(shelves[0]?.id).toBe('spotify:section:0JQ5DB5E8N831KzFzsBBQ2')
    expect(shelves[0]).not.toHaveProperty('subtitle')
  })

  it('skips unknown items and empty shelves', () => {
    const home = {
      sectionContainer: {
        sections: {
          items: [
            {
              uri: 'spotify:section:a',
              data: { title: { transformedLabel: 'Podcasts' } },
              sectionItems: { items: [{ content: { data: { __typename: 'Podcast' } } }] },
            },
            { uri: 'spotify:section:b', data: { title: {} }, sectionItems: { items: [] } },
          ],
        },
      },
    }
    expect(mapHome(home)).toEqual([])
  })

  it('maps one page of a section', () => {
    const page = mapHomeSection(fixtures.homeSection.data.homeSections)
    expect(page?.shelf.title).toBe('Popular artists')
    expect(page?.shelf.items.map((i) => (i.type === 'artist' ? i.artist.name : ''))).toEqual([
      'Pritam',
      'A.R. Rahman',
      'Arijit Singh',
    ])
    expect(page).toMatchObject({ nextCursor: '20', total: 50 })
    expect(mapHomeSection({ sections: [] })).toBeUndefined()
  })
})

describe('spclient answers', () => {
  it('reads the ISRC, label, release date and popularity of metadata/4', () => {
    expect(mapTrackDetails(fixtures.metadataTrack)).toEqual({
      isrc: 'GBAYE9200070',
      label: 'XL Recordings',
      releaseDate: '1993-02-22',
      albumType: 'album',
      popularity: 93,
    })
    expect(mapTrackDetails({ album: { type: 'single' } })).toEqual({ albumType: 'single' })
    expect(mapTrackDetails({ album: { type: 'constructor' } })).toEqual({})
    expect(mapTrackDetails({ external_id: [{ type: 'isrc', id: 'not an isrc' }] })).toEqual({})
  })

  it('finds the radio playlist of a seed', () => {
    expect(radioPlaylistId(fixtures.seedToPlaylistTrack)).toBe('37i9dQZF1E8OvD4G5pVGhr')
    expect(radioPlaylistId(fixtures.seedToPlaylistArtist)).toBe('37i9dQZF1E4EgTnU7Hvt0A')
    expect(radioPlaylistId({ total: 0, mediaItems: [] })).toBeUndefined()
    expect(radioPlaylistId({ mediaItems: [{ uri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r' }] })).toBe(
      undefined,
    )
  })
})

describe('library answers (shaped after the web player, not recorded)', () => {
  const libraryTrack = {
    addedAt: { isoString: '2026-10-01T10:00:00Z' },
    track: {
      _uri: CREEP_ID,
      data: {
        __typename: 'Track',
        name: 'Creep',
        albumOfTrack: { uri: PABLO_HONEY_ID, name: 'Pablo Honey', coverArt: { sources: [] } },
        artists: { items: [{ uri: RADIOHEAD_ID, profile: { name: 'Radiohead' } }] },
        duration: { totalMilliseconds: 238_640 },
        contentRating: { label: 'EXPLICIT' },
      },
    },
  }

  it('maps liked songs, whose URI sits on the wrapper', () => {
    const page = mapLibraryTracks(
      {
        me: {
          library: {
            tracks: {
              __typename: 'UserLibraryTrackPage',
              items: [libraryTrack, { track: { _uri: 'spotify:local:x', data: null } }],
              totalCount: 120,
            },
          },
        },
      },
      0,
      50,
    )
    expect(page?.items.map(({ track }) => [track.id, track.title, track.explicit])).toEqual([
      [CREEP_ID, 'Creep', true],
    ])
    expect(page?.items[0]?.addedAt).toBe('2026-10-01T10:00:00Z')
    const undated = mapLibraryTracks(
      {
        me: {
          library: {
            tracks: {
              __typename: 'UserLibraryTrackPage',
              items: [
                { ...libraryTrack, addedAt: 'not a date' },
                { ...libraryTrack, addedAt: undefined },
              ],
            },
          },
        },
      },
      0,
      50,
    )
    expect(undated?.items.map((liked) => Object.keys(liked))).toEqual([['track'], ['track']])
    expect(page).toMatchObject({ nextCursor: '50', total: 120 })
    expect(mapLibraryTracks({ me: { library: { tracks: { __typename: 'Error' } } } }, 0, 50)).toBe(
      undefined,
    )
    // A page without its list of items can't be read: it never passes for an empty library.
    const noItems = { __typename: 'UserLibraryTrackPage', totalCount: 120 }
    expect(mapLibraryTracks({ me: { library: { tracks: noItems } } }, 0, 50)).toBeUndefined()
  })

  it('maps saved playlists with their revision, and leaves out what can not be read', () => {
    const playlist = (uri: string, data: Record<string, unknown>) => ({
      item: {
        __typename: 'PlaylistResponseWrapper',
        _uri: uri,
        data: {
          __typename: 'Playlist',
          uri,
          images: { items: [] },
          currentUserCapabilities: { canView: true, canEditItems: false },
          ...data,
        },
      },
    })
    const page = mapLibraryPlaylists(
      {
        me: {
          libraryV3: {
            __typename: 'LibraryPage',
            totalCount: 6,
            items: [
              playlist('spotify:playlist:37i9dQZF1E8OvD4G5pVGhr', {
                name: 'Mine',
                revisionId: 'AAAAB2fixture-revision',
                ownerV2: {
                  data: { __typename: 'User', name: 'Fixture User', username: 'fixture-user' },
                },
              }),
              // Spotify's own player leaves these two out: no revision, or not viewable.
              playlist('spotify:playlist:0000000000000000000001', {
                name: 'Gone',
                revisionId: null,
              }),
              playlist('spotify:playlist:0000000000000000000002', {
                name: 'Hidden',
                revisionId: 'AAAA',
                currentUserCapabilities: { canView: false },
              }),
              // An older shape without a revision still counts.
              playlist('spotify:playlist:0000000000000000000003', { name: 'Older' }),
              {
                item: {
                  __typename: 'FolderResponseWrapper',
                  _uri: 'spotify:user:x:folder:y',
                  data: {},
                },
              },
              playlist('spotify:user:x:collection:your-episodes', { name: 'Your Episodes' }),
            ],
          },
        },
      },
      0,
      50,
    )
    expect(
      page?.items.map(({ playlist: p, revisionId }) => [p.name, p.owner?.id, revisionId]),
    ).toEqual([
      ['Mine', 'fixture-user', 'AAAAB2fixture-revision'],
      ['Older', undefined, undefined],
    ])
    expect(page?.items[1]).not.toHaveProperty('revisionId')
    expect(page?.total).toBe(6)
    expect(mapLibraryPlaylists({ me: { libraryV3: { __typename: 'NotFound' } } }, 0, 50)).toBe(
      undefined,
    )
    expect(
      mapLibraryPlaylists(
        { me: { libraryV3: { __typename: 'LibraryPage', totalCount: 6 } } },
        0,
        50,
      ),
    ).toBeUndefined()
  })

  it("reads a playlist's tracks only from a list of items", () => {
    const { playlistV2 } = fixtures.playlistRadio.data
    expect(mapPlaylistContent(playlistV2, 0, 50)?.items).toHaveLength(
      mapPlaylist(playlistV2, { offset: 0, limit: 50 })?.tracks?.items.length ?? -1,
    )
    expect(mapPlaylistContent({ ...playlistV2, content: undefined }, 0, 50)).toBeUndefined()
    expect(
      mapPlaylistContent({ ...playlistV2, content: { totalCount: 50 } }, 0, 50),
    ).toBeUndefined()
    expect(mapPlaylistContent({ ...playlistV2, content: { items: [] } }, 0, 50)).toEqual({
      items: [],
    })
  })

  it('reads revisions only as short strings', () => {
    expect(revisionOf('AAAAB2')).toBe('AAAAB2')
    expect(revisionOf('')).toBeUndefined()
    expect(revisionOf(42)).toBeUndefined()
    expect(revisionOf('x'.repeat(257))).toBeUndefined()
  })

  it('reads the user name and display name of profileAttributes', () => {
    expect(
      mapProfile({ me: { profile: { name: 'Fixture User', username: 'fixture-user' } } }),
    ).toEqual({ username: 'fixture-user', displayName: 'Fixture User' })
    expect(mapProfile({ me: { profile: { name: 'Fixture User' } } })).toEqual({
      displayName: 'Fixture User',
    })
    expect(mapProfile({ me: { profile: { username: 'x'.repeat(257) } } })).toEqual({})
    expect(mapProfile({ me: null })).toBeUndefined()
  })
})

describe('helpers', () => {
  it('reads every date shape', () => {
    expect(mapDate({ isoString: '1993-02-22T00:00:00Z', precision: 'DAY' })).toBe('1993-02-22')
    expect(mapDate({ isoString: '1993-02-22T00:00:00Z', precision: 'MONTH' })).toBe('1993-02')
    expect(mapDate({ isoString: '1993-02-22T00:00:00Z', precision: 'YEAR' })).toBe('1993')
    expect(mapDate({ isoString: '1993-02', precision: 'DAY' })).toBe('1993-02')
    expect(mapDate({ year: 1993, month: 2, day: 22 })).toBe('1993-02-22')
    expect(mapDate({ year: 1993, month: 2 })).toBe('1993-02')
    expect(mapDate({ year: 1992 })).toBe('1992')
    expect(mapDate({ year: 1993, month: 13, day: 1 })).toBe('1993')
    expect(mapDate({ year: 99 })).toBeUndefined()
    expect(mapDate('1993')).toBeUndefined()
  })

  it('turns descriptions into plain text', () => {
    expect(
      plainText('<a href="spotify:artist:x">Radiohead</a> &amp; friends &#39;93 &#x263A;'),
    ).toBe("Radiohead & friends '93 ☺")
    expect(plainText('One<br>Two\r\n\r\n\n\nThree   \nFour')).toBe('One\nTwo\n\nThree\nFour')
    expect(plainText('&bogus; &#0;')).toBe('&bogus;')
    expect(plainText('<b></b>')).toBeUndefined()
    expect(plainText(42)).toBeUndefined()
  })

  it('keeps https images once, largest first', () => {
    expect(
      mapArtwork([
        { url: 'https://i.scdn.co/a', width: 64, height: 64 },
        { url: 'http://insecure/b', width: 640 },
        { url: 'https://i.scdn.co/c', width: null, height: null },
        { url: 'https://i.scdn.co/a', width: 64 },
        { url: 'https://i.scdn.co/d', width: 300, height: 300 },
      ]),
    ).toEqual([
      { url: 'https://i.scdn.co/d', width: 300, height: 300 },
      { url: 'https://i.scdn.co/a', width: 64, height: 64 },
      { url: 'https://i.scdn.co/c' },
    ])
    expect(mapArtwork(undefined)).toEqual([])
  })

  it('pages without a total by whether the page was full', () => {
    expect(pageOf([1, 2], 0, 2)).toEqual({ items: [1, 2], nextCursor: '2' })
    expect(pageOf([1], 0, 2)).toEqual({ items: [1] })
    expect(pageOf([], 4, 2, 4)).toEqual({ items: [], total: 4 })
  })

  it('reports what a union holds instead of the expected type', () => {
    expect(unionOf(fixtures.getTrack.data.trackUnion, 'Track')).toEqual({ found: true })
    expect(unionOf(fixtures.errorNotFound.data.trackUnion, 'Track')).toEqual({
      found: false,
      typename: 'NotFound',
      message: "Object with uri 'spotify:track:0000000000000000000000' not found",
    })
    expect(unionOf(undefined, 'Track')).toEqual({ found: false, typename: 'missing' })
  })
})
