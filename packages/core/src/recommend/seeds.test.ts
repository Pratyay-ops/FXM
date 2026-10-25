import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import { recSeedOf } from './identity'
import { planSeeds, seedWeight } from './seeds'
import { indexTaste } from './taste'
import { artist, DAY, HOUR, like, NOW, play, profileOf, ytm } from './test-fixtures'

const a1 = ytm('a1', 'Glass River', 'Aurora Lane')
const a2 = ytm('a2', 'Paper Moons', 'Aurora Lane')
const b1 = ytm('b1', 'Static Bloom', 'Basalt')
const c1 = ytm('c1', 'Harbor Lights', 'Cinder')
const d1 = ytm('d1', 'Low Tide', 'Dune Theory')
const video = ytm('m1', 'Night Drive (Official Video)', 'Ember Fold', { kind: 'music-video' })

const history = [
  play(a1, HOUR),
  play(b1, 2 * HOUR),
  play(a2, 3 * HOUR),
  play(c1, 4 * HOUR, { completed: false, skipped: true, playedMs: 4_000 }),
  play(video, 5 * HOUR),
  play(d1, 20 * DAY),
  play(a1, 2 * DAY),
  play(a1, 3 * DAY),
  like(a1, 4 * DAY),
]

describe('planSeeds', () => {
  const taste = indexTaste(profileOf(history), NOW)
  const seeds = planSeeds(taste, { mode: 'music' })
  const byPurpose = (purpose: string) =>
    seeds.filter((seed) => seed.purposes.includes(purpose as never)).map((seed) => seed.ref.name)

  it("seeds Because you listened with the latest plays that weren't skipped, one per artist", () => {
    // Aurora Lane's second play, the skipped play, the video (Music mode) and the play older
    // than 14 days are left out.
    expect(byPurpose('because')).toEqual(['Glass River', 'Static Bloom'])
  })

  it("seeds a mix per top artist, with the artist's favourite track", () => {
    const mixes = seeds.filter((seed) => seed.purposes.includes('mix'))
    // Ember Fold's only track is a video, which can't seed in Music mode: the artist does.
    // Dune Theory, played once 20 days ago, and the skipped Cinder say too little.
    expect(mixes.map((seed) => seed.ref.name)).toEqual([
      'Glass River',
      'Static Bloom',
      'Ember Fold',
    ])
    expect(mixes[2]?.seed).toEqual({ name: 'Ember Fold' })
    expect(mixes[0]?.parts).toEqual(['radio', 'similar-artists', 'station'])
    expect(mixes[1]?.parts).toEqual(['radio', 'similar-artists'])
    expect(mixes[2]?.parts).toEqual(['radio'])
    expect(byPurpose('discover')).toEqual(['Glass River', 'Static Bloom'])
  })

  it('seeds Quick picks with the favourite tracks, merging duplicates', () => {
    expect(byPurpose('quick-picks')).toEqual(['Glass River', 'Static Bloom'])
    expect(new Set(seeds.map((seed) => seed.key)).size).toBe(seeds.length)
    expect(seeds[0]?.purposes).toEqual(['because', 'mix', 'discover', 'quick-picks'])
  })

  it('weighs seeds by how much the user likes them, from 0.5 to 1', () => {
    expect(seeds[0]?.weight).toBe(1)
    for (const seed of seeds) {
      expect(seed.weight).toBeGreaterThanOrEqual(0.5)
      expect(seed.weight).toBeLessThanOrEqual(1)
    }
    expect(seedWeight(taste, recSeedOf(artist('Nobody')))).toBe(0.5)
    expect(seedWeight(taste, recSeedOf(a1))).toBe(1)
    expect(seedWeight(taste, null as never)).toBe(0.5)
  })

  it('lets the video seed in Music + Video mode', () => {
    const all = planSeeds(taste, { mode: 'all', because: 5 })
    expect(
      all.filter((seed) => seed.purposes.includes('because')).map((seed) => seed.ref.name),
    ).toEqual(['Glass River', 'Static Bloom', 'Night Drive (Official Video)'])
  })

  it('stays within the most seeds', () => {
    expect(planSeeds(taste, { mode: 'music', maxSeeds: 2 })).toHaveLength(2)
    expect(planSeeds(taste, { mode: 'music', maxSeeds: 0 })).toEqual([])
  })

  it('seeds a cold start from the onboarding picks, by artist', () => {
    const picks = indexTaste(
      {
        picks: {
          artists: [
            { name: 'Aurora Lane', id: formatId('ytm', 'artist', 'UCa') },
            { name: 'Basalt' },
            { name: 'Cinder' },
          ],
          genres: [],
          at: NOW - HOUR,
        },
      },
      NOW,
    )
    const cold = planSeeds(picks, { mode: 'music' })
    expect(cold.map((seed) => seed.seed)).toEqual([
      { id: 'ytm:artist:UCa', name: 'Aurora Lane' },
      { name: 'Basalt' },
      { name: 'Cinder' },
    ])
    expect(cold.every((seed) => seed.purposes.includes('mix'))).toBe(true)
    expect(planSeeds(indexTaste({}, NOW), { mode: 'music' })).toEqual([])
  })
})
