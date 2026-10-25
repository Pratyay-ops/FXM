import { describe, expect, expectTypeOf, it } from 'vitest'
import { type EntityId, formatId } from './ids'
import {
  applyModeFilter,
  CATALOG_MODE_LABELS,
  CATALOG_MODES,
  type CatalogMode,
  DEFAULT_CATALOG_MODE,
  filterPlayable,
  isCatalogMode,
  isPlayable,
  isVideoKind,
  type ModeInput,
  type ModeVerdict,
  modePolicy,
  songForVideo,
} from './mode'
import type { Track, TrackKind } from './model'
import type { AudioCandidate } from './providers'

const KINDS = ['song', 'music-video', 'video', 'episode'] as const satisfies readonly TrackKind[]

/** The song of an official video, as a YouTube Music album page links them. */
const SONG_ID = formatId('ytm', 'track', 'song1')

/** An official music video whose source links its song. */
const LINKED_VIDEO = { kind: 'music-video', songId: SONG_ID } as const

describe('modePolicy', () => {
  const table: ReadonlyArray<readonly [TrackKind, CatalogMode, ModeVerdict]> = [
    ['song', 'music', 'playable'],
    ['music-video', 'music', 'needs-song-match'],
    ['video', 'music', 'hidden'],
    ['episode', 'music', 'hidden'],
    ['song', 'all', 'playable'],
    ['music-video', 'all', 'playable'],
    ['video', 'all', 'playable'],
    ['episode', 'all', 'hidden'],
  ]

  it.each(table)('a %s without a song link in %s mode is %s', (kind, mode, verdict) => {
    expect(modePolicy({ kind }, mode)).toBe(verdict)
  })

  it('covers every kind in every mode', () => {
    expect(table).toHaveLength(KINDS.length * CATALOG_MODES.length)
    for (const kind of KINDS) {
      for (const mode of CATALOG_MODES) {
        expect(table.some(([k, m]) => k === kind && m === mode)).toBe(true)
      }
    }
  })

  it.each([
    ['music', 'plays-linked-song'],
    ['all', 'playable'],
  ] as const)('a music video with a song link in %s mode is %s', (mode, verdict) => {
    expect(modePolicy(LINKED_VIDEO, mode)).toBe(verdict)
  })

  it('ignores a song link on any other kind', () => {
    for (const kind of ['song', 'video', 'episode'] as const) {
      for (const mode of CATALOG_MODES) {
        expect(modePolicy({ kind, songId: SONG_ID }, mode)).toBe(modePolicy({ kind }, mode))
      }
    }
  })

  it('fails closed on bad data', () => {
    expect(modePolicy({ kind: 'podcast' as TrackKind }, 'all')).toBe('hidden')
    expect(modePolicy({ kind: 'video' }, 'everything' as CatalogMode)).toBe('hidden')
    expect(modePolicy({ kind: 'song' }, 'everything' as CatalogMode)).toBe('playable')
    expect(modePolicy({ kind: 'music-video' }, 'everything' as CatalogMode)).toBe(
      'needs-song-match',
    )
    expect(modePolicy(LINKED_VIDEO, 'everything' as CatalogMode)).toBe('plays-linked-song')
  })

  it.each([
    ['an empty string', ''],
    ['a bare videoId', 'song1'],
    ['an album ID', 'ytm:album:MPREb_abc'],
    ['an ID of a removed source', 'jiosaavn:track:abc'],
    ['a number', 42],
    ['null', null],
    ['an object', { id: 'ytm:track:song1' }],
  ])('treats a song link that is %s as none', (_label, songId) => {
    const video = { kind: 'music-video', songId } as unknown as ModeInput
    expect(songForVideo(video)).toBeUndefined()
    expect(modePolicy(video, 'music')).toBe('needs-song-match')
    expect(modePolicy(video, 'all')).toBe('playable')
  })

  const inherited = ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']

  it.each(inherited)('hides a track whose kind is the inherited name %j', (name) => {
    for (const mode of CATALOG_MODES) {
      expect(modePolicy({ kind: name as TrackKind }, mode)).toBe('hidden')
      expect(modePolicy({ kind: name as TrackKind, songId: SONG_ID }, mode)).toBe('hidden')
    }
  })

  it.each(inherited)('applies the Music rules to the inherited mode name %j', (name) => {
    for (const kind of KINDS) {
      expect(modePolicy({ kind }, name as CatalogMode)).toBe(modePolicy({ kind }, 'music'))
    }
  })
})

