import { describe, expect, it } from 'vitest'
import { track } from './__fixtures__/tracks'
import {
  differentRemixes,
  durationSimilarity,
  prepareCandidateTitle,
  prepareSource,
  SCORE_CAPS,
  SCORE_PENALTIES,
  SCORE_WEIGHTS,
  type ScoreSide,
  scoreCandidate,
  sourceSide,
  titleSimilarity,
  trackSide,
  versionMismatches,
} from './score'

const SOURCE: ScoreSide = {
  title: 'Blinding Lights',
  artists: ['The Weeknd'],
  album: 'After Hours',
  durationMs: 200000,
}

function score(candidate: ScoreSide, source: ScoreSide = SOURCE) {
  return scoreCandidate(prepareSource(source), candidate)
}

describe('durationSimilarity', () => {
  it.each([
    [0, 1],
    [2000, 1],
    [-2001, 0.85],
    [5000, 0.85],
    [5001, 0.4],
    [-10000, 0.4],
    [10001, 0],
  ])('scores a difference of %i ms as %d', (delta, expected) => {
    expect(durationSimilarity(delta)).toBe(expected)
  })
})

describe('scoreCandidate', () => {
  it('weighs title, artist and duration 0.40 / 0.35 / 0.25', () => {
    expect(SCORE_WEIGHTS.title + SCORE_WEIGHTS.artist + SCORE_WEIGHTS.duration).toBe(1)
    const exact = score({ title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 202000 })
    expect(exact).toMatchObject({ title: 1, artist: 1, duration: 1, deltaMs: 2000, score: 1 })
    const fourOff = score({ title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 204000 })
    expect(fourOff.score).toBeCloseTo(0.9625)
    const half = score(
      { title: 'Despacito', artists: ['Luis Fonsi'], durationMs: 229000 },
      { title: 'Despacito', artists: ['Luis Fonsi', 'Daddy Yankee'], durationMs: 229700 },
    )
    expect(half.artist).toBe(0.5)
    expect(half.score).toBeCloseTo(0.825)
  })

  it('costs a version family on one side only by its level', () => {
    const live = score({
      title: 'Blinding Lights (Live)',
      artists: ['The Weeknd'],
      durationMs: 200000,
    })
    expect(live.versionMismatches).toEqual([{ family: 'live', level: 'strong', side: 'candidate' }])
    expect(live.strongMismatch).toBe(true)
    expect(live.score).toBeCloseTo(1 - SCORE_PENALTIES.strong)
    const edit = score({
      title: 'Blinding Lights (Radio Edit)',
      artists: ['The Weeknd'],
      durationMs: 200000,
    })
    expect(edit.score).toBeCloseTo(1 - SCORE_PENALTIES.medium)
    expect(edit.strongMismatch).toBe(false)
    const remaster = score(
      { title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 200000 },
      { ...SOURCE, title: 'Blinding Lights - 2020 Remaster' },
    )
    expect(remaster.versionMismatches).toEqual([
      { family: 'remaster', level: 'soft', side: 'source' },
    ])
    expect(remaster.score).toBeCloseTo(1 - SCORE_PENALTIES.soft)
  })

  it('treats remixes by different remixers as a strong mismatch', () => {
    const source: ScoreSide = {
      title: 'Song (Tiësto Remix)',
      artists: ['Artist'],
      durationMs: 200000,
    }
    const other = score(
      { title: 'Song (Alok Remix)', artists: ['Artist'], durationMs: 200000 },
      source,
    )
    expect(other.differentRemix).toBe(true)
    expect(other.strongMismatch).toBe(true)
    expect(other.score).toBeCloseTo(1 - SCORE_PENALTIES.strong)
    const same = score(
      { title: 'Song - Tiesto Remix', artists: ['Artist'], durationMs: 200000 },
      source,
    )
    expect(same.differentRemix).toBe(false)
    expect(same.score).toBe(1)
  })

  it('costs a featured artist the source does not credit', () => {
    const remix = score(
      {
        title: 'Despacito (feat. Justin Bieber)',
        artists: ['Luis Fonsi', 'Daddy Yankee'],
        durationMs: 229000,
      },
      { title: 'Despacito', artists: ['Luis Fonsi', 'Daddy Yankee'], durationMs: 229700 },
    )
    expect(remix.uncreditedFeatured).toEqual(['justin bieber'])
    expect(remix.score).toBeCloseTo(1 - SCORE_PENALTIES.uncreditedFeatured)
    const credited = score(
      { title: 'Get Lucky (feat. Pharrell Williams)', artists: ['Daft Punk'], durationMs: 248000 },
      { title: 'Get Lucky', artists: ['Daft Punk', 'Pharrell Williams'], durationMs: 248000 },
    )
    expect(credited.uncreditedFeatured).toEqual([])
    expect(credited.artist).toBe(1)
  })

  it('costs an explicit master against a clean one', () => {
    const clean = score(
      { title: 'HUMBLE.', artists: ['Kendrick Lamar'], durationMs: 177000, explicit: false },
      { title: 'HUMBLE.', artists: ['Kendrick Lamar'], durationMs: 177000, explicit: true },
    )
    expect(clean.explicitMismatch).toBe(true)
    expect(clean.score).toBeCloseTo(1 - SCORE_PENALTIES.explicit)
    const unknown = score(
      { title: 'HUMBLE.', artists: ['Kendrick Lamar'], durationMs: 177000 },
      {
        title: 'HUMBLE.',
        artists: ['Kendrick Lamar'],
        durationMs: 177000,
        explicit: true,
      },
    )
    expect(unknown.explicitMismatch).toBe(false)
  })

  it('costs a duration off by more than 10 s, and more by more than 20 s', () => {
    const eleven = score({ title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 211000 })
    expect(eleven.score).toBeCloseTo(0.75 - SCORE_PENALTIES.durationOver10s)
    const thirty = score({ title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 170000 })
    expect(thirty.score).toBeCloseTo(0.75 - SCORE_PENALTIES.durationOver20s)
  })

  it('caps a different title at 0.40 and a stranger at 0.45', () => {
    const otherSong = score({
      title: 'Save Your Tears',
      artists: ['The Weeknd'],
      durationMs: 200000,
    })
    expect(otherSong.cap).toBe('title')
    expect(otherSong.score).toBe(SCORE_CAPS.title)
    const cover = score({
      title: 'Blinding Lights',
      artists: ['Some Cover Band'],
      durationMs: 200000,
    })
    expect(cover.cap).toBe('artist')
    expect(cover.score).toBe(SCORE_CAPS.artist)
    const both = score({ title: 'Other', artists: ['Nobody'], durationMs: 200000 })
    expect(both.score).toBeLessThanOrEqual(SCORE_CAPS.title)
  })

  it('scales title and artist to 1 in no-duration mode', () => {
    const { durationMs: _, ...noDuration } = SOURCE
    const exact = score(
      { title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 263000 },
      noDuration,
    )
    expect(exact.score).toBe(1)
    expect(exact.deltaMs).toBeUndefined()
    expect(exact.duration).toBeUndefined()
  })

  it('gives a candidate without a duration no duration term', () => {
    const unknown = score({ title: 'Blinding Lights', artists: ['The Weeknd'] })
    expect(unknown.duration).toBeUndefined()
    expect(unknown.score).toBeCloseTo(0.75)
  })

  it('accepts a prepared title', () => {
    const source = prepareSource(SOURCE)
    const side = {
      title: 'The Weeknd - Blinding Lights (Official Video)',
      artists: ['The Weeknd'],
      durationMs: 263000,
    }
    const prepared = prepareCandidateTitle(source, side)
    expect(prepared.core).toBe('blinding lights')
    expect(scoreCandidate(source, side, prepared)).toEqual(scoreCandidate(source, side))
  })
})

