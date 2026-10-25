import { describe, expect, it } from 'vitest'
import { type LrclibRecord, toRecord } from './api'
import { creep, fixtures } from './fixtures/testing'
import {
  bestMatch,
  cleanArtist,
  comparable,
  type LyricsQuery,
  matchRecord,
  queryFor,
  similarity,
  syncedFits,
} from './match'

/** The checked records of a recorded search. */
function records(results: readonly unknown[]): LrclibRecord[] {
  return results.map(toRecord).filter((record) => record !== null)
}

const creepResults = records(fixtures.searchRadioheadCreep)

/** The query for Creep, with `overrides`. */
function creepQuery(overrides: Partial<LyricsQuery> = {}): LyricsQuery {
  const query = queryFor(creep())
  if (query === null) throw new Error('expected a query')
  return { ...query, ...overrides }
}

/** A record with lyrics, with `overrides`. */
function record(overrides: Partial<LrclibRecord> = {}): LrclibRecord {
  return {
    id: 1,
    trackName: 'Creep',
    artistName: 'Radiohead',
    albumName: 'Pablo Honey',
    duration: 238.9,
    instrumental: false,
    plainLyrics: 'Line',
    syncedLyrics: '[00:01.00] Line',
    ...overrides,
  }
}

describe('comparable and similarity', () => {
  it.each([
    ["Don't Stop Me Now", 'Dont Stop Me Now'],
    ['Mr. Brightside', 'Mr Brightside'],
    ['Beyoncé', 'BEYONCE'],
    ['Me & You', 'Me and You'],
    ['Jay-Z', 'JAY Z'],
    ['Taylor Swift', 'TaylorSwift'],
  ])('treats %j and %j as the same', (a, b) => {
    expect(similarity(comparable(a), comparable(b))).toBe(1)
  })

  it.each([
    ['creep', 'radiohead creep', 0.5],
    ['creep', 'creeps', 0.9],
    ['the weeknd', 'weeknd', 0.8],
    ['7', '8', 0],
    ['', '', 0],
    ['a', 'ab', 0],
  ])('scores %j against %j below %d', (a, b, below) => {
    expect(similarity(comparable(a), comparable(b))).toBeLessThan(below || Number.MIN_VALUE)
  })

  it('compares scripts without spaces by character pairs', () => {
    expect(similarity(comparable('米津玄師'), comparable('米津 玄師'))).toBe(1)
    expect(similarity(comparable('レモン'), comparable('レモンティー'))).toBeCloseTo(4 / 7)
  })
})

describe('cleanArtist', () => {
  it.each([
    ['RadioheadVEVO', 'Radiohead'],
    ['Taylor Swift VEVO', 'Taylor Swift'],
    ['Radiohead - Topic', 'Radiohead'],
    ['VEVO', 'VEVO'],
    ['  Radiohead  ', 'Radiohead'],
    ['Radiohead  -   Topic', 'Radiohead'],
    ['Taylor \t Swift', 'Taylor Swift'],
  ])('cleans %j to %j', (name, clean) => {
    expect(cleanArtist(name)).toBe(clean)
  })
})

describe('queryFor', () => {
  it('describes a catalog song', () => {
    expect(queryFor(creep())).toEqual({
      title: 'Creep',
      core: 'Creep',
      versions: [],
      artists: ['Radiohead'],
      album: 'Pablo Honey',
      duration: 238.64,
    })
  })

  it('cleans a music video title and its channel', () => {
    const video = creep({
      title: 'Radiohead - Creep (Official Music Video)',
      artists: [{ name: 'RadioheadVEVO' }],
      durationMs: 256_000,
      kind: 'music-video',
    })
    const { album: _album, ...noAlbum } = video
    expect(queryFor(noAlbum)).toEqual({
      title: 'Creep',
      core: 'Creep',
      versions: [],
      artists: ['Radiohead'],
      duration: 256,
    })
  })

  it('keeps versions and drops featured artists from the core', () => {
    const query = queryFor(
      creep({
        title: 'One Kiss (with Dua Lipa) - Acoustic',
        artists: [{ name: 'Calvin Harris' }, { name: 'Dua Lipa' }],
      }),
    )
    expect(query).toMatchObject({
      title: 'One Kiss (with Dua Lipa) - Acoustic',
      core: 'One Kiss',
      versions: ['acoustic'],
      artists: ['Calvin Harris', 'Dua Lipa'],
    })
  })

  it('strips an "Artist - " prefix only when every name in it is an artist of the track', () => {
    const duet = [{ name: 'Calvin Harris' }, { name: 'Dua Lipa' }]
    expect(
      queryFor(creep({ title: 'Calvin Harris & Dua Lipa - One Kiss', artists: duet })),
    ).toMatchObject({
      title: 'One Kiss',
    })
    expect(queryFor(creep({ title: 'Someone Else - Creep' }))?.title).toBe('Someone Else - Creep')
  })

  it('needs a title and an artist', () => {
    expect(queryFor(creep({ artists: [] }))).toBeNull()
    expect(queryFor(creep({ artists: [{ name: '  ' }] }))).toBeNull()
    expect(queryFor(creep({ title: '  ' }))).toBeNull()
  })

  it('leaves out an unknown or impossible duration and a blank album', () => {
    const query = queryFor(creep({ durationMs: 0, album: { name: ' ' } }))
    expect(query).not.toHaveProperty('duration')
    expect(query).not.toHaveProperty('album')
    expect(queryFor(creep({ durationMs: Number.NaN }))).not.toHaveProperty('duration')
  })
})