describe('songForVideo', () => {
  it('returns the song a music video links to', () => {
    expect(songForVideo(LINKED_VIDEO)).toBe(SONG_ID)
    expectTypeOf(songForVideo).returns.toEqualTypeOf<EntityId<'track'> | undefined>()
  })

  it('returns undefined for a music video without a link', () => {
    expect(songForVideo({ kind: 'music-video' })).toBeUndefined()
  })

  it.each(['song', 'video', 'episode'] as const)(
    'returns undefined for a %s, even with a link',
    (kind) => {
      expect(songForVideo({ kind, songId: SONG_ID })).toBeUndefined()
    },
  )

  it('takes a link to a song from another source', () => {
    const spotifySong = formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC')
    expect(songForVideo({ kind: 'music-video', songId: spotifySong })).toBe(spotifySong)
  })

  it.each([
    ['its own ID', 'ytm', 'ytm'],
    ['its videoId under the yt prefix', 'ytm', 'yt'],
    ['its videoId under the ytm prefix', 'yt', 'ytm'],
    ['its own plain YouTube ID', 'yt', 'yt'],
  ] as const)('ignores a link to the video itself: %s', (_label, source, linkSource) => {
    const video = {
      id: formatId(source, 'track', 'omv1'),
      kind: 'music-video',
      songId: formatId(linkSource, 'track', 'omv1'),
    } as const
    expect(songForVideo(video)).toBeUndefined()
    expect(modePolicy(video, 'music')).toBe('needs-song-match')
    expect(modePolicy(video, 'all')).toBe('playable')
    expect(applyModeFilter([video], 'music')).toEqual([video])
    expect(filterPlayable([video], 'music')).toEqual([])
  })

  it('keeps a link from a video with its own ID to another videoId', () => {
    const video = { id: formatId('yt', 'track', 'omv1'), kind: 'music-video' } as const
    expect(songForVideo({ ...video, songId: SONG_ID })).toBe(SONG_ID)
    expect(modePolicy({ ...video, songId: SONG_ID }, 'music')).toBe('plays-linked-song')
  })

  it.each([
    ['a bare videoId', 'omv1'],
    ['an album ID', 'ytm:album:MPREb_abc'],
    ['an ID of a removed source', 'jiosaavn:track:omv1'],
    ['a number', 42],
    ['null', null],
  ])('voids the link of a video whose own ID is %s, which cannot be compared', (_label, id) => {
    const video = { id, kind: 'music-video', songId: SONG_ID } as unknown as ModeInput
    expect(songForVideo(video)).toBeUndefined()
    expect(modePolicy(video, 'music')).toBe('needs-song-match')
  })

  it('reads whole tracks, audio candidates and bare kinds alike', () => {
    expectTypeOf<Track>().toExtend<ModeInput>()
    expectTypeOf<AudioCandidate>().toExtend<ModeInput>()
    expectTypeOf<{ readonly kind: 'song' }>().toExtend<ModeInput>()
    const albumId = formatId('ytm', 'album', 'MPREb_abc')
    // @ts-expect-error an item's own ID is a track ID
    const misnamed: ModeInput = { kind: 'music-video', id: albumId, songId: SONG_ID }
    expect(songForVideo(misnamed)).toBeUndefined()
  })

  it('reads whole tracks, so Music mode plays a linked video as its song', () => {
    const video: Track = {
      id: formatId('ytm', 'track', 'omv1'),
      source: 'ytm',
      title: 'Song (Official Video)',
      artists: [{ name: 'Artist' }],
      artwork: [],
      kind: 'music-video',
      songId: SONG_ID,
    }
    expect(modePolicy(video, 'music')).toBe('plays-linked-song')
    expect(songForVideo(video)).toBe(SONG_ID)
    expect(isPlayable(video, 'music')).toBe(false)
  })
})