describe('title, version and remix helpers', () => {
  it('compares title cores only, so a shared qualifier never makes songs alike', () => {
    const tv = prepareSource({ title: "Love Story (Taylor's Version)", artists: ['Taylor Swift'] })
    const other = prepareCandidateTitle(tv, {
      title: "If This Was A Movie (Taylor's Version)",
      artists: ['Taylor Swift'],
    })
    expect(titleSimilarity(tv.title, other)).toBeLessThan(0.5)
  })

  it('lists the families on each side', () => {
    const source = prepareSource({ title: 'Song (Live)', artists: ['A'] }).title
    const candidate = prepareSource({ title: 'Song (Acoustic) [Remastered]', artists: ['A'] }).title
    expect(versionMismatches(source, candidate)).toEqual([
      { family: 'live', level: 'strong', side: 'source' },
      { family: 'acoustic', level: 'strong', side: 'candidate' },
      { family: 'remaster', level: 'soft', side: 'candidate' },
    ])
    expect(differentRemixes(source, candidate)).toBe(false)
  })
})

describe('sourceSide and trackSide', () => {
  it('read core tracks for the scorer', () => {
    expect(
      sourceSide({
        title: 'Song',
        artists: [{ name: 'A' }, { name: 'B' }],
        album: { name: 'LP' },
        durationMs: 1000,
        explicit: true,
      }),
    ).toEqual({ title: 'Song', artists: ['A', 'B'], album: 'LP', durationMs: 1000, explicit: true })
    expect(sourceSide({ title: 'Song', artists: [] })).toEqual({ title: 'Song', artists: [] })
    expect(
      trackSide(track('x', 'Song', 'A', { album: 'LP', seconds: 2, explicit: false })),
    ).toEqual({
      title: 'Song',
      artists: ['A'],
      album: 'LP',
      durationMs: 2000,
      explicit: false,
    })
    expect(trackSide(track('x', 'Song', ['A', 'B']))).toEqual({
      title: 'Song',
      artists: ['A', 'B'],
    })
  })
})
