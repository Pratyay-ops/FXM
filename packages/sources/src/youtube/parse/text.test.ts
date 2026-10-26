import { describe, expect, it } from 'vitest'
import { isYear, parseCount, parseDuration, runsOf, textOf } from './text'

describe('formatted text', () => {
  it('reads runs, simple text and view-model content', () => {
    const endpoint = { browseEndpoint: { browseId: 'UC1' } }
    expect(
      runsOf({
        runs: [{ text: 'a', navigationEndpoint: endpoint }, { text: 'b' }, { bold: true }],
      }),
    ).toEqual([{ text: 'a', endpoint }, { text: 'b' }])
    expect(runsOf({ simpleText: '3:57' })).toEqual([{ text: '3:57' }])
    expect(runsOf({ content: 'Radiohead' })).toEqual([{ text: 'Radiohead' }])
    expect(runsOf('nope')).toEqual([])
    expect(textOf({ runs: [{ text: ' Pablo ' }, { text: 'Honey ' }] })).toBe('Pablo Honey')
    expect(textOf({ runs: [{ text: '  ' }] })).toBeUndefined()
    expect(textOf(undefined)).toBeUndefined()
  })

  it('reads durations', () => {
    expect(parseDuration('3:59')).toBe(239_000)
    expect(parseDuration('0:31')).toBe(31_000)
    expect(parseDuration('12:03')).toBe(723_000)
    expect(parseDuration('1:02:03')).toBe(3_723_000)
    expect(parseDuration(' 4:18 ')).toBe(258_000)
    for (const text of ['3:60', '1:61:00', '1993', '3.59', '', undefined, '1:2']) {
      expect(parseDuration(text)).toBeUndefined()
    }
  })

  it('reads years', () => {
    expect(isYear('1993')).toBe(true)
    expect(isYear('2026')).toBe(true)
    expect(isYear('993')).toBe(false)
    expect(isYear('3:59')).toBe(false)
  })

  it('reads track counts only before one of the given words', () => {
    const words = ['song', 'songs', 'tracks']
    expect(parseCount('12 songs', words)).toBe(12)
    expect(parseCount('1,204 tracks', words)).toBe(1204)
    expect(parseCount('1 song', words)).toBe(1)
    expect(parseCount('34K views', words)).toBeUndefined()
    expect(parseCount('42 minutes', words)).toBeUndefined()
    expect(parseCount('3 hours, 52 minutes', words)).toBeUndefined()
    expect(parseCount('12 Titel', words)).toBeUndefined()
  })
})
