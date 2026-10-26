import { describe, expect, it } from 'vitest'
import { createSeededRandom } from '../queue/random'
import {
  createPicker,
  DEFAULT_MMR_LAMBDA,
  DEFAULT_PER_ARTIST_CAP,
  diversify,
  songSimilarity,
} from './diversify'
import type { PooledSong } from './pool'

/** A pooled song: a title by artists, with tags. */
function song(key: string, artists: readonly string[], tags: readonly string[] = []): PooledSong {
  return {
    key,
    keys: [key],
    title: key,
    artists,
    artistKeys: artists.map((name) => name.toLowerCase()),
    tags,
    evidence: [],
    similarity: 0,
  }
}

const item = (
  key: string,
  score: number,
  artists: readonly string[],
  tags?: readonly string[],
) => ({
  song: song(key, artists, tags),
  score,
})

describe('songSimilarity', () => {
  it('is 1 for the same song or main artist, less for a shared credit or tags', () => {
    expect(songSimilarity(song('a', ['X']), song('a', ['Y']))).toBe(1)
    expect(songSimilarity(song('a', ['X']), song('b', ['X']))).toBe(1)
    expect(songSimilarity(song('a', ['X', 'Y']), song('b', ['Z', 'Y']))).toBe(0.7)
    expect(songSimilarity(song('a', ['X'], ['rock', 'indie']), song('b', ['Z'], ['rock']))).toBe(
      0.25,
    )
    expect(songSimilarity(song('a', ['X']), song('b', ['Z']))).toBe(0)
  })
})

