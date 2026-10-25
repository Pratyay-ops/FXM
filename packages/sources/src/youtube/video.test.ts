import { formatId, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { BUNDLED_YOUTUBE_CONFIG } from './config'
import channelUploader from './fixtures/channel-uploader.json'
import nextUpload from './fixtures/next-upload.json'
import playlistBSides from './fixtures/playlist-b-sides.json'
import suggest from './fixtures/suggest.json'
import { context, endpointOf, fakeInnerTube, json, on, SIMPLE } from './fixtures/testing'
import webSearchChannels from './fixtures/web-search-channels.json'
import webSearchPlaylists from './fixtures/web-search-playlists.json'
import webSearchVideos from './fixtures/web-search-videos.json'
import { createYouTubeProviders } from './index'
import { createYouTubeVideoProvider } from './video'

const { web } = BUNDLED_YOUTUBE_CONFIG.search

function setup(mode: 'music' | 'all' = 'all') {
  const youtube = fakeInnerTube(
    on('search', { params: web.videos }, webSearchVideos),
    on('search', { params: web.channels }, webSearchChannels),
    on('search', { params: web.playlists }, webSearchPlaylists),
    (request) =>
      endpointOf(request) === 'search' && typeof request.body.continuation === 'string'
        ? json({ onResponseReceivedCommands: [] })
        : undefined,
    on('music/get_search_suggestions', {}, suggest),
    on('next', { videoId: 'vX8ISGJXa8s' }, nextUpload),
    on('browse', { browseId: 'UCBHyEuwczfD-exAYApo_g6w' }, channelUploader),
    on('browse', { browseId: 'VLPLNfe5eb0vdozpNx650kvCDhFjteIpW-L2' }, playlistBSides),
  )
  const video = createYouTubeVideoProvider()
  return { youtube, video, ctx: context(youtube.fetch, { mode, capabilities: SIMPLE }) }
}

describe('plain YouTube search', () => {
  it('finds videos through the WEB client, all of them videos with yt IDs', async () => {
    const { video, ctx, youtube } = setup('all')
    const { videos } = await video.search('Radiohead Creep', { types: ['video'] }, ctx)
    expect(youtube.requests[0]?.url.href).toBe(
      'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
    )
    expect(youtube.requests[0]?.body).toMatchObject({
      context: {
        client: { clientName: 'WEB', clientVersion: BUNDLED_YOUTUBE_CONFIG.clients.web.version },
      },
      query: 'Radiohead Creep',
      params: web.videos,
    })
    expect(videos?.items).toHaveLength(8)
    expect(videos?.items.every((track) => track.kind === 'video' && track.source === 'yt')).toBe(
      true,
    )
    expect(videos?.items[0]).toMatchObject({
      id: 'yt:track:XFkzRNyygfk',
      title: 'Radiohead - Creep',
      artists: [{ id: 'yt:artist:UCq19-LqvG35A-30oyAiPiqA', name: 'Radiohead' }],
      durationMs: 237_000,
    })
    expect(videos?.items[0]).not.toHaveProperty('album')
    expect(videos?.items[0]?.artwork[0]?.url).toMatch(/^https:\/\/i\.ytimg\.com\//)
    const more = await video.search(
      'Radiohead Creep',
      { types: ['video'], cursor: videos?.nextCursor ?? '' },
      ctx,
    )
    expect(more.videos).toEqual({ items: [] })
  })

  it('finds channels as artists and playlists with owner and size', async () => {
    const { video, ctx } = setup('all')
    const { artists, playlists } = await video.search(
      'Radiohead',
      { types: ['artist', 'playlist'] },
      ctx,
    )
    expect(artists?.items.slice(0, 2)).toMatchObject([
      { id: 'yt:artist:UCq19-LqvG35A-30oyAiPiqA', source: 'yt', name: 'Radiohead' },
      { id: 'yt:artist:UCr_iyUANcn9OX_yy9piYoLw', name: 'Radiohead - Topic' },
    ])
    expect(playlists?.items[0]).toMatchObject({
      id: 'yt:playlist:PLUwsfagaCki8ibIU--3oKGVXqhKhl3_SW',
      source: 'yt',
      name: 'Radiohead - Greatest Hits',
      owner: { name: 'Ali Aideel Ismail', id: 'UCdHX_1N1QgNP7Zn5JwMAGfA' },
      trackCount: 28,
    })
  })

  it('has no songs or albums, and nothing at all in Music mode, without asking YouTube', async () => {
    const all = setup('all')
    expect(await all.video.search('Radiohead', { types: ['track', 'album'] }, all.ctx)).toEqual({
      tracks: { items: [] },
      albums: { items: [] },
    })
    const music = setup('music')
    const types = ['track', 'video', 'album', 'artist', 'playlist'] as const
    expect(await music.video.search('Radiohead', { types }, music.ctx)).toEqual({
      tracks: { items: [] },
      videos: { items: [] },
      albums: { items: [] },
      artists: { items: [] },
      playlists: { items: [] },
    })
    expect([...all.youtube.requests, ...music.youtube.requests]).toEqual([])
  })

  it('suggests queries from YouTube Music', async () => {
    const { video, ctx } = setup()
    expect((await video.suggest('radioh', ctx))[0]).toBe('radiohead')
  })
})

describe('plain YouTube entities', () => {
  it('loads a video, as a video, whatever YouTube Music calls it', async () => {
    const { video, ctx } = setup()
    expect(await video.getTrack(formatId('yt', 'track', 'vX8ISGJXa8s'), ctx)).toMatchObject({
      id: 'yt:track:vX8ISGJXa8s',
      source: 'yt',
      kind: 'video',
      artists: [{ id: 'yt:artist:UCBHyEuwczfD-exAYApo_g6w', name: 'Abhi Nandan' }],
      durationMs: 258_000,
    })
  })

  it('has no albums, and says so without asking YouTube', async () => {
    const { video, ctx, youtube } = setup()
    await expect(
      video.getAlbum(formatId('yt', 'album', 'MPREb_DciERiuADkS'), ctx),
    ).rejects.toSatisfy((error) => isFxmError(error, 'Unsupported'))
    expect(youtube.requests).toEqual([])
  })

  it('loads a channel with its videos and no albums, all hidden in Music mode', async () => {
    const all = setup('all')
    const channel = await all.video.getArtist(
      formatId('yt', 'artist', 'UCBHyEuwczfD-exAYApo_g6w'),
      all.ctx,
    )
    expect(channel).toMatchObject({
      id: 'yt:artist:UCBHyEuwczfD-exAYApo_g6w',
      source: 'yt',
      name: 'Abhi Nandan',
    })
    expect(channel).not.toHaveProperty('albums')
    expect(channel.topTracks?.map((track) => [track.title, track.kind, track.source])).toEqual([
      ['SUBHASHREE (Audio)', 'video', 'yt'],
      ['Abhi Nandan - Bhag Chale (Official Video)', 'video', 'yt'],
      ['Abhi Nandan - Bhag Chale (Official Audio)', 'video', 'yt'],
      ['Boulevard of Broken Dreams - Hindi Edition | If Green Day was Indian', 'video', 'yt'],
    ])
    const music = setup('music')
    const hidden = await music.video.getArtist(
      formatId('yt', 'artist', 'UCBHyEuwczfD-exAYApo_g6w'),
      music.ctx,
    )
    expect(hidden.topTracks).toEqual([])
  })

  it('loads a playlist as videos', async () => {
    const { video, ctx } = setup('all')
    const playlist = await video.getPlaylist(
      formatId('yt', 'playlist', 'PLNfe5eb0vdozpNx650kvCDhFjteIpW-L2'),
      ctx,
    )
    expect(playlist).toMatchObject({
      id: 'yt:playlist:PLNfe5eb0vdozpNx650kvCDhFjteIpW-L2',
      source: 'yt',
    })
    expect(
      playlist.tracks?.items.every((track) => track.kind === 'video' && track.source === 'yt'),
    ).toBe(true)
    expect(playlist.tracks?.items.every((track) => track.album === undefined)).toBe(true)
  })
})

describe('both YouTube providers', () => {
  it('share one session, and so one visitorData', async () => {
    const { session, music, video } = createYouTubeProviders()
    expect(music.session).toBe(session)
    expect(video.session).toBe(session)
    expect([music.id, video.id]).toEqual(['ytm', 'yt'])
    const youtube = fakeInnerTube((request) =>
      json({
        ...webSearchVideos,
        responseContext: request.rawBody?.includes('visitorData')
          ? {}
          : { visitorData: 'CgtTaGFyZWRWaXNpdG9yKAE' },
      }),
    )
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    await video.search('a', { types: ['video'] }, ctx)
    await music.suggest('a', ctx).catch(() => [])
    expect(youtube.requests[1]?.rawBody).toContain('CgtTaGFyZWRWaXNpdG9yKAE')
  })
})