describe('matchRecord', () => {
  const query = creepQuery()

  it('accepts the song under an "Artist - Title" title', () => {
    const match = matchRecord(
      query,
      record({ trackName: 'Radiohead - Creep', albumName: 'Radiohead' }),
    )
    expect(match).toMatchObject({ title: 1, artist: 1, content: 3, sameAlbum: false })
    expect(match?.score).toBeCloseTo(1)
  })

  it.each([
    ['another version', { trackName: 'Creep (Acoustic)' }],
    ['a live take', { trackName: 'Creep - Live' }],
    ['another artist', { artistName: 'Lyrics Uploader', trackName: 'Radiohead - Creep (Lyrics)' }],
    ['another song', { trackName: 'Creeps' }],
    ['swapped fields', { trackName: 'radiohead', artistName: 'creep' }],
    [
      'the whole query in every field',
      { trackName: 'radiohead  creep', artistName: 'radiohead  creep' },
    ],
    ['no lyrics at all', { plainLyrics: null, syncedLyrics: '  ' }],
  ])('rejects %s', (_name, overrides) => {
    expect(matchRecord(query, record(overrides))).toBeNull()
  })

  it('matches a version only to the same version', () => {
    const acoustic = creepQuery({ versions: ['acoustic'] })
    expect(matchRecord(acoustic, record({ trackName: 'Creep (Acoustic Version)' }))).not.toBeNull()
    expect(matchRecord(acoustic, record())).toBeNull()
  })

  it('scores the duration, and trusts synced lyrics only within 2.5 s', () => {
    const within = matchRecord(query, record({ duration: 236.7 }))
    const off = matchRecord(query, record({ duration: 242.64 }))
    const far = matchRecord(query, record({ duration: 256 }))
    const unknown = matchRecord(query, record({ duration: undefined as unknown as number }))
    expect([within?.content, off?.content, far?.content, unknown?.content]).toEqual([3, 2, 2, 2])
    expect(within?.score).toBeCloseTo(1)
    // 4 s off is 1.5 s past the tolerance: the duration score falls by 1.5 / 8.
    expect(off?.score).toBeCloseTo(0.75 + 0.25 * (1 - 1.5 / 8))
    expect(far?.score).toBeCloseTo(0.75)
    expect(unknown?.score).toBeCloseTo(0.875)
    expect(off?.durationDiff).toBeCloseTo(4)
    expect(unknown).not.toHaveProperty('durationDiff')
  })

  it('tells what a record offers', () => {
    const plainOnly = matchRecord(query, record({ syncedLyrics: null }))
    const instrumental = matchRecord(
      query,
      record({ instrumental: true, plainLyrics: null, syncedLyrics: null }),
    )
    const { plainLyrics: _plain, syncedLyrics: _synced, ...leftOut } = record()
    expect(plainOnly?.content).toBe(2)
    expect(instrumental?.content).toBe(0)
    expect(matchRecord(query, leftOut)?.content).toBe(1)
  })

  it('does not count LRC that only reads as plain as synced lyrics', () => {
    const strayStamp = record({ id: 1, duration: 238.64, syncedLyrics: 'A\nB\n[00:03.00]C\nD' })
    const synced = record({ id: 2, albumName: 'Singles', duration: 240 })
    expect(matchRecord(query, strayStamp)?.content).toBe(2)
    expect(bestMatch(query, [strayStamp, synced])?.record.id).toBe(2)
    // Timestamps without words are no lyrics at all.
    const empty = record({ plainLyrics: ' ', syncedLyrics: '[00:01.00]\n[00:02.00] ' })
    expect(matchRecord(query, empty)).toBeNull()
  })

  it('reads credits with long runs of spaces in linear time', () => {
    const spaces = ' '.repeat(50_000)
    const started = Date.now()
    const checked = toRecord({
      id: 1,
      trackName: `Radiohead${spaces}-${spaces}Creep`,
      artistName: `Radiohead${spaces}&${spaces}Someone`,
      plainLyrics: 'Line',
    })
    const unchecked = record({ artistName: `Radiohead${spaces}feat.${spaces}Someone` })
    const matches = [checked, unchecked].map((each) => each && matchRecord(query, each))
    // Linear work takes a few milliseconds; backtracking through the spaces takes seconds.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(checked).toMatchObject({
      trackName: 'Radiohead - Creep',
      artistName: 'Radiohead & Someone',
    })
    expect(matches.map((match) => [match?.title, match?.artist])).toEqual([
      [1, 1],
      [1, 1],
    ])
  })

  it('recognizes the same album across editions', () => {
    const deluxe = record({ albumName: "Pablo Honey (Collector's Edition)" })
    expect(matchRecord(query, deluxe)?.sameAlbum).toBe(true)
    expect(
      matchRecord(creepQuery({ album: undefined as unknown as string }), deluxe)?.sameAlbum,
    ).toBe(false)
    const { albumName: _album, ...noAlbum } = deluxe
    expect(matchRecord(query, noAlbum)?.sameAlbum).toBe(false)
  })
})

