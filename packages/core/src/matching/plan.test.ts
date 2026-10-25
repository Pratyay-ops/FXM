import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import type { Track } from '../model'
import data from './__fixtures__/golden.json'
import { track } from './__fixtures__/tracks'
import { matchTrack } from './engine'
import {
  addMatchResponse,
  albumSearchQuery,
  nextMatchRequest,
  runMatch,
  textSearchQuery,
  videoSearchQuery,
  videoSongsQuery,
} from './plan'
import type {
  MatchOptions,
  MatchPages,
  MatchRequest,
  MatchResponse,
  MatchSource,
  ReleaseFacts,
} from './types'

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

/** A fake provider: answers each request with `answer`, and records what was asked. */
function runPlan(
  source: MatchSource,
  answer: (request: MatchRequest) => MatchResponse | null,
  options: MatchOptions = {},
): { requests: MatchRequest[]; pages: MatchPages } {
  let pages: MatchPages = {}
  const requests: MatchRequest[] = []
  for (let request = nextMatchRequest(source, pages, options); request !== null; ) {
    requests.push(request)
    expect(requests.length).toBeLessThanOrEqual(10)
    pages = addMatchResponse(pages, request, answer(request))
    request = nextMatchRequest(source, pages, options)
  }
  return { requests, pages }
}

/** Answers every search with the same tracks, the card with `card`, descriptions with nothing. */
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

