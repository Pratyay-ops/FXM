import {
  type ArtistRef,
  type EntityId,
  formatId,
  isFxmError,
  modePolicy,
  parseId,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { BUNDLED_YOUTUBE_CONFIG } from './config'
import albumPabloHoney from './fixtures/album-pablo-honey.json'
import artistRadiohead from './fixtures/artist-radiohead.json'
import nextCreepSong from './fixtures/next-creep-song.json'
import nextCreepVideo from './fixtures/next-creep-video.json'
import nextWebCreep from './fixtures/next-web-creep.json'
import playlistBSides from './fixtures/playlist-b-sides.json'
import playlistOlak from './fixtures/playlist-olak-pablo-honey.json'
import playlistPopular from './fixtures/playlist-popular.json'
import playlistPopular2 from './fixtures/playlist-popular-2.json'
import radioArtist from './fixtures/radio-artist.json'
import radioCreep from './fixtures/radio-creep.json'
import radioCreep2 from './fixtures/radio-creep-2.json'
import searchAlbums from './fixtures/search-albums.json'
import searchArtists from './fixtures/search-artists.json'
import searchPlaylists from './fixtures/search-playlists.json'
import searchSongs from './fixtures/search-songs.json'
import searchSongs2 from './fixtures/search-songs-2.json'
import searchTop from './fixtures/search-top.json'
import searchVideos from './fixtures/search-videos.json'
import suggest from './fixtures/suggest.json'
import {
  context,
  endpointOf,
  fakeInnerTube,
  json,
  on,
  preflightReason,
  type Recorded,
  type Route,
  SIMPLE,
} from './fixtures/testing'
import { createYouTubeMusicProvider, linkSongs } from './music'
import type { TrackRow } from './parse/items'

const { search: params } = BUNDLED_YOUTUBE_CONFIG
const PABLO_HONEY = formatId('ytm', 'album', 'MPREb_DciERiuADkS')
const OLAK = 'OLAK5uy_lCl8VFn-xBO9PlDF2E0FXSjhaU0dLJP9I'
const RADIOHEAD = formatId('ytm', 'artist', 'UCr_iyUANcn9OX_yy9piYoLw')
const CREEP_SONG = formatId('ytm', 'track', 'zFYEYRcjK2g')
const CREEP_VIDEO = formatId('ytm', 'track', 'XFkzRNyygfk')

/** The client a request presents itself as, e.g. `WEB_REMIX`. */
function clientOf(request: Recorded): unknown {
  return (request.body.context as { client?: { clientName?: unknown } } | undefined)?.client
    ?.clientName
}

/** The fake YouTube Music every test talks to: each fixture answers its own request. */
const routes: Route[] = [
  (request) =>
    endpointOf(request) === 'search' &&
    typeof request.body.query === 'string' &&
    request.body.params === undefined
      ? json(searchTop)
      : undefined,
  (request) =>
    endpointOf(request) === 'next' && clientOf(request) === 'WEB' ? json(nextWebCreep) : undefined,
  on('search', { params: params.music.songs }, searchSongs),
  (request) =>
    endpointOf(request) === 'search' && typeof request.body.continuation === 'string'
      ? json(searchSongs2)
      : undefined,
  on('search', { params: params.music.videos }, searchVideos),
  on('search', { params: params.music.albums }, searchAlbums),
  on('search', { params: params.music.artists }, searchArtists),
  on('search', { params: params.music.playlists }, searchPlaylists),
  on('music/get_search_suggestions', {}, suggest),
  on('browse', { browseId: 'MPREb_DciERiuADkS' }, albumPabloHoney),
  on('browse', { browseId: `VL${OLAK}` }, playlistOlak),
  on('browse', { browseId: 'UCr_iyUANcn9OX_yy9piYoLw' }, artistRadiohead),
  on('browse', { browseId: 'VLPLNfe5eb0vdozpNx650kvCDhFjteIpW-L2' }, playlistBSides),
  on('browse', { browseId: 'VLPLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI' }, playlistPopular),
  (request) =>
    endpointOf(request) === 'browse' && typeof request.body.continuation === 'string'
      ? json(playlistPopular2)
      : undefined,
  on('next', { playlistId: 'RDAMVMzFYEYRcjK2g' }, radioCreep),
  on('next', { playlistId: 'RDEMk8jEIzOyB2trfXZrSEVz_Q' }, radioArtist),
  (request) =>
    endpointOf(request) === 'next' && typeof request.body.continuation === 'string'
      ? json(radioCreep2)
      : undefined,
  on('next', { videoId: 'zFYEYRcjK2g' }, nextCreepSong),
  on('next', { videoId: 'XFkzRNyygfk' }, nextCreepVideo),
]

function setup(mode: 'music' | 'all' = 'all') {
  const youtube = fakeInnerTube(...routes)
  const music = createYouTubeMusicProvider()
  return { youtube, music, ctx: context(youtube.fetch, { mode, capabilities: SIMPLE }) }
}

const videoId = (track: Track) => parseId(track.id).nativeId

describe('YouTube Music search', () => {
  it('finds songs only for the track type, with artists, album and duration', async () => {
    const { music, ctx, youtube } = setup('music')
    const { tracks, videos } = await music.search('  Radiohead Creep ', { types: ['track'] }, ctx)
    expect(videos).toBeUndefined()
    expect(tracks?.items).toHaveLength(10)
    expect(tracks?.items.every((track) => track.kind === 'song' && track.source === 'ytm')).toBe(
      true,
    )
    expect(tracks?.items[0]).toMatchObject({
      id: 'ytm:track:9RfVp-GhKfs',
      title: 'Creep',
      artists: [{ id: RADIOHEAD, name: 'Radiohead' }],
      album: { id: 'ytm:album:MPREb_TgQPwAzodvg', name: 'Creep' },
      durationMs: 239_000,
      explicit: true,
    })
    expect(tracks?.items[0]?.artwork.at(-1)).toMatchObject({ width: 544, height: 544 })
    expect(tracks?.nextCursor).toEqual(expect.any(String))
    expect(youtube.requests[0]?.body).toMatchObject({ query: 'Radiohead Creep' })
  })

  it('continues a type with its cursor, from YouTube’s next page', async () => {
    const { music, ctx, youtube } = setup()
    const first = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    const cursor = first.tracks?.nextCursor ?? ''
    const second = await music.search('Radiohead Creep', { types: ['track'], cursor }, ctx)
    expect(second.tracks?.items[3]).toMatchObject({
      id: 'ytm:track:IDB5rNDB4JY',
      title: 'Creep',
      artists: [{ name: 'Macy Gray' }],
      album: { name: 'Covered (Bonus Track Version)' },
      durationMs: 259_000,
    })
    expect(second.tracks?.items.some((track) => first.tracks?.items.includes(track))).toBe(false)
    expect(youtube.requests[1]?.body).toMatchObject({ continuation: expect.any(String) })
    expect(youtube.requests[1]?.body).not.toHaveProperty('query')
  })

  it('splits a page by the limit without losing items', async () => {
    const { music, ctx } = setup()
    const first = await music.search('Radiohead Creep', { types: ['track'], limit: 4 }, ctx)
    const second = await music.search(
      'Radiohead Creep',
      { types: ['track'], limit: 4, cursor: first.tracks?.nextCursor ?? '' },
      ctx,
    )
    const full = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    expect([...(first.tracks?.items ?? []), ...(second.tracks?.items ?? [])]).toEqual(
      full.tracks?.items.slice(0, 8),
    )
  })

  it('reads a YouTube page once for all the pages a limit splits it into', async () => {
    const { music, ctx, youtube } = setup()
    const ids: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const { tracks } = await music.search(
        'Radiohead Creep',
        { types: ['track'], limit: 3, ...(cursor === undefined ? {} : { cursor }) },
        ctx,
      )
      expect(tracks?.items).toHaveLength(3)
      ids.push(...(tracks?.items ?? []).map(videoId))
      cursor = tracks?.nextCursor
    }
    expect(new Set(ids).size).toBe(9)
    expect(youtube.requests).toHaveLength(1)
  })

  it('refuses a cursor of another search', async () => {
    const { music, ctx } = setup()
    const first = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    const cursor = first.tracks?.nextCursor ?? ''
    for (const [query, types] of [
      ['Radiohead', ['track']],
      ['Radiohead Creep', ['video']],
      ['Radiohead Creep', ['track', 'album']],
    ] as const) {
      await expect(music.search(query, { types, cursor }, ctx)).rejects.toSatisfy((error) =>
        isFxmError(error, 'NotFound'),
      )
    }
    await expect(
      music.search('x', { types: ['track'], cursor: 'garbage!' }, ctx),
    ).rejects.toSatisfy((error) => isFxmError(error, 'NotFound'))
  })

  it('finds official videos and uploads for the video type in Music + Video mode only', async () => {
    const all = setup('all')
    const { videos } = await all.music.search('Radiohead Creep', { types: ['video'] }, all.ctx)
    expect(videos?.items[0]).toMatchObject({ id: CREEP_VIDEO.toString(), kind: 'music-video' })
    expect(new Set(videos?.items.map((track) => track.kind))).toEqual(
      new Set(['music-video', 'video']),
    )
    const music = setup('music')
    const results = await music.music.search(
      'Radiohead Creep',
      { types: ['video', 'track'] },
      music.ctx,
    )
    expect(results.videos).toEqual({ items: [] })
    expect(music.youtube.requests.map((r) => r.body.params)).toEqual([params.music.songs])
  })

  it('finds albums with their type, artists and year, artists and playlists', async () => {
    const { music, ctx } = setup()
    const results = await music.search('Radiohead', { types: ['album', 'artist', 'playlist'] }, ctx)
    const albums = results.albums?.items ?? []
    expect(albums[0]).toMatchObject({
      id: 'ytm:album:MPREb_yXhSI4FCUo6',
      name: 'OK Computer',
      type: 'album',
      releaseDate: '1997',
      artists: [{ id: RADIOHEAD, name: 'Radiohead' }],
    })
    expect(albums.map((album) => album.type)).toEqual([
      'album',
      'album',
      'album',
      'ep',
      'album',
      'single',
    ])
    expect(results.artists?.items[0]).toMatchObject({ id: RADIOHEAD, name: 'Radiohead' })
    expect(results.artists?.nextCursor).toBeUndefined()
    expect(results.playlists?.items[2]).toMatchObject({
      id: 'ytm:playlist:PLNfe5eb0vdozpNx650kvCDhFjteIpW-L2',
      name: 'Radiohead B-Sides',
      owner: { name: 'Greenplastics', id: 'UCkjBRrNnCKdZqa06Nh7jhIw' },
    })
  })

  it('answers an empty query or no types without asking YouTube', async () => {
    const { music, ctx, youtube } = setup()
    expect(await music.search('  ', { types: ['track', 'album'] }, ctx)).toEqual({
      tracks: { items: [] },
      albums: { items: [] },
    })
    expect(await music.search('Radiohead', { types: [] }, ctx)).toEqual({})
    expect(await music.suggest(' ', ctx)).toEqual([])
    expect(youtube.requests).toEqual([])
  })

  it('suggests queries', async () => {
    const { music, ctx, youtube } = setup()
    expect(await music.suggest('radioh', ctx)).toEqual([
      'radiohead',
      'radiohead let down',
      'radiohead no surprises',
      'radiohead creep',
      'radiohead everything in its right place',
      'radiohead playlist',
    ])
    expect(youtube.requests[0]?.body).toMatchObject({ input: 'radioh' })
  })
})

