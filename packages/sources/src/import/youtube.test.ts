import {
  type EntityId,
  isFxmError,
  type MetadataProvider,
  type ProviderContext,
  type SearchOptions,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { song, testContext } from './testing'
import {
  createYouTubeImport,
  MATCH_SEARCH_LIMIT,
  YOUTUBE_IMPORT_UNAVAILABLE,
  type YouTubeImportProvider,
} from './youtube'

/** A provider that records its searches and answers with fixed pages. */
function provider(source: 'ytm' | 'yt') {
  const searches: { query: string; options: SearchOptions; mode: string }[] = []
  const tracks = [song(`${source}song00001`.slice(0, 11), 'Song', 'Band', { source })]
  const videos = [
    song(`${source}vide00001`.slice(0, 11), 'Video', 'Band', { source, kind: 'video' }),
  ]
  const result: YouTubeImportProvider & { searches: typeof searches } = {
    searches,
    async search(query: string, options: SearchOptions, ctx: ProviderContext) {
      searches.push({ query, options, mode: ctx.mode })
      return options.types.includes('track')
        ? { tracks: { items: tracks } }
        : { videos: { items: videos } }
    },
    async getPlaylist(id) {
      return { id, source, name: `${source} list`, artwork: [], tracks: { items: tracks } }
    },
    async getTrack(id) {
      return { ...tracks[0], id } as Awaited<ReturnType<MetadataProvider['getTrack']>>
    },
    async getPlaylistTracks() {
      return { items: videos }
    },
  }
  return result
}

describe('createYouTubeImport', () => {
  it('answers the engine’s searches from YouTube Music, in the right mode', async () => {
    const music = provider('ytm')
    const video = provider('yt')
    const youtube = createYouTubeImport({ music, video })
    const ctx = testContext('music')
    await expect(
      youtube.fetchMatchPage({ kind: 'isrc-songs', query: 'GBAYE9200070', attempt: 1 }, ctx),
    ).resolves.toMatchObject({
      kind: 'isrc-songs',
      tracks: [{ title: 'Song' }],
    })
    await youtube.fetchMatchPage({ kind: 'text-songs', query: 'Band Song' }, ctx)
    await youtube.fetchMatchPage({ kind: 'album-songs', query: 'Band Song Album' }, ctx)
    await expect(
      youtube.fetchMatchPage({ kind: 'videos', query: 'Band Song' }, ctx),
    ).resolves.toMatchObject({
      kind: 'videos',
      tracks: [{ title: 'Video' }],
    })
    await youtube.fetchMatchPage({ kind: 'youtube', query: 'Band - Song' }, ctx)
    expect(music.searches.map(({ options, mode }) => [options.types, options.limit, mode])).toEqual(
      [
        [['track'], MATCH_SEARCH_LIMIT, 'music'],
        [['track'], MATCH_SEARCH_LIMIT, 'music'],
        [['track'], MATCH_SEARCH_LIMIT, 'music'],
        [['video'], MATCH_SEARCH_LIMIT, 'all'],
      ],
    )
    expect(video.searches.map(({ query, mode }) => [query, mode])).toEqual([['Band - Song', 'all']])
  })

  it('answers null for pages it has no source for', async () => {
    const youtube = createYouTubeImport({ music: provider('ytm') })
    const ctx = testContext()
    expect(await youtube.fetchMatchPage({ kind: 'isrc-top-card', query: 'X' }, ctx)).toBeNull()
    expect(
      await youtube.fetchMatchPage(
        { kind: 'release-facts', trackIds: ['ytm:track:aaaaaaaaaaa' as EntityId<'track'>] },
        ctx,
      ),
    ).toBeNull()
    expect(await youtube.fetchMatchPage({ kind: 'youtube', query: 'X' }, ctx)).toBeNull()
  })

  it('uses the top-result card and the release facts when given', async () => {
    const card = song('cardcardcar', 'Card', 'Band')
    const youtube = createYouTubeImport({
      music: provider('ytm'),
      topResult: async () => card,
      releaseFacts: async (ids) => Object.fromEntries(ids.map((id) => [id, { label: 'Label' }])),
    })
    const ctx = testContext()
    expect(await youtube.fetchMatchPage({ kind: 'isrc-top-card', query: 'X' }, ctx)).toEqual({
      kind: 'isrc-top-card',
      card,
    })
    expect(
      await youtube.fetchMatchPage(
        { kind: 'release-facts', trackIds: ['ytm:track:aaaaaaaaaaa' as EntityId<'track'>] },
        ctx,
      ),
    ).toEqual({ kind: 'release-facts', facts: { 'ytm:track:aaaaaaaaaaa': { label: 'Label' } } })
  })

  it('reads playlists and tracks from the provider of their source', async () => {
    const youtube = createYouTubeImport({ music: provider('ytm'), video: provider('yt') })
    const ctx = testContext()
    expect((await youtube.getPlaylist('yt:playlist:PLa' as EntityId<'playlist'>, ctx)).name).toBe(
      'yt list',
    )
    expect((await youtube.getPlaylist('ytm:playlist:PLa' as EntityId<'playlist'>, ctx)).name).toBe(
      'ytm list',
    )
    const page = await youtube.getPlaylistTracks(
      'ytm:playlist:PLa' as EntityId<'playlist'>,
      { cursor: 'x' },
      ctx,
    )
    expect(page.items[0]?.title).toBe('Video')
    const withoutVideo = createYouTubeImport({ music: provider('ytm') })
    await expect(
      withoutVideo.getTrack('yt:track:aaaaaaaaaaa' as EntityId<'track'>, ctx),
    ).rejects.toSatisfy((error) => isFxmError(error, 'Unsupported'))
  })
})

describe('YOUTUBE_IMPORT_UNAVAILABLE', () => {
  it('refuses every call with Unsupported', async () => {
    const ctx = testContext()
    for (const call of [
      () => YOUTUBE_IMPORT_UNAVAILABLE.getPlaylist('ytm:playlist:PLa' as EntityId<'playlist'>, ctx),
      () =>
        YOUTUBE_IMPORT_UNAVAILABLE.getPlaylistTracks(
          'ytm:playlist:PLa' as EntityId<'playlist'>,
          {},
          ctx,
        ),
      () => YOUTUBE_IMPORT_UNAVAILABLE.getTrack('ytm:track:aaaaaaaaaaa' as EntityId<'track'>, ctx),
      () => YOUTUBE_IMPORT_UNAVAILABLE.fetchMatchPage({ kind: 'text-songs', query: 'x' }, ctx),
    ]) {
      await expect(call()).rejects.toSatisfy((error) => isFxmError(error, 'Unsupported'))
    }
  })
})
