import { describe, expect, it } from 'vitest'
import { createSeededRandom } from '../queue/random'
import { filterHistory, passesHistory } from './history'
import { poolCandidates } from './pool'
import {
  DEFAULT_SCORE_WEIGHTS,
  RECENT_HALF_LIFE_MS,
  SCORE_PRESETS,
  scoreSongs,
  scoreTerms,
  weighTerms,
} from './score'
import { indexTaste } from './taste'
import { DAY, HOUR, like, NOW, play, profileOf, radio, reorder, ytm } from './test-fixtures'

const seed = ytm('s1', 'Copper Sun', 'Aurora Lane')
const favourite = ytm('f1', 'Glass River', 'Aurora Lane')
const sameArtist = ytm('n1', 'Paper Moons', 'Aurora Lane')
const stranger = ytm('n2', 'Far Signal', 'Dune Theory', { popularity: 90 })
const skipped = ytm('k1', 'Low Tide', 'Ember Fold')

const profile = profileOf([
  play(seed, 2 * DAY),
  play(seed, 3 * DAY),
  play(favourite, 30 * HOUR),
  like(favourite, 5 * DAY),
  play(skipped, 3 * HOUR, { completed: false, skipped: true, playedMs: 5_000 }),
  play(skipped, 4 * HOUR, { completed: false, skipped: true, playedMs: 5_000 }),
])
const taste = indexTaste(profile, NOW)
const pool = poolCandidates(radio(seed, [favourite, sameArtist, stranger, skipped]), {
  mode: 'music',
})
const songOf = (title: string) => {
  const song = pool.songs.find((one) => one.title === title)
  if (song === undefined) throw new Error(`No ${title}`)
  return song
}

describe('scoreTerms', () => {
  it('scores a favourite high on affinity and zero on novelty', () => {
    const terms = scoreTerms(songOf('Glass River'), taste)
    expect(terms.affinity).toBeGreaterThan(0.9)
    expect(terms.novelty).toBe(0)
    expect(terms.recent).toBeCloseTo(2 ** (-30 / 24))
  })

  it("scores a new song by a favourite artist on the artist's affinity, and as half new", () => {
    const terms = scoreTerms(songOf('Paper Moons'), taste)
    expect(terms.affinity).toBeCloseTo(0.8)
    expect(terms.novelty).toBeGreaterThan(0)
    expect(terms.novelty).toBeLessThan(1)
    expect(terms.recent).toBe(0)
  })

  it('scores a stranger as fully new, by its popularity', () => {
    const terms = scoreTerms(songOf('Far Signal'), taste)
    expect(terms.affinity).toBe(0)
    expect(terms.novelty).toBe(1)
    expect(terms.popularity).toBeCloseTo(0.9)
    expect(scoreTerms(songOf('Paper Moons'), taste).popularity).toBe(0.5)
  })

  it('penalizes skips and recent plays', () => {
    const terms = scoreTerms(songOf('Low Tide'), taste)
    expect(terms.skip).toBeGreaterThan(0.5)
    expect(terms.recent).toBeCloseTo(2 ** (-3 / 24))
    expect(RECENT_HALF_LIFE_MS).toBe(DAY)
  })

  it('uses another similarity when asked', () => {
    expect(scoreTerms(songOf('Far Signal'), taste, { similarity: () => 0.25 }).similarity).toBe(
      0.25,
    )
  })

  it('weighs the terms, with the penalties subtracted', () => {
    const terms = { affinity: 1, similarity: 1, popularity: 1, novelty: 1, skip: 1, recent: 1 }
    const { affinity, similarity, popularity, novelty, skip, recent } = DEFAULT_SCORE_WEIGHTS
    expect(weighTerms(terms, DEFAULT_SCORE_WEIGHTS)).toBeCloseTo(
      affinity + similarity + popularity + novelty - skip - recent,
    )
  })
})

describe('scoreSongs', () => {
  it('ranks best first, and the presets change the ranking', () => {
    const quick = scoreSongs(pool.songs, taste, { weights: SCORE_PRESETS.quickPicks })
    const discover = scoreSongs(pool.songs, taste, { weights: SCORE_PRESETS.discover })
    const place = (list: typeof quick, title: string) =>
      list.findIndex((one) => one.song.title === title)
    expect(quick.at(-1)?.song.title).toBe('Low Tide')
    expect(discover.at(-1)?.song.title).toBe('Low Tide')
    expect(place(discover, 'Far Signal')).toBeLessThan(place(quick, 'Far Signal'))
    expect(place(discover, 'Glass River')).toBeGreaterThan(place(quick, 'Glass River'))
    for (const list of [quick, discover]) {
      for (let index = 1; index < list.length; index++) {
        expect((list[index - 1]?.score ?? 0) >= (list[index]?.score ?? 0)).toBe(true)
      }
    }
  })

  it('adds the same jitter for the same seed, whatever the order of the songs', () => {
    const options = { jitter: 0.5, random: createSeededRandom(7) }
    const first = scoreSongs(pool.songs, taste, options).map((one) => [one.song.key, one.score])
    const again = scoreSongs(reorder(pool.songs), taste, {
      jitter: 0.5,
      random: createSeededRandom(7),
    }).map((one) => [one.song.key, one.score])
    expect(again).toEqual(first)
    const plain = scoreSongs(pool.songs, taste)
    expect(first.map(([, score]) => score)).not.toEqual(plain.map((one) => one.score))
  })
})

describe('the history filters', () => {
  const scored = scoreSongs(pool.songs, taste)
  const titles = (items: typeof scored) => items.map((item) => item.song.title).sort()

  it('leaves out known songs, recent plays, the last plays and excluded keys', () => {
    expect(titles(filterHistory(scored, taste, { unheard: true }))).toEqual([
      'Far Signal',
      'Paper Moons',
    ])
    expect(titles(filterHistory(scored, taste, { playedWithinMs: 6 * HOUR }))).toEqual([
      'Far Signal',
      'Glass River',
      'Paper Moons',
    ])
    expect(titles(filterHistory(scored, taste, { lastPlays: 3 }))).toEqual([
      'Far Signal',
      'Paper Moons',
    ])
    expect(
      titles(filterHistory(scored, taste, { exclude: new Set(['song:dune theory|far signal']) })),
    ).toEqual(['Glass River', 'Low Tide', 'Paper Moons'])
    expect(filterHistory(scored, taste, {})).toHaveLength(4)
  })

  it('counts a song played on another source as played', () => {
    const elsewhere = poolCandidates(
      radio(seed, [{ ...favourite, id: 'spotify:track:other' as never, source: 'spotify' }]),
      { mode: 'music' },
    ).songs[0]
    expect(
      elsewhere === undefined ? true : passesHistory(elsewhere, taste, { unheard: true }),
    ).toBe(false)
  })
})
