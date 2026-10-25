import { describe, expect, it } from 'vitest'
import { createSeededRandom, fisherYatesShuffle } from './random'

describe('fisherYatesShuffle', () => {
  it('returns a permutation and leaves the input untouched', () => {
    const items = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8])
    const shuffled = fisherYatesShuffle(items, createSeededRandom(1))
    expect([...shuffled].sort((a, b) => a - b)).toEqual([...items])
    expect(shuffled).not.toBe(items)
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('handles empty and one-item lists', () => {
    expect(fisherYatesShuffle([])).toEqual([])
    expect(fisherYatesShuffle(['a'])).toEqual(['a'])
  })

  it('is reproducible with a seeded source', () => {
    const items = Array.from({ length: 20 }, (_, i) => i)
    expect(fisherYatesShuffle(items, createSeededRandom(42))).toEqual(
      fisherYatesShuffle(items, createSeededRandom(42)),
    )
    expect(fisherYatesShuffle(items, createSeededRandom(42))).not.toEqual(
      fisherYatesShuffle(items, createSeededRandom(43)),
    )
  })

  it.each([0, 0.999_999, 1, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'stays a permutation when the source returns %s',
    (value) => {
      const shuffled = fisherYatesShuffle([1, 2, 3, 4], () => value)
      expect([...shuffled].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    },
  )

  it('makes every order about equally likely', () => {
    const random = createSeededRandom(2024)
    const counts = new Map<string, number>()
    const runs = 60_000
    for (let i = 0; i < runs; i += 1) {
      const order = fisherYatesShuffle(['a', 'b', 'c'], random).join('')
      counts.set(order, (counts.get(order) ?? 0) + 1)
    }
    expect([...counts.keys()].sort()).toEqual(['abc', 'acb', 'bac', 'bca', 'cab', 'cba'])
    for (const count of counts.values()) {
      expect(Math.abs(count - runs / 6)).toBeLessThan((runs / 6) * 0.05)
    }
  })

  it('puts each item in each position about equally often', () => {
    const random = createSeededRandom(7)
    const size = 6
    const runs = 30_000
    const positions = Array.from({ length: size }, () => new Array<number>(size).fill(0))
    const items = Array.from({ length: size }, (_, i) => i)
    for (let i = 0; i < runs; i += 1) {
      fisherYatesShuffle(items, random).forEach((item, position) => {
        const row = positions[item] as number[]
        row[position] = (row[position] ?? 0) + 1
      })
    }
    for (const row of positions) {
      for (const count of row) expect(Math.abs(count - runs / size)).toBeLessThan(runs / size / 10)
    }
  })
})

describe('createSeededRandom', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = createSeededRandom(5)
    const b = createSeededRandom(5)
    const sequence = Array.from({ length: 10 }, () => a())
    expect(Array.from({ length: 10 }, () => b())).toEqual(sequence)
    expect(new Set(sequence).size).toBe(10)
  })

  it('returns numbers in [0, 1)', () => {
    const random = createSeededRandom(0xffff_ffff)
    for (let i = 0; i < 10_000; i += 1) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