describe('YouTube Music top results', () => {
  /** The unfiltered search fixture with its card's title linking `endpoint` instead. */
  function withCard(change: (card: CardJson) => void): unknown {
    const copy = structuredClone(searchTop) as unknown as SearchJson
    const card =
      copy.contents.tabbedSearchResultsRenderer.tabs[0]?.tabRenderer.content.sectionListRenderer
        .contents[0]?.musicCardShelfRenderer
    if (card === undefined) throw new Error('the fixture has no card')
    change(card)
    return copy
  }

  it('reads the card above the results of an unfiltered search', async () => {
    const { music, ctx, youtube } = setup('all')
    const top = await music.topResult('  Radiohead Creep ', ctx)
    expect(top).toMatchObject({
      type: 'track',
      track: {
        id: CREEP_VIDEO,
        kind: 'music-video',
        title: 'Creep',
        artists: [{ id: RADIOHEAD, name: 'Radiohead' }],
        durationMs: 237_000,
      },
    })
    expect(youtube.requests).toHaveLength(1)
    expect(youtube.requests[0]?.body).toMatchObject({ query: 'Radiohead Creep' })
    expect(youtube.requests[0]?.body).not.toHaveProperty('params')
  })

  it('keeps an official video in Music mode, for its song to be matched, and hides others', async () => {
    const music = setup('music')
    expect(await music.music.topResult('Radiohead Creep', music.ctx)).toMatchObject({
      type: 'track',
      track: { kind: 'music-video' },
    })
    expect(modePolicy({ kind: 'music-video' }, 'music')).toBe('needs-song-match')
    const upload = withCard((card) => {
      const config =
        card.title.runs[0]?.navigationEndpoint.watchEndpoint?.watchEndpointMusicSupportedConfigs
          ?.watchEndpointMusicConfig
      if (config) config.musicVideoType = 'MUSIC_VIDEO_TYPE_UGC'
    })
    for (const mode of ['music', 'all'] as const) {
      const youtube = fakeInnerTube(on('search', { query: 'x' }, upload))
      const provider = createYouTubeMusicProvider()
      const top = await provider.topResult(
        'x',
        context(youtube.fetch, { mode, capabilities: SIMPLE }),
      )
      expect(top?.type === 'track' ? top.track.kind : top).toBe(
        mode === 'music' ? undefined : 'video',
      )
    }
  })

  it('reads an artist card by the page its title links to', async () => {
    const artist = withCard((card) => {
      const run = card.title.runs[0]
      if (run) {
        run.text = 'Radiohead'
        run.navigationEndpoint = {
          browseEndpoint: {
            browseId: 'UCr_iyUANcn9OX_yy9piYoLw',
            browseEndpointContextSupportedConfigs: {
              browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' },
            },
          },
        }
      }
    })
    const youtube = fakeInnerTube(on('search', { query: 'Radiohead' }, artist))
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { mode: 'music', capabilities: SIMPLE })
    expect(await music.topResult('Radiohead', ctx)).toMatchObject({
      type: 'artist',
      artist: { id: RADIOHEAD, name: 'Radiohead' },
    })
  })

  it('has none for an empty query, without asking YouTube, nor for an answer without a card', async () => {
    const { music, ctx, youtube } = setup()
    expect(await music.topResult('  ', ctx)).toBeUndefined()
    expect(youtube.requests).toEqual([])
    const cardless = withCard(() => {}) as SearchJson
    cardless.contents.tabbedSearchResultsRenderer.tabs[0]?.tabRenderer.content.sectionListRenderer.contents.shift()
    const empty = fakeInnerTube(on('search', { query: 'x' }, cardless))
    const provider = createYouTubeMusicProvider()
    expect(
      await provider.topResult('x', context(empty.fetch, { capabilities: SIMPLE })),
    ).toBeUndefined()
  })
})

