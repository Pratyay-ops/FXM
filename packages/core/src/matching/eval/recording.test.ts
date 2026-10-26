import { describe, expect, it } from 'vitest'
import { formatId } from '../../ids'
import type { Track } from '../../model'
import type { MatchRequest } from '../types'
import {
  answerFromRecording,
  decodeItem,
  descriptionExcerpt,
  emptyRecording,
  encodeTrack,
  fileItems,
  isRecorded,
  pageKeys,
  pageKindOf,
  parsePageKey,
  recordedFacts,
  recordedTracks,
  videoIdOf,
  withoutIsrcCap,
} from './recording'
import { item, source } from './testing'

const track: Track = {
  id: formatId('ytm', 'track', 'abc123def45'),
  source: 'ytm',
  title: 'Song',
  artists: [{ name: 'Artist', id: formatId('ytm', 'artist', 'UC1') }],
  album: { name: 'LP', id: formatId('ytm', 'album', 'MPREb_lp') },
  durationMs: 200_000,
  artwork: [{ url: 'https://i.ytimg.com/x.jpg', width: 60, height: 60 }],
  explicit: true,
  kind: 'song',
  releaseDate: '2020',
}

describe('page keys', () => {
  const requests: Array<[MatchRequest, string[]]> = [
    [{ kind: 'isrc-songs', query: 'GBAYE9200070', attempt: 2 }, ['isrc-songs/2/GBAYE9200070']],
    [{ kind: 'isrc-top-card', query: 'GBAYE9200070' }, ['isrc-top-card/GBAYE9200070']],
    [{ kind: 'text-songs', query: 'Radiohead Creep' }, ['songs/Radiohead Creep']],
    [
      { kind: 'album-songs', query: 'Radiohead Creep Pablo Honey' },
      ['songs/Radiohead Creep Pablo Honey'],
    ],
    [{ kind: 'videos', query: 'Radiohead - Creep' }, ['videos/Radiohead - Creep']],
    [{ kind: 'youtube', query: 'Radiohead - Creep' }, ['youtube/Radiohead - Creep']],
    [
      {
        kind: 'release-facts',
        trackIds: [formatId('ytm', 'track', 'a'), formatId('yt', 'track', 'b')],
      },
      ['description/a', 'description/b'],
    ],
  ]

  it.each(requests)('files %j under its keys', (request, keys) => {
    expect(pageKeys(request)).toEqual(keys)
  })

  it('reads every key back', () => {
    expect(parsePageKey('isrc-songs/2/GBAYE9200070')).toEqual({
      kind: 'isrc-songs',
      attempt: 2,
      query: 'GBAYE9200070',
    })
    expect(parsePageKey('songs/AC/DC Back In Black')).toEqual({
      kind: 'songs',
      query: 'AC/DC Back In Black',
    })
    expect(parsePageKey('description/abc')).toEqual({ kind: 'description', videoId: 'abc' })
    expect(parsePageKey('isrc-top-card/X')).toEqual({ kind: 'isrc-top-card', query: 'X' })
    for (const bad of ['', 'songs/', 'nope/x', 'isrc-songs/x/y', 'songs']) {
      expect(parsePageKey(bad), bad).toBeUndefined()
    }
  })
})

describe('items', () => {
  it('keeps what the engine reads and drops the rest', () => {
    const stored = encodeTrack(track)
    expect(stored).toEqual({
      kind: 'song',
      title: 'Song',
      artists: ['Artist'],
      album: 'LP',
      albumId: 'MPREb_lp',
      durationMs: 200_000,
      explicit: true,
      releaseDate: '2020',
    })
    const back = decodeItem('abc123def45', stored ?? item('?', '?', 1))
    expect(back).toEqual({
      ...track,
      artists: [{ name: 'Artist' }],
      artwork: [],
    })
  })

  it('leaves out a clean mark and keeps a song link and a regular YouTube source', () => {
    const video: Track = {
      ...track,
      id: formatId('yt', 'track', 'vid'),
      source: 'yt',
      kind: 'music-video',
      explicit: false,
      songId: formatId('ytm', 'track', 'song'),
    }
    const stored = encodeTrack(video)
    expect(stored).toMatchObject({ kind: 'music-video', songId: 'song', source: 'yt' })
    expect(stored).not.toHaveProperty('explicit')
    expect(decodeItem('vid', stored ?? item('?', '?', 1)).id).toBe('yt:track:vid')
  })

  it('skips tracks of other sources', () => {
    const spotify: Track = { ...track, id: formatId('spotify', 'track', 'x'), source: 'spotify' }
    expect(encodeTrack(spotify)).toBeUndefined()
    expect(videoIdOf(spotify)).toBeUndefined()
    const recording = emptyRecording()
    expect(fileItems(recording, [spotify, track])).toEqual(['abc123def45'])
  })

  it('files an item once', () => {
    const recording = emptyRecording()
    fileItems(recording, [track])
    fileItems(recording, [{ ...track, title: 'Changed' }])
    expect(recording.items.abc123def45?.title).toBe('Song')
  })
})

