import { applyModeFilter, type Track, type TrackKind } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { BUNDLED_YOUTUBE_CONFIG } from '../config'
import searchVideos from '../fixtures/search-videos.json'
import { kindOfMusicVideoType, MUSIC_VIDEO_TYPES } from './classify'
import { mapPanelVideo, mapResponsiveItem } from './items'
import { parseMusicSearch } from './search'

describe('classification by musicVideoType', () => {
  it.each<[string | undefined, TrackKind]>([
    ['MUSIC_VIDEO_TYPE_ATV', 'song'],
    ['MUSIC_VIDEO_TYPE_OMV', 'music-video'],
    ['MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC', 'music-video'],
    ['MUSIC_VIDEO_TYPE_UGC', 'video'],
    [undefined, 'video'],
    ['MUSIC_VIDEO_TYPE_SOMETHING_NEW', 'video'],
    ['MUSIC_VIDEO_TYPE_PODCAST_EPISODE', 'episode'],
  ])('%s is a %s', (type, kind) => {
    expect(kindOfMusicVideoType(type)).toBe(kind)
  })

  it('names the types it knows', () => {
    expect(Object.values(MUSIC_VIDEO_TYPES).map(kindOfMusicVideoType)).toEqual([
      'song',
      'music-video',
      'music-video',
      'video',
      'episode',
    ])
  })
})

/** A list row that plays `videoId` with `musicVideoType`, as YouTube Music sends them. */
function row(videoId: string, musicVideoType?: string, extra: Record<string, unknown> = {}) {
  const watch = {
    watchEndpoint: {
      videoId,
      ...(musicVideoType === undefined
        ? {}
        : { watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType } } }),
    },
  }
  return {
    flexColumns: [
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: { runs: [{ text: 'Title', navigationEndpoint: watch }] },
        },
      },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Someone' }] } } },
    ],
    overlay: {
      musicItemThumbnailOverlayRenderer: {
        content: { musicPlayButtonRenderer: { playNavigationEndpoint: watch } },
      },
    },
    ...extra,
  }
}

const ytm = { source: 'ytm' as const, config: BUNDLED_YOUTUBE_CONFIG }

describe('classifying list items', () => {
  it('reads the type of the row it plays, wherever the row carries it', () => {
    const kind = (renderer: Record<string, unknown>) => {
      const item = mapResponsiveItem(renderer, ytm)
      return item?.type === 'track' ? item.row.track.kind : undefined
    }
    expect(kind(row('aaaaaaaaaaa', 'MUSIC_VIDEO_TYPE_ATV'))).toBe('song')
    expect(kind(row('aaaaaaaaaaa', 'MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC'))).toBe('music-video')
    expect(kind(row('aaaaaaaaaaa'))).toBe('video')
    expect(kind(row('aaaaaaaaaaa', 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE'))).toBe('episode')
    const spoken = row('aaaaaaaaaaa', undefined, {
      navigationEndpoint: {
        browseEndpoint: {
          browseId: 'MPEDx',
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: {
              pageType: 'MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE',
            },
          },
        },
      },
    })
    expect(kind(spoken)).toBe('episode')
  })

  it('makes everything a video for plain YouTube', () => {
    const item = mapResponsiveItem(row('aaaaaaaaaaa', 'MUSIC_VIDEO_TYPE_ATV'), {
      ...ytm,
      source: 'yt',
      videosOnly: true,
    })
    expect(item?.type === 'track' && item.row.track).toMatchObject({
      id: 'yt:track:aaaaaaaaaaa',
      source: 'yt',
      kind: 'video',
    })
  })

  it('skips rows without a valid videoId or title', () => {
    expect(mapResponsiveItem(row('bad'), ytm)).toBeUndefined()
    expect(mapResponsiveItem({ flexColumns: [] }, ytm)).toBeUndefined()
    expect(
      mapPanelVideo({ playlistPanelVideoRenderer: { title: { runs: [{ text: 'x' }] } } }, ytm),
    ).toBeUndefined()
    expect(mapPanelVideo({ automixPreviewVideoRenderer: {} }, ytm)).toBeUndefined()
  })

  it('sorts a real video search into official videos and uploads, which Music mode hides', () => {
    const tracks = parseMusicSearch(searchVideos, ytm).items.flatMap((item) =>
      item.type === 'track' ? [item.row.track] : [],
    )
    const kinds = new Set(tracks.map((track) => track.kind))
    expect([...kinds].sort()).toEqual(['music-video', 'video'])
    expect(tracks[0]).toMatchObject({
      id: 'ytm:track:XFkzRNyygfk',
      kind: 'music-video',
      title: 'Creep',
    })
    const music: Track[] = applyModeFilter(tracks, 'music')
    expect(music.every((track) => track.kind === 'music-video')).toBe(true)
    expect(applyModeFilter(tracks, 'all')).toHaveLength(tracks.length)
  })
})