describe('YouTube Music descriptions', () => {
  it('reads a song’s label and release date from its plain YouTube watch page', async () => {
    const { music, ctx, youtube } = setup('music')
    const description = await music.getDescription(CREEP_SONG, ctx)
    expect(description).toMatch(/^Provided to YouTube by Beggars Group Digital Ltd\./)
    expect(description).toContain('℗ 1992 XL Recordings Ltd')
    expect(description).toContain('Released on: 1993-02-22')
    expect(youtube.requests[0]?.url.href).toBe(
      'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
    )
    expect(youtube.requests[0]?.body).toMatchObject({
      context: { client: { clientName: 'WEB' } },
      videoId: 'zFYEYRcjK2g',
    })
  })

  it('has none when the watch page shows none', async () => {
    const youtube = fakeInnerTube(
      on('next', {}, { contents: { twoColumnWatchNextResults: { results: { results: {} } } } }),
    )
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    expect(await music.getDescription(formatId('ytm', 'track', 'aaaaaaaaaaa'), ctx)).toBeUndefined()
  })
})

interface CardJson {
  title: {
    runs: {
      text: string
      navigationEndpoint: {
        watchEndpoint?: {
          watchEndpointMusicSupportedConfigs?: {
            watchEndpointMusicConfig?: { musicVideoType?: string }
          }
        }
        browseEndpoint?: unknown
      }
    }[]
  }
}