const kinds = (requests: MatchRequest[]) => requests.map((request) => request.kind)

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

  it('drops a leading credit of the artists from the title, keeping its case', () => {
    const video = {
      title: 'Chubby Checker – The Twist (Official Video)',
      artists: [{ name: 'Chubby Checker' }],
    }
    expect(textSearchQuery(video)).toBe('Chubby Checker The Twist')
    expect(videoSearchQuery(video)).toBe('Chubby Checker - The Twist')
    expect(
      videoSongsQuery({
        title: "BTS (방탄소년단) 'Dynamite' Official MV",
        artists: [{ name: 'BTS' }],
      }),
    ).toBe('BTS Dynamite')
    expect(
      textSearchQuery({ title: 'Depeche Mode - Stripped', artists: [{ name: 'Radiohead' }] }),
    ).toBe('Radiohead Depeche Mode - Stripped')
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
    expect(kinds(requests)).toEqual([
      'isrc-songs',
      'isrc-top-card',
      'isrc-songs',
      'text-songs',
      'album-songs',
    ])
    expect(requests[2]).toEqual({ kind: 'isrc-songs', query: 'USUG11904206', attempt: 2 })
    expect(requests[3]).toEqual({ kind: 'text-songs', query: 'The Weeknd Blinding Lights' })
  })

  it('runs the album search after a miss only when no text candidate suggests on the album', () => {
    const lp = track('lp', 'Blinding Lights', 'The Weeknd', { album: 'After Hours', seconds: 201 })
    const withAlbum = runPlan(isrcSource, (request) =>
      request.kind === 'text-songs'
        ? { kind: request.kind, tracks: [lp] }
        : answering([FILLER])(request),
    )
    expect(kinds(withAlbum.requests)).not.toContain('album-songs')
    const without = runPlan(isrcSource, (request) =>
      request.kind === 'text-songs'
        ? { kind: request.kind, tracks: [SONG] }
        : answering([FILLER])(request),
    )
    expect(kinds(without.requests).at(-1)).toBe('album-songs')
  })

  it('stops at the card when the card passes', () => {
    const { requests } = runPlan(isrcSource, answering([FILLER], SONG))
    expect(kinds(requests)).toEqual(['isrc-songs', 'isrc-top-card'])
  })

  it('gives a fuzzy ISRC one search only', () => {
    const fuzzy = { ...isrcSource, isrcOrigin: 'musicbrainz-fuzzy' } as const
    const { requests } = runPlan(fuzzy, answering([FILLER]))
    expect(kinds(requests)).toEqual(['isrc-songs', 'text-songs', 'album-songs'])
  })

  it('skips the album search when the text search already plays', () => {
    const { requests } = runPlan(SOURCE, answering([SONG]))
    expect(requests).toEqual([{ kind: 'text-songs', query: 'The Weeknd Blinding Lights' }])
  })

  it('judges eligibility as if the Auto setting were on, whatever the options say', () => {
    expect(kinds(runPlan(SOURCE, answering([SONG]), { auto: false }).requests)).toEqual([
      'text-songs',
    ])
    const stored = { auto: 'yes', mode: 'everything' } as unknown as MatchOptions
    expect(kinds(runPlan(SOURCE, answering([SONG]), stored).requests)).toEqual(['text-songs'])
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
            facts: { [request.trackIds[0] ?? 'ytm:track:none']: { label: 'Republic Records' } },
          }
        : answering([SONG, second, cover])(request),
    )
    expect(kinds(requests)).toEqual(['text-songs', 'release-facts'])
    expect(requests[1]).toEqual({
      kind: 'release-facts',
      trackIds: ['ytm:track:second', 'ytm:track:J7p4bzqLvCw'],
    })
    expect(pages.releaseFacts).toEqual({
      'ytm:track:second': { label: 'Republic Records' },
      'ytm:track:J7p4bzqLvCw': {},
    })
  })

  it('runs the album search before the descriptions, so they cover its songs', () => {
    const dated = { ...SOURCE, releaseDate: '2020-03-20' }
    const lp = track('lp', 'Blinding Lights', 'The Weeknd', { album: 'After Hours', seconds: 201 })
    const close = track('close', 'Blinding Lights', 'The Weeknd', { seconds: 203 })
    const rival = track('rival', 'Blinding Lights', 'The Weeknd', { album: 'Hits', seconds: 203 })
    const { requests } = runPlan(dated, (request) => {
      if (request.kind === 'text-songs') return { kind: request.kind, tracks: [close, rival] }
      if (request.kind === 'album-songs') return { kind: request.kind, tracks: [lp] }
      return answering([])(request)
    })
    expect(kinds(requests)).toEqual(['text-songs', 'album-songs', 'release-facts'])
    expect(requests[2]).toEqual({
      kind: 'release-facts',
      trackIds: ['ytm:track:lp', 'ytm:track:close'],
    })
  })

  it('describes a new top song after facts turn Auto into a suggestion, within two in all', () => {
    const dated = { ...SOURCE, releaseDate: '2020-03-20' }
    const old = track('old', 'Blinding Lights', 'The Weeknd', { album: 'Hits', seconds: 201 })
    const lp = track('lp', 'Blinding Lights', 'The Weeknd', { album: 'After Hours', seconds: 201 })
    const { requests, pages } = runPlan(dated, (request) => {
      if (request.kind === 'text-songs') return { kind: request.kind, tracks: [old] }
      if (request.kind === 'album-songs') return { kind: request.kind, tracks: [lp] }
      if (
        request.kind === 'release-facts' &&
        request.trackIds.includes(formatId('ytm', 'track', 'old'))
      ) {
        return { kind: request.kind, facts: { 'ytm:track:old': { releaseYear: 2015 } } }
      }
      return answering([])(request)
    })
    expect(requests).toEqual([
      { kind: 'text-songs', query: 'The Weeknd Blinding Lights' },
      { kind: 'release-facts', trackIds: ['ytm:track:old'] },
      { kind: 'album-songs', query: 'The Weeknd Blinding Lights After Hours' },
      { kind: 'release-facts', trackIds: ['ytm:track:lp'] },
    ])
    const result = matchTrack(dated, pages, { auto: true })
    expect(result.best?.ref).toBe('lp')
    expect(result.band).toBe('auto')
  })

  it('fetches no descriptions without a candidate worth checking', () => {
    const dated = { ...SOURCE, releaseDate: '2020', albumType: 'single' } as const
    const { requests } = runPlan(dated, answering([FILLER]))
    expect(kinds(requests)).toEqual(['text-songs'])
  })

  it('spends nothing on descriptions when Auto is out of reach', () => {
    const { durationMs: _, ...noDuration } = { ...SOURCE, releaseDate: '2020-03-20' }
    const lp = track('lp', 'Blinding Lights', 'The Weeknd', { album: 'After Hours', seconds: 201 })
    expect(kinds(runPlan(noDuration, answering([lp])).requests)).toEqual(['text-songs'])
    expect(kinds(runPlan(noDuration, answering([SONG])).requests)).toEqual([
      'text-songs',
      'album-songs',
    ])
    const missed = { ...SOURCE, isrc: 'USUG11904206', label: 'Republic Records' }
    const { requests } = runPlan(missed, (request) =>
      request.kind === 'text-songs'
        ? { kind: request.kind, tracks: [lp] }
        : answering([FILLER])(request),
    )
    expect(kinds(requests)).toEqual(['isrc-songs', 'isrc-top-card', 'isrc-songs', 'text-songs'])
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

  it('never asks a skipped request again', () => {
    const isrcAnswerless = runPlan(isrcSource, (request) =>
      request.kind === 'text-songs' ? { kind: request.kind, tracks: [SONG] } : null,
    )
    expect(kinds(isrcAnswerless.requests)).toEqual(['isrc-songs', 'text-songs'])
    expect(isrcAnswerless.pages.skipped).toEqual(['isrc-songs'])
    const result = matchTrack(isrcSource, isrcAnswerless.pages, { auto: true })
    expect(result.isrc.status).toBe('not-run')
    expect(result.incomplete).toBe(true)
    const nothing = runPlan({ ...isrcSource, releaseDate: '2020' }, () => null, { mode: 'all' })
    expect(kinds(nothing.requests)).toEqual([
      'isrc-songs',
      'text-songs',
      'album-songs',
      'videos',
      'youtube',
    ])
  })

  it('pins the description fetch of the held-out replay "The 1975"', () => {
    const golden = data as unknown as {
      pages: Record<
        string,
        {
          items: Array<{
            id: string
            title: string
            artists: string[]
            album?: string
            albumId?: string
            durationMs?: number
          }>
        }
      >
    }
    const items = golden.pages['heldout/the1975.text']?.items ?? []
    const text = items.map((item) =>
      track(item.id, item.title, item.artists, {
        ...(item.album !== undefined ? { album: item.album } : {}),
        ...(item.albumId !== undefined ? { albumId: item.albumId } : {}),
        ...(item.durationMs !== undefined ? { seconds: item.durationMs / 1000 } : {}),
      }),
    )
    const source: MatchSource = {
      title: 'The 1975',
      artists: [{ name: 'The 1975' }],
      album: { name: 'I like it when you sleep, for you are so beautiful yet so unaware of it' },
      durationMs: 83000,
      releaseDate: '2016-02-26',
    }
    const facts: Record<string, ReleaseFacts> = { 'ytm:track:ei0PTLzdnWw': { releaseYear: 2013 } }
    const { requests, pages } = runPlan(source, (request) => {
      if (request.kind === 'text-songs') return { kind: request.kind, tracks: text }
      if (request.kind === 'release-facts') return { kind: request.kind, facts }
      return answering([])(request)
    })
    expect(requests.slice(0, 2)).toEqual([
      { kind: 'text-songs', query: 'The 1975 The 1975' },
      { kind: 'release-facts', trackIds: ['ytm:track:ei0PTLzdnWw'] },
    ])
    expect(kinds(requests)).toContain('album-songs')
    const result = matchTrack(source, pages, { auto: true })
    expect(result.band).toBe('suggest')
    expect(result.autoBlockers).toContain('release-conflict')
  })
})

