import { describe, expect, it } from 'vitest'
import { artistTrackCandidates, planExpansions, songTrackCandidates } from './expand'
import { recSeedOf } from './identity'
import { poolCandidates } from './pool'
import { indexTaste } from './taste'
import { HOUR, NOW, play, profileOf, radio, similarArtists, ytm } from './test-fixtures'
import type { RecCandidate } from './types'

const seed = ytm('s1', 'Copper Sun', 'Aurora Lane')
const known = ytm('k1', 'Static Bloom', 'Basalt')
const taste = indexTaste(
  profileOf([
    play(seed, HOUR),
    play(known, 2 * HOUR),
    play(known, 3 * HOUR),
    play(known, 4 * HOUR),
  ]),
  NOW,
)

function search(title: string, artist: string, rank: number): RecCandidate {
  return {
    type: 'song-search',
    source: 'lastfm',
    part: 'station',
    seed: recSeedOf(seed),
    rank,
    score: 1 - rank / 10,
    title,
    artists: [artist],
  }
}

describe('planExpansions', () => {
  const pool = poolCandidates(
    [
      ...similarArtists(seed, ['Basalt', 'Cinder', 'Dune Theory', 'Ember Fold']),
      ...radio(seed, [
        ytm('d1', 'One', 'Dune Theory'),
        ytm('d2', 'Two', 'Dune Theory'),
        ytm('d3', 'Three', 'Dune Theory'),
      ]),
      search('Night Drive', 'Ember Fold', 0),
      search('Static Bloom', 'Basalt', 1),
      search('Low Tide', 'Fable Kin', 2),
    ],
    { mode: 'music' },
  )

  it('expands new artists first, and none the pool has enough songs by', () => {
    const plan = planExpansions(pool, taste)
    // Basalt ranks first but is well known, so Cinder comes first. Dune Theory has three songs
    // in the pool already.
    expect(plan.artists.map((artist) => artist.key)).toEqual(['cinder', 'basalt', 'ember fold'])
    expect(planExpansions(pool, taste, { maxArtists: 1 }).artists).toHaveLength(1)
  })

  it('searches for songs the user does not know yet, best first', () => {
    const plan = planExpansions(pool, taste)
    expect(plan.songs.map((song) => song.title)).toEqual(['Night Drive', 'Low Tide'])
    expect(planExpansions(pool, taste, { maxSongs: 0 }).songs).toEqual([])
  })
})

describe('artistTrackCandidates', () => {
  it("turns an artist's tracks into candidates that keep its evidence", () => {
    const [cinder] = poolCandidates(similarArtists(seed, ['Cinder']), { mode: 'music' }).artists
    if (cinder === undefined) throw new Error('No artist')
    const candidates = artistTrackCandidates(
      cinder,
      [
        ytm('c1', 'Harbor Lights', 'Cinder'),
        ytm('x1', 'Someone Else', 'Other'),
        ytm('c2', 'Glass', ['Cinder', 'Basalt']),
      ],
      5,
    )
    expect(candidates.map((one) => [one.track.title, one.score, one.part, one.seed.name])).toEqual([
      ['Harbor Lights', 1, 'similar-artists', 'Copper Sun'],
      ['Glass', 0.5, 'similar-artists', 'Copper Sun'],
    ])
    expect(artistTrackCandidates({ ...cinder, evidence: [] }, [ytm('c1', 'A', 'Cinder')])).toEqual(
      [],
    )
  })
})

describe('songTrackCandidates', () => {
  it("gives a found song every piece of the search's evidence", () => {
    const [song] = poolCandidates([search('Night Drive', 'Ember Fold', 0)], { mode: 'music' }).songs
    if (song === undefined) throw new Error('No song')
    const track = ytm('e1', 'Night Drive', 'Ember Fold')
    const candidates = songTrackCandidates(song, track)
    expect(candidates).toEqual([
      {
        type: 'track',
        source: 'lastfm',
        part: 'station',
        seed: recSeedOf(seed),
        rank: 0,
        score: 1,
        track,
      },
    ])
    const pooled = poolCandidates(candidates, { mode: 'music' }).songs[0]
    expect(pooled?.similarity).toBeCloseTo(song.similarity)
  })
})