interface SearchJson {
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: {
        tabRenderer: {
          content: { sectionListRenderer: { contents: { musicCardShelfRenderer?: CardJson }[] } }
        }
      }[]
    }
  }
}

describe('YouTube Music tracks', () => {
  it('loads a song with its album and year from next', async () => {
    const { music, ctx, youtube } = setup('music')
    expect(await music.getTrack(CREEP_SONG, ctx)).toMatchObject({
      id: CREEP_SONG,
      kind: 'song',
      title: 'Creep',
      artists: [{ id: RADIOHEAD, name: 'Radiohead' }],
      album: { id: PABLO_HONEY, name: 'Pablo Honey' },
      durationMs: 239_000,
      releaseDate: '1993',
    })
    expect(youtube.requests[0]?.url.pathname).toBe('/youtubei/v1/next')
  })

  it('loads an official video as a music video, without a song link it cannot know', async () => {
    const { music, ctx } = setup()
    const video = await music.getTrack(formatId('yt', 'track', 'XFkzRNyygfk'), ctx)
    expect(video).toMatchObject({ id: CREEP_VIDEO, kind: 'music-video', durationMs: 237_000 })
    expect(video).not.toHaveProperty('songId')
    expect(modePolicy(video, 'music')).toBe('needs-song-match')
  })
})