describe('syncedFits', () => {
  it('needs the record duration within 2.5 s, unless the track duration is unknown', () => {
    // Creep lasts 238.64 s and is sent to /api/get as 239, which LRCLIB matches to 237-241 s.
    const query = creepQuery()
    const fits = (duration: number) => syncedFits(query, record({ duration }))
    expect([236.2, 237, 238.64, 241, 241.1].map(fits)).toEqual([true, true, true, true, true])
    expect([236.1, 241.2, 250].map(fits)).toEqual([false, false, false])
    const { duration: _duration, ...noDuration } = record()
    expect(syncedFits(query, noDuration)).toBe(false)
    const { duration: _unknown, ...unknownQuery } = query
    expect(syncedFits(unknownQuery, noDuration)).toBe(true)
  })
})

describe('bestMatch on recorded LRCLIB search results', () => {
  it('picks synced lyrics of the same cut for the album track', () => {
    const best = bestMatch(creepQuery(), creepResults)
    expect(best?.record).toMatchObject({
      id: 6730469,
      trackName: 'Radiohead - Creep',
      duration: 239,
    })
    expect(best?.content).toBe(3)
  })

  it('falls back to plain lyrics for a music video, whose duration fits no record', () => {
    const video = creepQuery({ duration: 256 })
    const best = bestMatch(video, creepResults)
    // The closest record is 3 s off: the best score, but too far off to trust its timestamps.
    expect(best).toMatchObject({ content: 2, record: { id: 36837546, duration: 259 } })
    // Without it, a record without a duration (it might fit) beats records ~20 s shorter.
    const others = creepResults.filter((result) => result.id !== 36837546)
    expect(bestMatch(video, others)?.record).toMatchObject({ id: 36087116, trackName: 'Creep' })
  })

  it("keeps LRCLIB's order when nothing tells the records apart", () => {
    const { duration: _duration, ...unknown } = creepQuery()
    expect(bestMatch(unknown, creepResults)?.record.id).toBe(27196790)
  })

  it('finds the instrumental record of an instrumental', () => {
    const query = creepQuery({
      title: 'Time',
      core: 'Time',
      artists: ['Hans Zimmer'],
      album: 'Inception (Music from the Motion Picture)',
      duration: 275,
    })
    const best = bestMatch(query, records(fixtures.searchHansZimmerTime))
    expect(best).toMatchObject({ content: 0, record: { id: 24732309, instrumental: true } })
  })

  it('finds nothing among records of other songs', () => {
    const query = creepQuery({ title: 'Karma Police', core: 'Karma Police' })
    expect(bestMatch(query, creepResults)).toBeNull()
    expect(bestMatch(creepQuery(), [])).toBeNull()
  })

  it('prefers synced lyrics that fit, then the score, the album and the closest duration', () => {
    const query = creepQuery()
    const plainButExact = record({ id: 1, syncedLyrics: null, duration: 238.64 })
    const syncedOtherAlbum = record({ id: 2, albumName: 'Singles', duration: 237.2 })
    const syncedSameAlbum = record({ id: 3, duration: 236.9 })
    const syncedCloser = record({ id: 4, albumName: 'Singles', duration: 238.6 })
    const ranked = (list: LrclibRecord[]) => bestMatch(query, list)?.record.id
    expect(ranked([plainButExact, syncedOtherAlbum])).toBe(2)
    expect(ranked([plainButExact, syncedOtherAlbum, syncedSameAlbum])).toBe(3)
    expect(ranked([syncedOtherAlbum, syncedCloser])).toBe(4)
    const instrumental = record({
      id: 5,
      instrumental: true,
      plainLyrics: null,
      syncedLyrics: null,
    })
    expect(ranked([instrumental, plainButExact])).toBe(1)
  })
})
