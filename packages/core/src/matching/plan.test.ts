import { describe, expect, it } from 'vitest'
import type { Track } from '../model'
import { track } from './__fixtures__/tracks'
import { matchTrack } from './engine'
import {
  addMatchResponse,
  albumSearchQuery,
  type MatchRequest,
  type MatchResponse,
  nextMatchRequest,
  textSearchQuery,
  videoSearchQuery,
} from './plan'
import type { MatchOptions, MatchPages, MatchSource } from './types'

const SOURCE: MatchSource = {
  title: 'Blinding Lights',
  artists: [{ name: 'The Weeknd' }],
  album: { name: 'After Hours' },
  durationMs: 200000,
}
const SONG = track('J7p4bzqLvCw', 'Blinding Lights', 'The Weeknd', {
  album: 'Blinding Lights',
  seconds: 202,
})
const FILLER = track('filler', 'Lil Globglogabgalab', 'Grandayy', { kind: 'video', seconds: 43 })

/** A fake provider: answers each request from a table, and records what was asked. */
function runPlan(
  source: MatchSource,
  answer: (request: MatchRequest) => MatchResponse,
  options: MatchOptions = {},
): { requests: MatchRequest[]; pages: MatchPages } {
  let pages: MatchPages = {}
  const requests: MatchRequest[] = []
  for (let request = nextMatchRequest(source, pages, options); request !== null; ) {
    requests.push(request)
    expect(requests.length).toBeLessThanOrEqual(10)
    pages = addMatchResponse(pages, answer(request))
    request = nextMatchRequest(source, pages, options)
  }
  return { requests, pages }
}

/** Answers every request with the same tracks, the card with `card`, facts with nothing. */
function answering(tracks: Track[], card: Track | null = null) {
  return (request: MatchRequest): MatchResponse => {
    switch (request.kind) {
      case 'isrc-top-card':
        return { kind: request.kind, card }
      case 'release-facts':
        return { kind: request.kind, facts: {} }
      default:
        return { kind: request.kind, tracks }
    }
  }
}

describe('search queries', () => {
  it('builds the text query from all artists and the title', () => {
    expect(textSearchQuery(SOURCE)).toBe('The Weeknd Blinding Lights')
    expect(
      textSearchQuery({
        title: 'Despacito (Official Video)',
        artists: [{ name: 'Luis Fonsi' }, { name: ' Daddy Yankee ' }, { name: '' }],
      }),
    ).toBe('Luis Fonsi Daddy Yankee Despacito')
    expect(textSearchQuery({ title: 'Hotel California - 2013 Remaster', artists: [] })).toBe(
      'Hotel California - 2013 Remaster',
    )
  })

  it('adds the album, except for singles and classical titles', () => {
    expect(albumSearchQuery(SOURCE)).toBe('The Weeknd Blinding Lights After Hours')
    expect(albumSearchQuery({ ...SOURCE, albumType: 'single' })).toBeUndefined()
    expect(albumSearchQuery({ ...SOURCE, album: { name: 'Blinding Lights' } })).toBeUndefined()
    expect(albumSearchQuery({ ...SOURCE, album: { name: ' ' } })).toBeUndefined()
    const { album: _, ...noAlbum } = SOURCE
    expect(albumSearchQuery(noAlbum)).toBeUndefined()
    expect(
      albumSearchQuery({
        title: 'Cello Suite No. 1 in G Major, BWV 1007: I. Prélude',
        artists: [{ name: 'Yo-Yo Ma' }],
        album: { name: 'Six Evolutions' },
      }),
    ).toBeUndefined()
  })

  it('builds the video query as "artists - title"', () => {
    expect(videoSearchQuery({ ...SOURCE, artists: [{ name: 'A' }, { name: 'B' }] })).toBe(
      'A, B - Blinding Lights',
    )
    expect(videoSearchQuery({ title: 'Song', artists: [] })).toBe('Song')
  })
})