describe('answering from a recording', () => {
  const recording = {
    recordedAt: ['2026-10-26'],
    items: { a: item('Song', 'Artist', 200), b: item('Other', 'Artist', 180) },
    pages: {
      'isrc-songs/1/X': { items: ['a', 'b'] },
      'isrc-top-card/X': { item: null },
      'isrc-top-card/Y': { item: 'b' },
      'songs/Artist Song': { items: ['b'] },
      'songs/failed': { error: 'Network' },
      'description/a': {
        facts: { label: 'L', releaseYear: 2020 },
        excerpt: 'Provided to YouTube by L',
      },
      'description/b': { error: 'NotFound' },
    },
  }

  it('answers searches with their tracks in order', () => {
    const answer = answerFromRecording({ kind: 'isrc-songs', query: 'X', attempt: 1 }, recording)
    expect(answer?.kind === 'isrc-songs' && answer.tracks.map((t) => t.title)).toEqual([
      'Song',
      'Other',
    ])
    expect(
      answerFromRecording({ kind: 'text-songs', query: 'Artist Song' }, recording),
    ).toMatchObject({
      kind: 'text-songs',
      tracks: [{ title: 'Other' }],
    })
    expect(recordedTracks(recording, 'songs/Artist Song')).toHaveLength(1)
  })

  it('answers the top-result card, also when there was none', () => {
    expect(answerFromRecording({ kind: 'isrc-top-card', query: 'X' }, recording)).toEqual({
      kind: 'isrc-top-card',
      card: null,
    })
    const card = answerFromRecording({ kind: 'isrc-top-card', query: 'Y' }, recording)
    expect(card?.kind === 'isrc-top-card' && card.card?.title).toBe('Other')
  })

  it('answers descriptions keyed by the requested IDs, all or none', () => {
    const a = formatId('ytm', 'track', 'a')
    expect(answerFromRecording({ kind: 'release-facts', trackIds: [a] }, recording)).toEqual({
      kind: 'release-facts',
      facts: { [a]: { label: 'L', releaseYear: 2020 } },
    })
    const both: MatchRequest = {
      kind: 'release-facts',
      trackIds: [a, formatId('ytm', 'track', 'b')],
    }
    expect(answerFromRecording(both, recording)).toBeNull()
    expect(recordedFacts(recording, 'a')).toEqual({ label: 'L', releaseYear: 2020 })
  })

  it('answers nothing for a page never recorded or recorded as a failure', () => {
    expect(answerFromRecording({ kind: 'text-songs', query: 'missing' }, recording)).toBeNull()
    expect(answerFromRecording({ kind: 'text-songs', query: 'failed' }, recording)).toBeNull()
    expect(isRecorded(recording, 'songs/failed')).toBe(true)
    expect(isRecorded(recording, 'songs/missing')).toBe(false)
  })

  it('tells the kinds of page apart', () => {
    expect(Object.values(recording.pages).map(pageKindOf)).toEqual([
      'search',
      'top-card',
      'top-card',
      'search',
      'error',
      'description',
      'error',
    ])
  })
})

describe('descriptionExcerpt', () => {
  it('keeps only the lines YouTube generates for a label upload', () => {
    const text = [
      'Provided to YouTube by The Orchard Enterprises',
      '',
      'The Twist · Chubby Checker',
      '',
      'Chubby Checker Classics',
      '',
      '℗ 1958 TEEC Recording Company',
      '',
      'Released on: 1962-01-01',
      '',
      'Lyrics: la la la',
      'https://example.com',
    ].join('\n')
    expect(descriptionExcerpt(text)).toBe(
      [
        'Provided to YouTube by The Orchard Enterprises',
        'The Twist · Chubby Checker',
        'Chubby Checker Classics',
        '℗ 1958 TEEC Recording Company',
        'Released on: 1962-01-01',
      ].join('\n'),
    )
  })

  it('keeps nothing of other descriptions, and cuts long ones', () => {
    expect(descriptionExcerpt('Follow me on https://example.com')).toBeUndefined()
    expect(descriptionExcerpt(undefined)).toBeUndefined()
    const long = `Provided to YouTube by ${'x'.repeat(500)}`
    expect(descriptionExcerpt(long)?.length).toBe(400)
  })
})

describe('withoutIsrcCap', () => {
  it('turns a trusted ISRC into one of several, which caps nothing on a miss', () => {
    expect(withoutIsrcCap(source('S', 'A', 200, { isrc: 'X' }))?.isrcOrigin).toBe(
      'musicbrainz-exact-several',
    )
    expect(
      withoutIsrcCap(source('S', 'A', 200, { isrc: 'X', isrcOrigin: 'musicbrainz-exact' }))
        ?.isrcOrigin,
    ).toBe('musicbrainz-exact-several')
  })

  it('leaves inputs without a trusted ISRC alone', () => {
    expect(withoutIsrcCap(source('S', 'A', 200))).toBeUndefined()
    expect(
      withoutIsrcCap(source('S', 'A', 200, { isrc: 'X', isrcOrigin: 'musicbrainz-fuzzy' })),
    ).toBeUndefined()
  })
})
