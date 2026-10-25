import { describe, expect, it } from 'vitest'
import { wholeNumber } from './numbers'

describe('wholeNumber', () => {
  it('rounds down and clamps a finite number', () => {
    expect(wholeNumber(2.7, 10)).toBe(2)
    expect(wholeNumber(-1, 10)).toBe(0)
    expect(wholeNumber(500, 10, 1, 200)).toBe(200)
    expect(wholeNumber(0, 10, 1, 200)).toBe(1)
  })

  it('falls back for anything that is not a finite number', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '5', undefined, null]) {
      expect(wholeNumber(value, 10)).toBe(10)
    }
  })
})