describe('diversify', () => {
  const ranked = [
    item('a1', 10, ['A']),
    item('a2', 9.9, ['A']),
    item('a3', 9.8, ['A']),
    item('b1', 9, ['B']),
    item('c1', 8, ['C']),
    item('b2', 7, ['B']),
  ]

  it('keeps the ranking with λ = 1 and no cap', () => {
    const picked = diversify(ranked, { limit: 10, lambda: 1, perArtistCap: Infinity })
    expect(picked.map((one) => one.song.key)).toEqual(['a1', 'a2', 'a3', 'b1', 'c1', 'b2'])
  })

  it('spreads artists out with MMR, as far as λ allows', () => {
    const keys = (lambda: number) =>
      diversify(ranked, { limit: 4, lambda, perArtistCap: Infinity }).map((one) => one.song.key)
    expect(keys(0.5)).toEqual(['a1', 'b1', 'c1', 'a2'])
    // At the default, a much stronger song by the same artist still wins over a weak stranger.
    expect(DEFAULT_MMR_LAMBDA).toBe(0.7)
    expect(keys(DEFAULT_MMR_LAMBDA)).toEqual(['a1', 'b1', 'a2', 'a3'])
  })

  it('caps every credited artist', () => {
    const withFeature = [...ranked, item('x1', 9.95, ['X', 'A'])]
    const picked = diversify(withFeature, { limit: 10, lambda: 1 })
    expect(DEFAULT_PER_ARTIST_CAP).toBe(2)
    expect(picked.map((one) => one.song.key)).toEqual(['a1', 'x1', 'b1', 'c1', 'b2'])
  })

  it('never picks a song twice, and counts what the list already holds', () => {
    const twice = [
      item('a1', 10, ['A']),
      { song: { ...song('a1b', ['Q']), keys: ['a1b', 'a1'] }, score: 9 },
    ]
    expect(diversify(twice, { limit: 5 }).map((one) => one.song.key)).toEqual(['a1'])
    const after = [{ song: song('held', ['A']) }]
    expect(diversify(ranked, { limit: 10, lambda: 1, after }).map((one) => one.song.key)).toEqual([
      'a1',
      'b1',
      'c1',
      'b2',
    ])
  })

  it('handles nothing to pick, a zero limit and scores that are not numbers', () => {
    expect(diversify([], { limit: 5 })).toEqual([])
    expect(diversify(ranked, { limit: 0 })).toEqual([])
    const odd = [item('n', Number.NaN, ['N']), item('m', 1, ['M'])]
    expect(diversify(odd, { limit: 2 }).map((one) => one.song.key)).toEqual(['m', 'n'])
  })

  it('keeps its invariants on random lists, and gives the same result for the same input', () => {
    const random = createSeededRandom(2026)
    for (let round = 0; round < 200; round++) {
      const size = Math.floor(random() * 40)
      const items = Array.from({ length: size }, (_, index) => {
        const artists = [`artist${Math.floor(random() * 6)}`]
        if (random() < 0.2) artists.push(`artist${Math.floor(random() * 6)}`)
        const tags = random() < 0.5 ? [`tag${Math.floor(random() * 3)}`] : []
        return item(`song${index}`, Math.round(random() * 100) / 10, [...new Set(artists)], tags)
      })
      const options = {
        limit: Math.floor(random() * 25),
        lambda: random(),
        perArtistCap: 1 + Math.floor(random() * 3),
      }
      const picked = diversify(items, options)
      expect(picked.length).toBeLessThanOrEqual(options.limit)
      expect(new Set(picked.map((one) => one.song.key)).size).toBe(picked.length)
      for (const one of picked) expect(items).toContain(one)
      const counts = new Map<string, number>()
      for (const one of picked) {
        for (const key of one.song.artistKeys) counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      for (const count of counts.values()) expect(count).toBeLessThanOrEqual(options.perArtistCap)
      // Only the cap or the limit leaves an item out.
      if (picked.length < options.limit) {
        for (const one of items) {
          if (picked.includes(one)) continue
          expect(
            one.song.artistKeys.some((key) => (counts.get(key) ?? 0) >= options.perArtistCap),
          ).toBe(true)
        }
      }
      expect(diversify(items, options)).toEqual(picked)
    }
  })
})

/** MMR as the module documentation states it: every item weighed for every pick. */
function referencePicks<T extends { song: PooledSong; score: number }>(
  items: readonly T[],
  options: { limit: number; lambda: number; perArtistCap: number },
  after: readonly PooledSong[],
  blocked: (song: PooledSong, round: number) => boolean,
): T[] {
  const finite = items.map((one) => one.score).filter(Number.isFinite)
  const max = finite.length === 0 ? 0 : Math.max(...finite)
  const min = finite.length === 0 ? 0 : Math.min(...finite)
  const relevance = (score: number) =>
    !Number.isFinite(score) ? 0 : max - min > 0 ? (score - min) / (max - min) : 1
  const held = [...after]
  const picked: T[] = []
  for (let round = 0; picked.length < options.limit; round++) {
    let best: T | undefined
    let bestValue = -Infinity
    for (const one of items) {
      if (picked.includes(one) || blocked(one.song, round)) continue
      if (one.song.keys.some((key) => held.some((song) => song.keys.includes(key)))) continue
      const count = (key: string) => held.filter((song) => song.artistKeys.includes(key)).length
      if (one.song.artistKeys.some((key) => count(key) >= options.perArtistCap)) continue
      const near = Math.max(0, ...held.map((song) => songSimilarity(one.song, song)))
      const value = options.lambda * relevance(one.score) - (1 - options.lambda) * near
      if (value > bestValue) {
        best = one
        bestValue = value
      }
    }
    if (best === undefined) break
    picked.push(best)
    held.push(best.song)
  }
  return picked
}

describe('createPicker', () => {
  it('picks exactly what weighing every item every time picks, however the list is ordered', () => {
    const random = createSeededRandom(44)
    for (let round = 0; round < 200; round++) {
      const size = Math.floor(random() * 60)
      const items = Array.from({ length: size }, (_, index) => {
        const artists = [`artist${Math.floor(random() * 8)}`]
        if (random() < 0.2) artists.push(`artist${Math.floor(random() * 8)}`)
        const tags = random() < 0.5 ? [`tag${Math.floor(random() * 3)}`] : []
        const score = random() < 0.05 ? Number.NaN : Math.round(random() * 100) / 10
        return item(`song${index}`, score, [...new Set(artists)], tags)
      })
      // Best first, as callers pass them, or in any order.
      if (random() < 0.7) items.sort((a, b) => (b.score || 0) - (a.score || 0))
      const options = {
        limit: Math.floor(random() * 25),
        lambda: random() < 0.1 ? 0 : random() < 0.1 ? 1 : random(),
        perArtistCap: 1 + Math.floor(random() * 3),
      }
      const after = random() < 0.3 ? [song('held', [`artist${Math.floor(random() * 8)}`])] : []
      // Another list takes songs between picks, as in Home's draft.
      const taken = new Set(items.filter(() => random() < 0.2).map((one) => one.song.key))
      const blocked = (one: PooledSong, turn: number) => turn > 1 && taken.has(one.key)
      const picker = createPicker(items, { ...options, after: after.map((one) => ({ song: one })) })
      for (let turn = 0; picker.next((one) => blocked(one, turn)) !== undefined; turn++) {
        // Picks until the list is full or nothing fits.
      }
      expect(picker.picked).toEqual(referencePicks(items, options, after, blocked))
    }
  })
})
