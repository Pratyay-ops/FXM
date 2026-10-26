// @vitest-environment node
// The arithmetic of the timings: no DOM.
import { describe, expect, it } from 'vitest'
import {
  cumulativeLayoutShift,
  type InteractionEntry,
  interactionToNextPaint,
  largestContentfulPaint,
  median,
} from './vitals'

describe('largestContentfulPaint', () => {
  it('is the last largest paint', () => {
    const paints = [
      { startTime: 400, size: 100, element: 'h1' },
      { startTime: 1200, size: 900, element: 'p.intro' },
    ]
    expect(largestContentfulPaint(paints)?.element).toBe('p.intro')
    expect(largestContentfulPaint([])).toBeUndefined()
  })
})

describe('cumulativeLayoutShift', () => {
  const shift = (startTime: number, value: number, hadRecentInput = false) => ({
    startTime,
    value,
    hadRecentInput,
  })

  it('sums a burst of shifts less than 1 s apart', () => {
    expect(
      cumulativeLayoutShift([shift(100, 0.05), shift(900, 0.05), shift(1800, 0.05)]),
    ).toBeCloseTo(0.15)
  })

  it('takes the largest session window, a gap of 1 s or more starting a new one', () => {
    expect(
      cumulativeLayoutShift([shift(100, 0.02), shift(1500, 0.05), shift(2000, 0.04)]),
    ).toBeCloseTo(0.09)
  })

  it('ends a window after 5 s, however close the shifts', () => {
    const shifts = Array.from({ length: 12 }, (_, index) => shift(index * 800, 0.01))
    // 0 to 4.8 s is the first window (7 shifts); 5.6 s starts the next (5 shifts).
    expect(cumulativeLayoutShift(shifts)).toBeCloseTo(0.07)
  })

  it('leaves out shifts right after an input', () => {
    expect(cumulativeLayoutShift([shift(100, 0.3, true), shift(300, 0.01)])).toBe(0.01)
    expect(cumulativeLayoutShift([])).toBe(0)
  })
})

describe('interactionToNextPaint', () => {
  const event = (
    interactionId: number,
    duration: number,
    name = 'pointerup',
  ): InteractionEntry => ({
    interactionId,
    name,
    startTime: interactionId * 1000,
    duration,
  })

  it('is the longest interaction, each counted by its longest event', () => {
    expect(
      interactionToNextPaint([event(1, 40, 'pointerdown'), event(1, 96, 'click'), event(2, 64)]),
    ).toBe(96)
  })

  it('leaves out one outlier per 50 interactions', () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      event(index + 1, index === 7 ? 900 : 48),
    )
    entries.push(event(99, 200))
    expect(interactionToNextPaint(entries)).toBe(200)
  })

  it('is 0 when no interaction took 16 ms', () => {
    expect(interactionToNextPaint([])).toBe(0)
  })
})

describe('median', () => {
  it('is the middle value, or the mean of the middle two', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(() => median([])).toThrow()
  })
})