describe('YouTube Music albums', () => {
  it('takes the tracks from the audio playlist in Music mode: the songs, not the videos', async () => {
    const { music, ctx, youtube } = setup('music')
    const album = await music.getAlbum(PABLO_HONEY, ctx)
    expect(album).toMatchObject({
      id: PABLO_HONEY,
      name: 'Pablo Honey',
      artists: [{ id: RADIOHEAD, name: 'Radiohead' }],
      type: 'album',
      releaseDate: '1993',
      trackCount: 12,
    })
    expect(youtube.requests.map((request) => request.body.browseId)).toEqual([
      'MPREb_DciERiuADkS',
      `VL${OLAK}`,
    ])
    const tracks = album.tracks ?? []
    expect(tracks).toHaveLength(12)
    expect(tracks.every((track) => track.kind === 'song')).toBe(true)
    expect(tracks[1]).toMatchObject({
      id: CREEP_SONG,
      title: 'Creep',
      trackNumber: 2,
      album: { id: PABLO_HONEY, name: 'Pablo Honey' },
      artists: [{ id: RADIOHEAD }],
    })
    expect(tracks.map((track) => track.trackNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ])
  })

  it('keeps the album page’s rows in Music + Video mode, linking the official video to its song', async () => {
    const { music, ctx, youtube } = setup('all')
    const album = await music.getAlbum(PABLO_HONEY, ctx)
    expect(youtube.requests).toHaveLength(1)
    const tracks = album.tracks ?? []
    expect(tracks).toHaveLength(12)
    expect(tracks[1]).toMatchObject({
      id: CREEP_VIDEO,
      kind: 'music-video',
      songId: CREEP_SONG,
      trackNumber: 2,
    })
    expect(tracks.filter((track) => track.songId !== undefined)).toHaveLength(1)
    expect(modePolicy(tracks[1] as Track, 'music')).toBe('plays-linked-song')
  })

  it('reads the audio playlist in Music + Video mode only when a video lacks its credits link', async () => {
    const youtube = fakeInnerTube(
      on('browse', { browseId: 'MPREb_DciERiuADkS' }, withoutCreepCredits()),
      ...routes,
    )
    const music = createYouTubeMusicProvider()
    const album = await music.getAlbum(
      PABLO_HONEY,
      context(youtube.fetch, { mode: 'all', capabilities: SIMPLE }),
    )
    expect(youtube.requests).toHaveLength(2)
    expect(album.tracks?.[1]).toMatchObject({ id: CREEP_VIDEO, songId: CREEP_SONG })
  })

  it('falls back to the album page’s rows when its audio playlist cannot be read', async () => {
    for (const mode of ['music', 'all'] as const) {
      const page = mode === 'music' ? albumPabloHoney : withoutCreepCredits()
      const youtube = fakeInnerTube(
        on('browse', { browseId: `VL${OLAK}` }, { error: { message: 'boom' } }, { status: 500 }),
        on('browse', { browseId: 'MPREb_DciERiuADkS' }, page),
      )
      const music = createYouTubeMusicProvider()
      const album = await music.getAlbum(
        PABLO_HONEY,
        context(youtube.fetch, { mode, capabilities: SIMPLE }),
      )
      expect(youtube.requests.map((request) => request.body.browseId)).toEqual([
        'MPREb_DciERiuADkS',
        `VL${OLAK}`,
      ])
      expect(album.tracks).toHaveLength(12)
      const creep = album.tracks?.[1] as Track
      expect(creep).toMatchObject({ id: CREEP_VIDEO, kind: 'music-video', trackNumber: 2 })
      if (mode === 'music') {
        // The row's credits item still links the song, so Music mode plays it.
        expect(modePolicy(creep, 'music')).toBe('plays-linked-song')
      } else {
        expect(creep).not.toHaveProperty('songId')
        expect(modePolicy(creep, 'music')).toBe('needs-song-match')
      }
    }
  })

  it('still fails when reading the audio playlist meets a bot check or a rate limit', async () => {
    for (const [route, code] of [
      [
        on(
          'browse',
          { browseId: `VL${OLAK}` },
          { playabilityStatus: { status: 'LOGIN_REQUIRED' } },
        ),
        'BotCheck',
      ],
      [on('browse', { browseId: `VL${OLAK}` }, {}, { status: 429 }), 'RateLimited'],
    ] as const) {
      const youtube = fakeInnerTube(route, ...routes)
      const music = createYouTubeMusicProvider()
      await expect(
        music.getAlbum(
          PABLO_HONEY,
          context(youtube.fetch, { mode: 'music', capabilities: SIMPLE }),
        ),
      ).rejects.toSatisfy((error) => isFxmError(error, code))
    }
  })

  it('falls back to the album page in Music mode when it names no audio playlist', async () => {
    const noPlaylist = JSON.parse(
      JSON.stringify(albumPabloHoney).replaceAll(OLAK, 'RDAMPLx'),
    ) as unknown
    const youtube = fakeInnerTube(on('browse', { browseId: 'MPREb_DciERiuADkS' }, noPlaylist))
    const music = createYouTubeMusicProvider()
    const album = await music.getAlbum(
      PABLO_HONEY,
      context(youtube.fetch, { mode: 'music', capabilities: SIMPLE }),
    )
    expect(youtube.requests).toHaveLength(1)
    expect(album.tracks?.[1]).toMatchObject({ id: CREEP_VIDEO, songId: CREEP_SONG })
    expect(album.tracks?.map((track) => modePolicy(track, 'music'))).toContain('plays-linked-song')
  })
})

interface AlbumJson {
  contents: {
    twoColumnBrowseResultsRenderer: {
      secondaryContents: {
        sectionListRenderer: {
          contents: {
            musicShelfRenderer?: {
              contents: { musicResponsiveListItemRenderer?: { menu?: unknown } }[]
            }
          }[]
        }
      }
    }
  }
}

function shelfRows(album: AlbumJson) {
  return (
    album.contents.twoColumnBrowseResultsRenderer.secondaryContents.sectionListRenderer.contents[0]
      ?.musicShelfRenderer?.contents ?? []
  )
}

/** Pablo Honey's album page without the credits item of Creep's row, its official video. */
function withoutCreepCredits(): AlbumJson {
  const page = structuredClone(albumPabloHoney) as unknown as AlbumJson
  const creep = shelfRows(page)[1]?.musicResponsiveListItemRenderer
  if (creep) delete creep.menu
  return page
}

describe('pairing official videos with their songs (MPTC)', () => {
  const track = (id: string, kind: Track['kind']): Track => ({
    id: formatId('ytm', 'track', id),
    source: 'ytm',
    title: id,
    artists: [],
    artwork: [],
    kind,
  })
  const row = (id: string, kind: Track['kind'], credits?: string): TrackRow => ({
    track: track(id, kind),
    ...(credits === undefined ? {} : { credits }),
  })
  const songs = [row('song0000001', 'song'), row('song0000002', 'song'), row('song0000003', 'song')]

  it('links a video to the song its credits item names', () => {
    const linked = linkSongs(
      [row('song0000001', 'song', 'song0000001'), row('video000002', 'music-video', 'song0000002')],
      [],
    )
    expect(linked[0]?.track).not.toHaveProperty('songId')
    expect(linked[1]?.track.songId).toBe('ytm:track:song0000002')
  })

  it('falls back to the song at the same position when the lists line up', () => {
    const rows = [
      row('song0000001', 'song'),
      row('video000002', 'music-video'),
      row('song0000003', 'song'),
    ]
    expect(linkSongs(rows, songs)[1]?.track.songId).toBe('ytm:track:song0000002')
    expect(linkSongs(rows, songs.slice(0, 2))[1]?.track).not.toHaveProperty('songId')
  })

  it('prefers the credits item, and never links a video to itself', () => {
    const rows = [
      row('song0000001', 'song'),
      row('video000002', 'music-video', 'other000002'),
      row('song0000003', 'song'),
    ]
    expect(linkSongs(rows, songs)[1]?.track.songId).toBe('ytm:track:other000002')
    const self = [
      row('song0000001', 'song'),
      row('video000002', 'music-video', 'video000002'),
      row('song0000003', 'song'),
    ]
    expect(linkSongs(self, songs)[1]?.track.songId).toBe('ytm:track:song0000002')
    expect(
      linkSongs([row('video000002', 'music-video', 'video000002')], [])[0]?.track,
    ).not.toHaveProperty('songId')
  })

  it('links only official videos', () => {
    const rows = [
      row('upload00001', 'video', 'song0000001'),
      row('song0000002', 'song', 'song0000003'),
    ]
    expect(linkSongs(rows, songs.slice(0, 2)).map((r) => r.track.songId)).toEqual([
      undefined,
      undefined,
    ])
  })
})

