import { describe, expect, it } from 'vitest'
import type { LyricLine, Lyrics } from '../providers'
import { parseLrc } from './lrc'
import { lineAt, wordAt } from './timing'

const song = parseLrc(
  '[00:01.00]One\n[00:02.00]Two\n[00:02.00]Two, echoed\n[00:05.00]\n[00:06.00]Three',
)

describe('lineAt', () => {
  it.each([
    [-1, -1],
    [0, -1],
    [999, -1],
    [1_000, 0],
    [1_999, 0],
    [2_000, 2],
    [4_999.5, 2],
    [5_000, 3],
    [6_000, 4],
    [10_000_000, 4],
    [Number.POSITIVE_INFINITY, 4],
    [Number.NaN, -1],
  ])('at %d ms is line %d', (timeMs, index) => {
    expect(lineAt(song, timeMs)).toBe(index)
  })

  it('finds no line in unsynced or empty lyrics', () => {
    expect(lineAt(parseLrc('One\nTwo'), 1_000)).toBe(-1)
    expect(lineAt({ synced: true, lines: [], source: 'test' }, 1_000)).toBe(-1)
  })

  it('agrees with a linear scan on a long song', () => {
    // A deterministic pseudo-random song: 2,000 lines, some starting together.
    let seed = 42
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    let timeMs = 0
    const lines: LyricLine[] = Array.from({ length: 2_000 }, (_, i) => {
      timeMs += random() < 0.1 ? 0 : Math.floor(random() * 5_000)
      return { timeMs, text: `Line ${i}` }
    })
    const lyrics: Lyrics = { synced: true, lines, source: 'test' }
    const linear = (at: number) => lines.findLastIndex((line) => (line.timeMs ?? 0) <= at)
    for (let probe = 0; probe < 1_000; probe++) {
      const at = Math.floor(random() * (timeMs + 10_000)) - 5_000
      expect(lineAt(lyrics, at)).toBe(linear(at))
    }
  })

  it('treats a line without a start time as starting with the line before it', () => {
    const lyrics: Lyrics = {
      synced: true,
      lines: [
        { timeMs: 1_000, text: 'One' },
        { text: 'Untimed' },
        { timeMs: 3_000, text: 'Three' },
      ],
      source: 'test',
    }
    expect([500, 1_000, 2_000, 3_000].map((at) => lineAt(lyrics, at))).toEqual([-1, 1, 1, 2])
    const untimedFirst: Lyrics = { ...lyrics, lines: [{ text: 'Untimed' }, ...lyrics.lines] }
    expect([0, 1_000].map((at) => lineAt(untimedFirst, at))).toEqual([0, 2])
  })
})

describe('wordAt', () => {
  const [line] = parseLrc('[00:10.00]<00:10.00>Sing <00:10.50>it <00:11.00>slowly<00:12.00>').lines
  if (line === undefined) throw new Error('expected a line')

  it.each([
    [9_999, -1],
    [10_000, 0],
    [10_499, 0],
    [10_500, 1],
    [11_000, 2],
    [12_000, 2],
    [60_000, 2],
    [Number.NaN, -1],
  ])('at %d ms is word %d', (timeMs, index) => {
    expect(wordAt(line, timeMs)).toBe(index)
  })

  it('finds no word in a line without word timing', () => {
    const [plain] = parseLrc('[00:10.00]Sing it slowly').lines
    if (plain === undefined) throw new Error('expected a line')
    expect(wordAt(plain, 11_000)).toBe(-1)
  })
})