describe('applyModeFilter', () => {
  const items = [
    { kind: 'video', ref: 'a' },
    { kind: 'song', ref: 'b' },
    { kind: 'episode', ref: 'c' },
    { kind: 'music-video', ref: 'd' },
    { kind: 'song', ref: 'e' },
    { kind: 'video', ref: 'f' },
    { kind: 'music-video', ref: 'g', songId: SONG_ID },
  ] as const

  it('keeps songs and music videos, linked or awaiting a match, in Music mode', () => {
    expect(applyModeFilter(items, 'music').map((item) => item.ref)).toEqual(['b', 'd', 'e', 'g'])
  })

  it('keeps everything but episodes in Music + Video mode, in order', () => {
    expect(applyModeFilter(items, 'all').map((item) => item.ref)).toEqual([
      'a',
      'b',
      'd',
      'e',
      'f',
      'g',
    ])
  })

  it('returns a new array and keeps the item type', () => {
    const input = [{ kind: 'song' as const, title: 'x' }]
    const output = applyModeFilter(input, 'music')
    expect(output).not.toBe(input)
    expect(output[0]?.title).toBe('x')
  })

  it('handles an empty list', () => {
    expect(applyModeFilter([], 'music')).toEqual([])
  })

  it('drops items whose kind is an inherited name', () => {
    const bad = [{ kind: 'toString' }, { kind: '__proto__' }, { kind: 'song' }] as const
    const kept = applyModeFilter(bad as unknown as ReadonlyArray<{ kind: TrackKind }>, 'music')
    expect(kept).toEqual([{ kind: 'song' }])
  })
})

describe('isPlayable and filterPlayable', () => {
  it.each([
    ['song', 'music', true],
    ['music-video', 'music', false],
    ['video', 'music', false],
    ['episode', 'music', false],
    ['song', 'all', true],
    ['music-video', 'all', true],
    ['video', 'all', true],
    ['episode', 'all', false],
  ] as const)('a %s in %s mode plays as it is: %s', (kind, mode, expected) => {
    expect(isPlayable({ kind }, mode)).toBe(expected)
    expect(isPlayable({ kind }, mode)).toBe(modePolicy({ kind }, mode) === 'playable')
  })

  it('plays a linked music video as it is only in Music + Video mode', () => {
    expect(isPlayable(LINKED_VIDEO, 'music')).toBe(false)
    expect(isPlayable(LINKED_VIDEO, 'all')).toBe(true)
  })

  it('drops music-video candidates in Music mode, which applyModeFilter keeps', () => {
    const candidates = [
      { kind: 'music-video', ref: 'omv' },
      { kind: 'music-video', ref: 'linked', songId: SONG_ID },
      { kind: 'song', ref: 'atv' },
      { kind: 'video', ref: 'ugc' },
    ] as const
    const refs = (list: ReadonlyArray<{ ref: string }>) => list.map((item) => item.ref)
    expect(refs(applyModeFilter(candidates, 'music'))).toEqual(['omv', 'linked', 'atv'])
    expect(refs(filterPlayable(candidates, 'music'))).toEqual(['atv'])
    expect(refs(filterPlayable(candidates, 'all'))).toEqual(['omv', 'linked', 'atv', 'ugc'])
  })

  it('returns a new array and fails closed on bad kinds', () => {
    const input = [{ kind: 'song' as TrackKind }, { kind: 'toString' as TrackKind }]
    const output = filterPlayable(input, 'all')
    expect(output).not.toBe(input)
    expect(output).toEqual([{ kind: 'song' }])
  })
})

describe('isVideoKind', () => {
  it.each([
    ['song', false],
    ['music-video', true],
    ['video', true],
    ['episode', false],
  ] as const)('%s is a video: %s', (kind, expected) => {
    expect(isVideoKind(kind)).toBe(expected)
  })
})

describe('catalog modes', () => {
  it('labels the modes for the UI', () => {
    expect(CATALOG_MODE_LABELS).toEqual({ music: 'Music', all: 'Music + Video' })
    expect(Object.isFrozen(CATALOG_MODE_LABELS)).toBe(true)
  })

  it('starts in Music mode', () => {
    expect(DEFAULT_CATALOG_MODE).toBe('music')
  })

  it.each([
    ['music', true],
    ['all', true],
    ['video', false],
    ['Music', false],
    ['', false],
    [undefined, false],
    [1, false],
  ])('isCatalogMode(%j) is %s', (value, expected) => {
    expect(isCatalogMode(value)).toBe(expected)
  })
})