describe('YouTube Music artists', () => {
  it('loads top songs, albums, singles and related artists', async () => {
    const { music, ctx } = setup('all')
    const artist = await music.getArtist(RADIOHEAD, ctx)
    expect(artist).toMatchObject({ id: RADIOHEAD, source: 'ytm', name: 'Radiohead' })
    expect(artist.description).toMatch(/^Radiohead are an English rock band/)
    expect(artist.artwork.length).toBeGreaterThan(0)
    expect(artist.topTracks?.map((track) => [track.title, track.kind])).toEqual([
      ['Creep', 'song'],
      ['No Surprises', 'song'],
      ['Let Down', 'song'],
      ['Karma Police', 'song'],
    ])
    expect(artist.albums?.map((album) => [album.name, album.type, album.releaseDate])).toEqual([
      ['KID A MNESIA', 'album', '2021'],
      ['A Moon Shaped Pool', 'album', '2016'],
      ['The King Of Limbs', 'album', '2011'],
      ['In Rainbows', 'album', '2007'],
      ['Follow Me Around', 'single', '2021'],
      ['If You Say the Word', 'single', '2021'],
      ['Ill Wind', 'single', '2019'],
      ['Daydreaming', 'single', '2016'],
    ])
    expect(artist.albums?.every((album) => album.artists[0]?.id === RADIOHEAD)).toBe(true)
    expect(artist.related?.map((related) => related.name)).toEqual([
      'Elliott Smith',
      'Portishead',
      'Massive Attack',
      'Thom Yorke',
    ])
    expect(artist.related?.some((related) => related.id === RADIOHEAD)).toBe(false)
  })
})

