/**
 * Randomness for the queue: an injectable random source, a Fisher-Yates shuffle and a seeded
 * generator for reproducible shuffles in tests.
 *
 * @module
 */

/**
 * A source of random numbers in `[0, 1)`, like `Math.random`. Inject a seeded one (see
 * {@link createSeededRandom}) to make a shuffle reproducible.
 */
export type RandomSource = () => number

/**
 * A uniform random index in `[0, size)`. Values outside `[0, 1)` from a faulty source are
 * clamped instead of producing an index out of range.
 */
function randomIndex(random: RandomSource, size: number): number {
  const value = random()
  const index = Math.floor((Number.isFinite(value) ? value : 0) * size)
  return Math.min(Math.max(index, 0), size - 1)
}

/**
 * A shuffled copy of `items` (Fisher-Yates), leaving `items` untouched. With a uniform
 * `random`, every order is equally likely.
 */
export function fisherYatesShuffle<T>(
  items: readonly T[],
  random: RandomSource = Math.random,
): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(random, i + 1)
    const item = result[i] as T
    result[i] = result[j] as T
    result[j] = item
  }
  return result
}

/**
 * A fast seeded random source (Mulberry32): the same seed always gives the same sequence. For
 * reproducible shuffles in tests and previews, not for anything that needs to be unpredictable.
 */
export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
