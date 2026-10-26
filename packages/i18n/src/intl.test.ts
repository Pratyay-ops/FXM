import { describe, expect, it } from 'vitest'
import { autonym, createFormatters, numberFormat } from './intl'

const en = createFormatters('en-US')
const gb = createFormatters('en-GB')
const de = createFormatters('de')
const NBSP = ' '

describe('createFormatters', () => {
  it('formats numbers and percentages', () => {
    expect(en.number(1234.5)).toBe('1,234.5')
    expect(de.number(1234.5)).toBe('1.234,5')
    expect(en.number(0.1234, { maximumFractionDigits: 1 })).toBe('0.1')
    expect(en.percent(0.42)).toBe('42%')
    expect(de.percent(0.425, { maximumFractionDigits: 1 })).toBe(`42,5${NBSP}%`)
  })

  it('formats sizes in decimal units, as the downloads list does today', () => {
    expect([0, -5, Number.NaN, 1, 512, 999].map((n) => en.bytes(n))).toEqual([
      '0 bytes',
      '0 bytes',
      '0 bytes',
      '1 byte',
      '512 bytes',
      '999 bytes',
    ])
    expect([1000, 4_200_000, 31_000_000_000, 12_345_678].map((n) => en.bytes(n))).toEqual([
      '1 kB',
      '4.2 MB',
      '31 GB',
      '12 MB',
    ])
    expect(de.bytes(4_200_000)).toBe('4,2 MB')
  })

  it('formats durations as a clock, like the player', () => {
    expect([0, 7.9, 65, 3599, 3600, 3725, -1, Number.NaN].map((s) => en.duration(s))).toEqual([
      '0:00',
      '0:07',
      '1:05',
      '59:59',
      '1:00:00',
      '1:02:05',
      '0:00',
      '0:00',
    ])
    expect(createFormatters('ar-EG').duration(65)).toBe('١:٠٥')
  })

  it('formats durations in words, keeping the two largest units', () => {
    expect([40, 90, 2700, 3600, 3900, 3599].map((s) => en.duration(s, 'short'))).toEqual([
      '40 sec',
      '2 min',
      '45 min',
      '1 hr',
      '1 hr 5 min',
      '1 hr',
    ])
    expect(en.duration(3900, 'long')).toBe('1 hour, 5 minutes')
    expect(en.duration(3900, 'narrow')).toBe('1h 5m')
    expect(de.duration(3900, 'long')).toBe('1 Stunde, 5 Minuten')
  })

  // Local noon and 17:30, so the date is the same day in every time zone the tests run in.
  const day = new Date(2026, 9, 26, 12, 0)
  const evening = new Date(2026, 9, 26, 17, 30)

  it('formats dates and times for the region', () => {
    expect(en.date(day)).toBe('Oct 26, 2026')
    expect(gb.date(day)).toBe('26 Oct 2026')
    expect(de.date(day, 'long')).toBe('26. Oktober 2026')
    expect(en.date(day.getTime(), { month: 'short', day: 'numeric' })).toBe('Oct 26')
    expect(en.time(evening)).toBe('5:30 PM')
    expect(gb.time(evening)).toBe('17:30')
  })

  it('writes nothing for an invalid date rather than throw', () => {
    const invalid = new Date(Number.NaN)
    expect(en.date(invalid)).toBe('')
    expect(en.date(Number.NaN, { month: 'short' })).toBe('')
    expect(en.time(1e20)).toBe('')
    expect(en.timeAgo(invalid)).toBe('')
    expect(en.timeAgo(day, invalid)).toBe('')
  })

  it('formats relative times, with words for the nearest', () => {
    expect(en.relativeTime(-1, 'day')).toBe('yesterday')
    expect(en.relativeTime(3, 'day')).toBe('in 3 days')
    expect(de.relativeTime(-1, 'day')).toBe('gestern')
  })

  it('says how long ago in the largest unit that fits', () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0)
    const ago = (seconds: number) => en.timeAgo(now - seconds * 1000, now)
    expect(ago(0)).toBe('now')
    expect(ago(30)).toBe('30 seconds ago')
    expect(ago(90)).toBe('2 minutes ago')
    expect(ago(3 * 3600)).toBe('3 hours ago')
    expect(ago(30 * 3600)).toBe('yesterday')
    expect(ago(8 * 86400)).toBe('last week')
    expect(ago(45 * 86400)).toBe('last month')
    expect(ago(400 * 86400)).toBe('last year')
    expect(en.timeAgo(new Date(now + 2 * 3600 * 1000), new Date(now))).toBe('in 2 hours')
  })

  it('joins lists the locale’s way', () => {
    expect(en.list(['YouTube Music', 'Internet Archive', 'Jamendo'])).toBe(
      'YouTube Music, Internet Archive, and Jamendo',
    )
    expect(gb.list(['YouTube Music', 'Internet Archive', 'Jamendo'])).toBe(
      'YouTube Music, Internet Archive and Jamendo',
    )
    expect(de.list(['A', 'B'], 'disjunction')).toBe('A oder B')
    expect(en.list([])).toBe('')
  })

  it('names languages in its locale, and in their own', () => {
    expect(en.languageName('de')).toBe('German')
    expect(de.languageName('fr')).toBe('Französisch')
    expect(en.languageName('not a tag')).toBe('not a tag')
    expect(autonym('de')).toBe('Deutsch')
    expect(autonym('pt-BR')).toBe('português (Brasil)')
    expect(autonym('nope!')).toBe('nope!')
  })

  it('sorts numbers by value, ignoring case and accents', () => {
    expect(['Track 10', 'track 2', 'Éclair', 'eclair', 'Zebra'].sort(en.compare)).toEqual([
      'Éclair',
      'eclair',
      'track 2',
      'Track 10',
      'Zebra',
    ])
  })

  it('makes each formatter once', () => {
    expect(numberFormat('fr', { style: 'percent' })).toBe(numberFormat('fr', { style: 'percent' }))
    expect(numberFormat('fr')).not.toBe(numberFormat('fr', { style: 'percent' }))
  })
})