describe('YouTube Music playlists', () => {
  it('loads a playlist with its owner, count and tracks, in the mode', async () => {
    const all = setup('all')
    const id = formatId('ytm', 'playlist', 'PLNfe5eb0vdozpNx650kvCDhFjteIpW-L2')
    const playlist = await all.music.getPlaylist(id, all.ctx)
    expect(playlist).toMatchObject({
      id,
      name: 'Radiohead B-Sides',
      owner: { name: 'Greenplastics' },
      trackCount: 61,
    })
    expect(playlist.tracks?.items).toHaveLength(8)
    expect(playlist.tracks?.total).toBe(61)
    expect(playlist.tracks?.items.at(-1)).toMatchObject({ title: 'I Promise', kind: 'music-video' })
    const music = setup('music')
    const filtered = await music.music.getPlaylist(id, music.ctx)
    expect(filtered.tracks?.items.map((track) => track.kind)).toContain('music-video')
    expect(filtered.tracks?.items.every((track) => track.kind !== 'video')).toBe(true)
  })

  it('pages a long playlist with its cursor', async () => {
    const { music, ctx, youtube } = setup('all')
    const id = formatId('ytm', 'playlist', 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI')
    const playlist = await music.getPlaylist(id, ctx)
    expect(playlist).toMatchObject({ name: 'Popular Music Videos', trackCount: 182 })
    const cursor = playlist.tracks?.nextCursor ?? ''
    const next = await music.getPlaylistTracks(id, { cursor }, ctx)
    expect(next.items[0]).toMatchObject({
      title: 'Holy Night / Cantique de Noël (The Chosen Performance)',
    })
    expect(next.items[0]?.artists.map((artist) => artist.name)).toEqual([
      'Virginia Bocelli',
      'Matteo Bocelli',
      'Andrea Bocelli',
    ])
    expect(next.nextCursor).toBeUndefined()
    expect(youtube.requests[1]?.body).toMatchObject({ continuation: expect.any(String) })
    await expect(
      music.getPlaylistTracks(formatId('ytm', 'playlist', 'PLother'), { cursor }, ctx),
    ).rejects.toSatisfy((error) => isFxmError(error, 'NotFound'))
  })

  it('loads the first page without a cursor, and splits pages by the limit', async () => {
    const { music, ctx, youtube } = setup('all')
    const id = formatId('ytm', 'playlist', 'PLNfe5eb0vdozpNx650kvCDhFjteIpW-L2')
    const first = await music.getPlaylistTracks(id, { limit: 5 }, ctx)
    const rest = await music.getPlaylistTracks(
      id,
      { limit: 5, cursor: first.nextCursor ?? '' },
      ctx,
    )
    expect([...first.items, ...rest.items]).toHaveLength(8)
    expect(rest.nextCursor).toBeUndefined()
    expect(youtube.requests).toHaveLength(1)
  })

  it('names an album’s audio playlist after the album', async () => {
    const { music, ctx } = setup('music')
    const playlist = await music.getPlaylist(formatId('ytm', 'playlist', OLAK), ctx)
    expect(playlist).toMatchObject({ name: 'Pablo Honey', trackCount: 12 })
    expect(playlist.tracks?.items.every((track) => track.kind === 'song')).toBe(true)
  })
})

describe('YouTube Music radio', () => {
  it('starts from the song with RDAMVM and returns only new songs in Music mode', async () => {
    const { music, ctx, youtube } = setup('music')
    const song = await music.getTrack(CREEP_SONG, ctx)
    const page = await music.radioPage(song, {}, ctx)
    expect(youtube.requests[1]?.body).toMatchObject({
      videoId: 'zFYEYRcjK2g',
      playlistId: 'RDAMVMzFYEYRcjK2g',
      params: BUNDLED_YOUTUBE_CONFIG.radio.params,
    })
    expect(youtube.requests.every((request) => preflightReason(request) === undefined)).toBe(true)
    expect(page.items.length).toBe(11)
    expect(page.items.map(videoId)).not.toContain('zFYEYRcjK2g')
    expect(page.items.every((track) => track.kind === 'song')).toBe(true)
    expect(new Set(page.items.map(videoId)).size).toBe(page.items.length)
    expect(await music.radio(song, ctx)).toEqual(page.items)
  })

  it('pages on with its cursor, never repeating a track', async () => {
    const { music, ctx } = setup('music')
    const song = await music.getTrack(CREEP_SONG, ctx)
    const first = await music.radioPage(song, {}, ctx)
    const second = await music.radioPage(song, { cursor: first.nextCursor ?? '' }, ctx)
    expect(second.items.length).toBeGreaterThan(0)
    const firstIds = new Set(first.items.map(videoId))
    expect(second.items.some((track) => firstIds.has(videoId(track)))).toBe(false)
  })

  it('drops repeats that YouTube sends across pages', async () => {
    const repeated = structuredClone(radioCreep2) as unknown as {
      continuationContents: { playlistPanelContinuation: { contents: unknown[] } }
    }
    const firstPage = (radioCreep as unknown as RadioJson).contents
      .singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer
      .tabs[0]?.tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer.contents
    repeated.continuationContents.playlistPanelContinuation.contents.unshift(
      firstPage?.[1],
      firstPage?.[0],
    )
    const youtube = fakeInnerTube(
      (request) => (typeof request.body.continuation === 'string' ? json(repeated) : undefined),
      ...routes,
    )
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { mode: 'music', capabilities: SIMPLE })
    const song: Track = { ...(await music.getTrack(CREEP_SONG, ctx)) }
    const first = await music.radioPage(song, {}, ctx)
    const second = await music.radioPage(song, { cursor: first.nextCursor ?? '' }, ctx)
    const seen = new Set([...first.items.map(videoId), 'zFYEYRcjK2g'])
    expect(second.items.some((track) => seen.has(videoId(track)))).toBe(false)
    expect(second.items).toHaveLength(10)
  })

  it('starts from an official video’s linked song in Music mode', async () => {
    const { music, ctx, youtube } = setup('music')
    const video: Track = { ...(await music.getTrack(CREEP_VIDEO, ctx)), songId: CREEP_SONG }
    await music.radio(video, ctx)
    expect(youtube.requests[1]?.body).toMatchObject({ playlistId: 'RDAMVMzFYEYRcjK2g' })
  })

  it('splits a page by the limit without losing a track, reading each YouTube page once', async () => {
    const full = setup('music')
    const song = await full.music.getTrack(CREEP_SONG, full.ctx)
    const first = await full.music.radioPage(song, {}, full.ctx)
    const second = await full.music.radioPage(song, { cursor: first.nextCursor ?? '' }, full.ctx)
    const unlimited = [...first.items, ...second.items].map(videoId)
    expect(unlimited.length).toBeGreaterThan(12)

    const { music, ctx, youtube } = setup('music')
    const limited: string[] = []
    let cursor: string | undefined
    while (limited.length < unlimited.length) {
      const page = await music.radioPage(
        song,
        { limit: 3, ...(cursor === undefined ? {} : { cursor }) },
        ctx,
      )
      expect(page.items.length).toBeGreaterThan(0)
      expect(page.items.length).toBeLessThanOrEqual(3)
      limited.push(...page.items.map(videoId))
      cursor = page.nextCursor
      if (cursor === undefined) break
    }
    expect(limited).toEqual(unlimited)
    expect(youtube.requests.filter((request) => endpointOf(request) === 'next')).toHaveLength(2)
  })

  it('reads a split page again when it is no longer kept, still without losing a track', async () => {
    const { music, ctx } = setup('music')
    const song = await music.getTrack(CREEP_SONG, ctx)
    const all = await music.radioPage(song, {}, ctx)
    const first = await music.radioPage(song, { limit: 4 }, ctx)
    const other = setup('music')
    const rest = await other.music.radioPage(song, { cursor: first.nextCursor ?? '' }, other.ctx)
    expect([...first.items, ...rest.items].map(videoId)).toEqual(all.items.map(videoId))
    expect(other.youtube.requests.map((request) => request.body.playlistId)).toEqual([
      'RDAMVMzFYEYRcjK2g',
    ])
  })

  it('refuses seeds Music mode cannot start a song radio from, before any request', async () => {
    const { music, ctx, youtube } = setup('music')
    const base: Track = {
      id: CREEP_VIDEO,
      source: 'ytm',
      title: 'Creep',
      artists: [],
      artwork: [],
      kind: 'music-video',
    }
    for (const seed of [
      base,
      { ...base, kind: 'video' as const },
      { ...base, kind: 'episode' as const },
      {
        ...base,
        kind: 'song' as const,
        id: formatId('spotify', 'track', '6b2oQwSGFkzsMtQruIWm2p'),
      },
      { ...base, songId: formatId('spotify', 'track', '6b2oQwSGFkzsMtQruIWm2p') },
      {
        ...base,
        kind: 'song' as const,
        id: formatId('spotify', 'track', '6b2oQwSGFkzsMtQruIWm2p'),
        source: 'spotify' as const,
        externalIds: { yt: 'XFkzRNyygfk' },
      },
    ]) {
      await expect(music.radio(seed, ctx)).rejects.toSatisfy((error) =>
        isFxmError(error, 'Unsupported'),
      )
    }
    expect(youtube.requests).toEqual([])
  })

  it('takes a song from another source through its YouTube external ID', async () => {
    const { music, ctx, youtube } = setup('music')
    const spotify: Track = {
      id: formatId('spotify', 'track', '6b2oQwSGFkzsMtQruIWm2p'),
      source: 'spotify',
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      artwork: [],
      kind: 'song',
      externalIds: { ytm: 'zFYEYRcjK2g' },
    }
    await music.radio(spotify, ctx)
    expect(youtube.requests[0]?.body).toMatchObject({ videoId: 'zFYEYRcjK2g' })
    const video = fakeInnerTube(on('next', { playlistId: 'RDAMVMXFkzRNyygfk' }, radioCreep))
    const onlyVideo: Track = { ...spotify, externalIds: { yt: 'XFkzRNyygfk' } }
    await music.radio(onlyVideo, context(video.fetch, { mode: 'all', capabilities: SIMPLE }))
    expect(video.requests[0]?.body).toMatchObject({ videoId: 'XFkzRNyygfk' })
  })

  it('plays an official video’s own radio in Music + Video mode', async () => {
    const youtube = fakeInnerTube(on('next', { playlistId: 'RDAMVMXFkzRNyygfk' }, radioCreep))
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { mode: 'all', capabilities: SIMPLE })
    const video: Track = {
      id: CREEP_VIDEO,
      source: 'ytm',
      title: 'Creep',
      artists: [],
      artwork: [],
      kind: 'music-video',
    }
    const tracks = await music.radio(video, ctx)
    expect(tracks.length).toBeGreaterThan(0)
  })

  it('starts an artist’s radio from the Mix button of the artist page', async () => {
    const { music, ctx, youtube } = setup('music')
    const radiohead: ArtistRef = { id: RADIOHEAD, name: 'Radiohead' }
    const page = await music.radioPage(radiohead, {}, ctx)
    expect(youtube.requests.map((request) => endpointOf(request))).toEqual(['browse', 'next'])
    expect(youtube.requests[1]?.body).toMatchObject({
      videoId: 'xruauLm9u3k',
      playlistId: 'RDEMk8jEIzOyB2trfXZrSEVz_Q',
      params: 'wAEB',
    })
    expect(page.items[0]).toMatchObject({ title: '4 Minute Warning', kind: 'song' })
    expect(page.nextCursor).toEqual(expect.any(String))
    await expect(music.radio({ name: 'Nobody' }, ctx)).rejects.toSatisfy((error) =>
      isFxmError(error, 'Unsupported'),
    )
  })

  it('refuses a cursor of another radio, and limits a page', async () => {
    const { music, ctx } = setup('music')
    const song = await music.getTrack(CREEP_SONG, ctx)
    const page = await music.radioPage(song, { limit: 3 }, ctx)
    expect(page.items).toHaveLength(3)
    const other: Track = {
      ...song,
      id: formatId('ytm', 'track', '7374CZQoS2Y') as EntityId<'track'>,
    }
    await expect(music.radioPage(other, { cursor: page.nextCursor ?? '' }, ctx)).rejects.toSatisfy(
      (error) => isFxmError(error, 'NotFound'),
    )
  })
})

interface RadioJson {
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: {
            tabRenderer: {
              content: {
                musicQueueRenderer: { content: { playlistPanelRenderer: { contents: unknown[] } } }
              }
            }
          }[]
        }
      }
    }
  }
}
