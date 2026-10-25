import { describe, expect, it } from 'vitest'
import { formatTime } from './format-time'

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [5.9, '0:05'],
    [65, '1:05'],
    [599, '9:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTime(seconds)).toBe(expected)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('shows %s as 0:00', (seconds) => {
    expect(formatTime(seconds)).toBe('0:00')
  })
})
