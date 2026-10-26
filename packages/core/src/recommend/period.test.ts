import { describe, expect, it } from 'vitest'
import { hashSeed, periodKey, seededRandomFor } from './period'

describe('periodKey', () => {
  it('names the local day', () => {
    const late = Date.UTC(2026, 9, 25, 22, 30)
    expect(periodKey('day', late)).toBe('2026-10-25')
    // 22:30 UTC is already the next morning in India (UTC+5:30).
    expect(periodKey('day', late, 330)).toBe('2026-10-26')
    expect(periodKey('day', Date.UTC(2026, 9, 26, 3), -300)).toBe('2026-10-25')
  })

  it('names ISO weeks, which start on Monday', () => {
    expect(periodKey('week', Date.UTC(2026, 9, 26))).toBe('2026-W44') // a Monday
    expect(periodKey('week', Date.UTC(2026, 10, 1, 23))).toBe('2026-W44') // its Sunday
    expect(periodKey('week', Date.UTC(2026, 10, 2))).toBe('2026-W45')
  })

  it('gives a week at a year boundary the year of its Thursday', () => {
    expect(periodKey('week', Date.UTC(2026, 0, 1))).toBe('2026-W01') // a Thursday
    expect(periodKey('week', Date.UTC(2025, 11, 29))).toBe('2026-W01') // Monday of that week
    expect(periodKey('week', Date.UTC(2027, 0, 1))).toBe('2026-W53') // a Friday
    expect(periodKey('week', Date.UTC(2024, 11, 30))).toBe('2025-W01')
    expect(periodKey('week', Date.UTC(2021, 0, 3))).toBe('2020-W53')
  })

  it('treats a time that is not a number as the epoch', () => {
    expect(periodKey('day', Number.NaN)).toBe('1970-01-01')
    expect(periodKey('day', 0, Number.NaN)).toBe('1970-01-01')
  })
})

describe('seededRandomFor', () => {
  it('gives the same sequence for the same parts, and another for others', () => {
    const draw = (random: () => number) => [random(), random(), random()]
    expect(draw(seededRandomFor('discover', '2026-W44'))).toEqual(
      draw(seededRandomFor('discover', '2026-W44')),
    )
    expect(draw(seededRandomFor('discover', '2026-W45'))).not.toEqual(
      draw(seededRandomFor('discover', '2026-W44')),
    )
    for (const value of draw(seededRandomFor('x'))) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('hashes with 32-bit FNV-1a', () => {
    expect(hashSeed('')).toBe(0x811c9dc5)
    expect(hashSeed('a')).toBe(0xe40c292c)
  })
})