describe('addMatchResponse', () => {
  const songs = (attempt: number): MatchRequest => ({ kind: 'isrc-songs', query: 'X', attempt })
  const text: MatchRequest = { kind: 'text-songs', query: 'q' }

  it('files every answer where the engine reads it', () => {
    const facts: MatchRequest = {
      kind: 'release-facts',
      trackIds: [formatId('ytm', 'track', 'a'), formatId('ytm', 'track', 'b')],
    }
    let pages: MatchPages = {}
    pages = addMatchResponse(pages, songs(1), { kind: 'isrc-songs', tracks: [FILLER] })
    pages = addMatchResponse(pages, songs(2), { kind: 'isrc-songs', tracks: [SONG] })
    pages = addMatchResponse(
      pages,
      { kind: 'isrc-top-card', query: 'X' },
      {
        kind: 'isrc-top-card',
        card: null,
      },
    )
    pages = addMatchResponse(pages, text, { kind: 'text-songs', tracks: [SONG] })
    pages = addMatchResponse(
      pages,
      { kind: 'album-songs', query: 'q' },
      {
        kind: 'album-songs',
        tracks: [],
      },
    )
    pages = addMatchResponse(
      pages,
      { kind: 'videos', query: 'q' },
      { kind: 'videos', tracks: [FILLER] },
    )
    pages = addMatchResponse(
      pages,
      { kind: 'youtube', query: 'q' },
      { kind: 'youtube', tracks: [] },
    )
    pages = addMatchResponse(pages, facts, {
      kind: 'release-facts',
      facts: { 'yt:track:a': { releaseYear: 2019, label: '  ', extra: 1 } as ReleaseFacts },
    })
    expect(pages).toEqual({
      isrcSongs: [[FILLER], [SONG]],
      isrcTopCard: null,
      text: [SONG],
      album: [],
      videos: [FILLER],
      youtube: [],
      releaseFacts: { 'ytm:track:a': { releaseYear: 2019 }, 'ytm:track:b': {} },
    })
  })

  it('replaces an attempt filed twice and refuses one out of order', () => {
    let pages = addMatchResponse({}, songs(1), { kind: 'isrc-songs', tracks: [FILLER] })
    pages = addMatchResponse(pages, songs(1), { kind: 'isrc-songs', tracks: [SONG] })
    expect(pages.isrcSongs).toEqual([[SONG]])
    expect(() => addMatchResponse(pages, songs(3), { kind: 'isrc-songs', tracks: [] })).toThrow(
      RangeError,
    )
    expect(() => addMatchResponse({}, songs(0), { kind: 'isrc-songs', tracks: [] })).toThrow(
      RangeError,
    )
  })

  it('refuses an answer of another kind', () => {
    expect(() => addMatchResponse({}, text, { kind: 'album-songs', tracks: [] })).toThrow(
      RangeError,
    )
  })

  it('refuses release facts keyed by a bare videoId or a track nobody asked for', () => {
    const request: MatchRequest = {
      kind: 'release-facts',
      trackIds: [formatId('ytm', 'track', 'a')],
    }
    const bare = { kind: 'release-facts', facts: { a: { label: 'X' } } } as unknown as MatchResponse
    expect(() => addMatchResponse({}, request, bare)).toThrow(RangeError)
    expect(() =>
      addMatchResponse({}, request, {
        kind: 'release-facts',
        facts: { 'ytm:track:b': { label: 'X' } },
      }),
    ).toThrow(RangeError)
  })

  it('files a request without an answer as skipped', () => {
    const request: MatchRequest = {
      kind: 'release-facts',
      trackIds: [formatId('ytm', 'track', 'a')],
    }
    expect(addMatchResponse({}, request, null)).toEqual({
      skipped: ['release-facts'],
      releaseFacts: { 'ytm:track:a': {} },
    })
    expect(addMatchResponse({}, text, null)).toEqual({ skipped: ['text-songs'] })
  })

  it('never changes the pages it was given', () => {
    const pages: MatchPages = { text: [SONG] }
    const next = addMatchResponse(
      pages,
      { kind: 'album-songs', query: 'q' },
      {
        kind: 'album-songs',
        tracks: [SONG],
      },
    )
    expect(pages).toEqual({ text: [SONG] })
    expect(next).not.toBe(pages)
  })
})