describe('nextMatchRequest', () => {
  const isrcSource = { ...SOURCE, isrc: 'usug11904206' }

  it('stops after one request when the ISRC passes at once', () => {
    const { requests, pages } = runPlan(isrcSource, answering([SONG]))
    expect(requests).toEqual([{ kind: 'isrc-songs', query: 'USUG11904206', attempt: 1 }])
    expect(matchTrack(isrcSource, pages, { auto: true }).band).toBe('auto')
  })

  it('tries the card and the retry after a miss, then the text and album searches', () => {
    const { requests } = runPlan(isrcSource, (request) =>
      request.kind === 'text-songs' || request.kind === 'album-songs'
        ? { kind: request.kind, tracks: [SONG] }
        : answering([FILLER])(request),
    )
    expect(requests.map((request) => request.kind)).toEqual([
      'isrc-songs',
      'isrc-top-card',
      'isrc-songs',
      'text-songs',
      'album-songs',
    ])
    expect(requests[2]).toEqual({ kind: 'isrc-songs', query: 'USUG11904206', attempt: 2 })
    expect(requests[3]).toEqual({ kind: 'text-songs', query: 'The Weeknd Blinding Lights' })
  })

  it('stops at the card when the card passes', () => {
    const { requests } = runPlan(isrcSource, answering([FILLER], SONG))
    expect(requests.map((request) => request.kind)).toEqual(['isrc-songs', 'isrc-top-card'])
  })

  it('gives a fuzzy ISRC one search only', () => {
    const fuzzy = { ...isrcSource, isrcOrigin: 'musicbrainz-fuzzy' } as const
    const { requests } = runPlan(fuzzy, answering([FILLER]))
    expect(requests.map((request) => request.kind)).toEqual([
      'isrc-songs',
      'text-songs',
      'album-songs',
    ])
  })

  it('skips the album search when the text search already plays', () => {
    const { requests } = runPlan(SOURCE, answering([SONG]))
    expect(requests).toEqual([{ kind: 'text-songs', query: 'The Weeknd Blinding Lights' }])
  })

  it('judges eligibility as if the Auto setting were on', () => {
    const { requests } = runPlan(SOURCE, answering([SONG]), { auto: false })
    expect(requests.map((request) => request.kind)).toEqual(['text-songs'])
  })

  it('fetches the descriptions of the top two songs once, when the source has release facts', () => {
    const second = track('second', 'Blinding Lights', 'The Weeknd', {
      album: 'After Hours',
      seconds: 201,
    })
    const cover = track('cover', 'Blinding Lights', 'Some Band', { seconds: 200 })
    const dated = { ...SOURCE, label: 'Republic Records', albumType: 'single' } as const
    const { requests, pages } = runPlan(dated, (request) =>
      request.kind === 'release-facts'
        ? {
            kind: request.kind,
            facts: { [request.trackIds[0] ?? '']: { label: 'Republic Records' } },
          }
        : answering([SONG, second, cover])(request),
    )
    expect(requests.map((request) => request.kind)).toEqual(['text-songs', 'release-facts'])
    expect(requests[1]).toEqual({
      kind: 'release-facts',
      trackIds: ['ytm:track:second', 'ytm:track:J7p4bzqLvCw'],
    })
    expect(pages.releaseFacts).toEqual({ 'ytm:track:second': { label: 'Republic Records' } })
  })

  it('fetches no descriptions without a candidate worth checking', () => {
    const dated = { ...SOURCE, releaseDate: '2020', albumType: 'single' } as const
    const { requests } = runPlan(dated, answering([FILLER]))
    expect(requests.map((request) => request.kind)).toEqual(['text-songs'])
  })

  it('searches videos in Music + Video mode only when no song is worth suggesting', () => {
    const all: MatchOptions = { mode: 'all' }
    const single = { ...SOURCE, albumType: 'single' } as const
    const { requests } = runPlan(single, answering([FILLER]), all)
    expect(requests).toEqual([
      { kind: 'text-songs', query: 'The Weeknd Blinding Lights' },
      { kind: 'videos', query: 'The Weeknd - Blinding Lights' },
      { kind: 'youtube', query: 'The Weeknd - Blinding Lights' },
    ])
    expect(runPlan(single, answering([SONG]), all).requests).toHaveLength(1)
  })
})

describe('addMatchResponse', () => {
  it('files every answer where the engine reads it', () => {
    let pages: MatchPages = {}
    pages = addMatchResponse(pages, { kind: 'isrc-songs', tracks: [FILLER] })
    pages = addMatchResponse(pages, { kind: 'isrc-songs', tracks: [SONG] })
    pages = addMatchResponse(pages, { kind: 'isrc-top-card', card: null })
    pages = addMatchResponse(pages, { kind: 'text-songs', tracks: [SONG] })
    pages = addMatchResponse(pages, { kind: 'album-songs', tracks: [] })
    pages = addMatchResponse(pages, { kind: 'videos', tracks: [FILLER] })
    pages = addMatchResponse(pages, { kind: 'youtube', tracks: [] })
    pages = addMatchResponse(pages, { kind: 'release-facts', facts: { a: { releaseYear: 2019 } } })
    pages = addMatchResponse(pages, { kind: 'release-facts', facts: { b: { label: 'XO' } } })
    expect(pages).toEqual({
      isrcSongs: [[FILLER], [SONG]],
      isrcTopCard: null,
      text: [SONG],
      album: [],
      videos: [FILLER],
      youtube: [],
      releaseFacts: { a: { releaseYear: 2019 }, b: { label: 'XO' } },
    })
  })

  it('never changes the pages it was given', () => {
    const pages: MatchPages = { text: [SONG] }
    const next = addMatchResponse(pages, { kind: 'album-songs', tracks: [SONG] })
    expect(pages).toEqual({ text: [SONG] })
    expect(next).not.toBe(pages)
  })
})
