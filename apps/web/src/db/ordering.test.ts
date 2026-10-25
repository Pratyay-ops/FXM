import { describe, expect, it } from 'vitest'
import { createSeededRandom, moveKeys, reconcileOrder, sameOrder, shuffleKeys } from './ordering'

const order = ['a', 'b', 'c', 'd', 'e', 'f']

describe('moveKeys', () => {
  it.each([
    ['top', ['d'], ['d', 'a', 'b', 'c', 'e', 'f']],
    ['bottom', ['b'], ['a', 'c', 'd', 'e', 'f', 'b']],
    ['up', ['c'], ['a', 'c', 'b', 'd', 'e', 'f']],
    ['down', ['c'], ['a', 'b', 'd', 'c', 'e', 'f']],
  ] as const)('moves one item %s', (target, keys, expected) => {
    expect(moveKeys(order, keys, target)).toEqual(expected)
  })

  it('moves a scattered selection to the top or bottom in its own order', () => {
    expect(moveKeys(order, ['e', 'b'], 'top')).toEqual(['b', 'e', 'a', 'c', 'd', 'f'])
    expect(moveKeys(order, ['e', 'b'], 'bottom')).toEqual(['a', 'c', 'd', 'f', 'b', 'e'])
  })

  it('moves every selected item one place up or down, keeping the gaps', () => {
    expect(moveKeys(order, ['b', 'e'], 'up')).toEqual(['b', 'a', 'c', 'e', 'd', 'f'])
    expect(moveKeys(order, ['b', 'e'], 'down')).toEqual(['a', 'c', 'b', 'd', 'f', 'e'])
  })

  it('moves a contiguous block as one', () => {
    expect(moveKeys(order, ['c', 'd'], 'up')).toEqual(['a', 'c', 'd', 'b', 'e', 'f'])
    expect(moveKeys(order, ['c', 'd'], 'down')).toEqual(['a', 'b', 'e', 'c', 'd', 'f'])
  })

  it('leaves a block that already touches the edge where it is', () => {
    expect(moveKeys(order, ['a', 'b', 'd'], 'up')).toEqual(['a', 'b', 'd', 'c', 'e', 'f'])
    expect(moveKeys(order, ['a'], 'up')).toEqual(order)
    expect(moveKeys(order, ['f'], 'down')).toEqual(order)
    expect(moveKeys(order, ['e', 'f'], 'down')).toEqual(order)
  })

  it('drops items before a key, as a drag and drop does', () => {
    expect(moveKeys(order, ['a'], { before: 'd' })).toEqual(['b', 'c', 'a', 'd', 'e', 'f'])
    expect(moveKeys(order, ['e'], { before: 'b' })).toEqual(['a', 'e', 'b', 'c', 'd', 'f'])
    expect(moveKeys(order, ['b', 'e'], { before: 'd' })).toEqual(['a', 'c', 'b', 'e', 'd', 'f'])
  })

  it('drops at the end before null or an unknown key', () => {
    expect(moveKeys(order, ['b'], { before: null })).toEqual(['a', 'c', 'd', 'e', 'f', 'b'])
    expect(moveKeys(order, ['b'], { before: 'zz' })).toEqual(['a', 'c', 'd', 'e', 'f', 'b'])
  })

  it('keeps a block in place when dropped onto itself', () => {
    expect(moveKeys(order, ['b', 'c'], { before: 'b' })).toEqual(order)
    expect(moveKeys(order, ['b', 'c'], { before: 'c' })).toEqual(order)
    expect(moveKeys(order, ['e', 'f'], { before: 'f' })).toEqual(order)
  })

  it('ignores unknown keys and an empty selection, and never changes its input', () => {
    const input = [...order]
    expect(moveKeys(input, ['x'], 'top')).toEqual(order)
    expect(moveKeys(input, [], 'bottom')).toEqual(order)
    moveKeys(input, ['c'], 'top')
    expect(input).toEqual(order)
  })

  it('moves within 5,000 items in linear time', () => {
    const big = Array.from({ length: 5000 }, (_, index) => `k${index}`)
    const selected = big.filter((_, index) => index % 3 === 0)
    const moved = moveKeys(big, selected, 'up')
    expect(moved).toHaveLength(5000)
    expect(new Set(moved).size).toBe(5000)
    expect(moved.slice(0, 5)).toEqual(['k0', 'k1', 'k3', 'k2', 'k4'])
  })
})

describe('shuffleKeys', () => {
  it('is a permutation and leaves the input alone', () => {
    const input = Array.from({ length: 100 }, (_, index) => index)
    const shuffled = shuffleKeys(input, createSeededRandom(7))
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input)
    expect(shuffled).not.toEqual(input)
    expect(input[0]).toBe(0)
  })

  it('is reproducible with a seeded random source', () => {
    expect(shuffleKeys(order, createSeededRandom(42))).toEqual(
      shuffleKeys(order, createSeededRandom(42)),
    )
  })

  it('swaps as Fisher-Yates does: index i with a random index up to i', () => {
    // random() = 0 always picks index 0: [a,b,c] -> swap(2,0) -> [c,b,a] -> swap(1,0) -> [b,c,a]
    expect(shuffleKeys(['a', 'b', 'c'], () => 0)).toEqual(['b', 'c', 'a'])
    // random() just below 1 always picks i itself: nothing moves.
    expect(shuffleKeys(['a', 'b', 'c'], () => 0.999)).toEqual(['a', 'b', 'c'])
  })

  it('treats a faulty random source as 0 instead of indexing out of range', () => {
    expect(shuffleKeys(['a', 'b'], () => Number.NaN)).toEqual(['b', 'a'])
    expect(shuffleKeys(['a', 'b'], () => 7)).toEqual(['a', 'b'])
  })

  it('gives every order of three items about equally often', () => {
    const random = createSeededRandom(1)
    const counts = new Map<string, number>()
    for (let run = 0; run < 6000; run++) {
      const key = shuffleKeys(['a', 'b', 'c'], random).join('')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    expect(counts.size).toBe(6)
    for (const count of counts.values()) expect(count).toBeGreaterThan(850)
  })
})

describe('createSeededRandom', () => {
  it('returns numbers in [0, 1)', () => {
    const random = createSeededRandom(123)
    for (let index = 0; index < 1000; index++) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('reconcileOrder', () => {
  it('keeps the stored order, drops what is gone and puts new items first', () => {
    expect(reconcileOrder(['a', 'b', 'c'], ['x', 'c', 'a'])).toEqual(['x', 'a', 'c'])
  })

  it('can put new items last', () => {
    expect(reconcileOrder(['a', 'b', 'c'], ['x', 'c', 'a'], { missing: 'last' })).toEqual([
      'a',
      'c',
      'x',
    ])
  })

  it('drops duplicates and matches by key, returning the present spelling', () => {
    const keyOf = (id: string) => id.replace(/^yt:/u, 'ytm:')
    expect(reconcileOrder(['ytm:1', 'ytm:2', 'ytm:1'], ['ytm:2', 'yt:1'], { keyOf })).toEqual([
      'yt:1',
      'ytm:2',
    ])
  })
})

describe('sameOrder', () => {
  it('compares keys and positions', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false)
  })
})