describe('runMatch', () => {
  it('runs the plan with one set of options and returns the decision', async () => {
    const asked: MatchRequest[] = []
    const result = await runMatch(
      { ...SOURCE, isrc: 'USUG11904206' },
      async (request) => {
        asked.push(request)
        return answering([SONG])(request)
      },
      { auto: true },
    )
    expect(kinds(asked)).toEqual(['isrc-songs'])
    expect(result).toMatchObject({ band: 'auto', autoEligible: true, incomplete: false })
  })

  it('needs no settings: the verdict on the best leaves the setting out', async () => {
    const result = await runMatch(SOURCE, async (request) => answering([SONG])(request))
    expect(result.band).toBe('suggest')
    expect(result.best?.verdict?.band).toBe('auto')
  })

  it('goes on without a page it cannot fetch, and marks the result incomplete', async () => {
    const result = await runMatch(SOURCE, async (request) =>
      request.kind === 'text-songs' ? null : answering([SONG])(request),
    )
    expect(result).toMatchObject({ band: 'suggest', incomplete: true })
    expect(result.best?.verdict?.band).toBe('auto')
  })

  it('rejects when the fetch rejects, e.g. on cancellation', async () => {
    const abort = new Error('aborted')
    await expect(runMatch(SOURCE, () => Promise.reject(abort))).rejects.toBe(abort)
  })
})
