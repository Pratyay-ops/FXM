import { describe, expect, it, vi } from 'vitest'
import { formatToParts, formatToString, type Values } from './format'
import { parseMessage } from './parse'

const format = (message: string, values: Values = {}, locale = 'en') =>
  formatToString(parseMessage(message), { locale, values })

// Local noon and 17:30, so the date is the same day in every time zone the tests run in.
const day = new Date(2026, 9, 26, 12, 0)
const evening = new Date(2026, 9, 26, 17, 30)

describe('formatToString', () => {
  it('puts values in, formatting numbers and dates for the locale', () => {
    expect(format('By {artist}', { artist: 'Radiohead' })).toBe('By Radiohead')
    expect(format('{n} plays', { n: 1234567.5 })).toBe('1,234,567.5 plays')
    expect(format('{n} plays', { n: 1234567.5 }, 'de')).toBe('1.234.567,5 plays')
    expect(format('{n} plays', { n: 1234567 }, 'en-IN')).toBe('12,34,567 plays')
    expect(format('Added {at}', { at: day }, 'en-GB')).toBe('Added 26 Oct 2026')
  })

  it('formats number, date and time arguments in their styles', () => {
    expect(format('{n, number, integer}', { n: 2.6 })).toBe('3')
    expect(format('{n, number, percent}', { n: 0.42 })).toBe('42%')
    // German puts a no-break space before the sign.
    expect(format('{n, number, percent}', { n: 0.42 }, 'de')).toBe('42\u00a0%')
    expect(format('{d, date, long}', { d: day }, 'en-US')).toBe('October 26, 2026')
    expect(format('{d, date, short}', { d: day.getTime() }, 'de')).toBe('26.10.26')
    expect(format('{t, time, short}', { t: evening }, 'en-US')).toBe('5:30 PM')
    expect(format('{t, time, short}', { t: evening }, 'de')).toBe('17:30')
  })

  it('chooses the plural form by the locale’s rules, after exact options', () => {
    const songs = '{n, plural, =0 {No songs} one {# song} other {# songs}}'
    expect(format(songs, { n: 0 })).toBe('No songs')
    expect(format(songs, { n: 1 })).toBe('1 song')
    expect(format(songs, { n: 1000 })).toBe('1,000 songs')
    expect(format(songs, { n: 1.5 })).toBe('1.5 songs')

    const polish = '{n, plural, one {# utwór} few {# utwory} many {# utworów} other {# utworu}}'
    expect([1, 2, 5, 22, 25, 1.5].map((n) => format(polish, { n }, 'pl'))).toEqual([
      '1 utwór',
      '2 utwory',
      '5 utworów',
      '22 utwory',
      '25 utworów',
      '1,5 utworu',
    ])

    const arabic =
      '{n, plural, zero {لا أغاني} one {أغنية واحدة} two {أغنيتان} few {# أغانٍ} many {# أغنية} other {# أغنية}}'
    expect(format(arabic, { n: 0 }, 'ar')).toBe('لا أغاني')
    expect(format(arabic, { n: 2 }, 'ar')).toBe('أغنيتان')
    expect(format(arabic, { n: 3 }, 'ar')).toBe('3 أغانٍ')
    expect(format(arabic, { n: 3 }, 'ar-EG')).toBe('٣ أغانٍ')
  })

  it('formats ordinals with selectordinal', () => {
    const place = '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}'
    expect([1, 2, 3, 4, 11, 21, 102].map((n) => format(place, { n }))).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '21st',
      '102nd',
    ])
  })

  it('selects by the value, else other', () => {
    const tier = '{tier, select, free {Free only} lite {Lite} other {Full}}'
    expect(format(tier, { tier: 'lite' })).toBe('Lite')
    expect(format(tier, { tier: 'full' })).toBe('Full')
    expect(format(tier, { tier: 'constructor' })).toBe('Full')
    expect(format('{on, select, true {On} other {Off}}', { on: true })).toBe('On')
  })

  it('counts # in a select inside a plural', () => {
    const message = '{n, plural, other {{kind, select, liked {# liked} other {# saved}}}}'
    expect(format(message, { n: 3, kind: 'liked' })).toBe('3 liked')
  })

  it('keeps only the content of tags', () => {
    expect(format('Read <link>the notes</link>.')).toBe('Read the notes.')
  })

  it('shows {name} for a missing or unusable value, and says so', () => {
    const onProblem = vi.fn()
    const nodes = parseMessage('{a} {n, plural, other {#}} {d, date} {s, select, x {X} other {Y}}')
    expect(formatToString(nodes, { locale: 'en', values: { n: 'two' }, onProblem })).toBe(
      '{a} {n} {d} Y',
    )
    expect(onProblem.mock.calls).toEqual([
      [{ kind: 'missing', name: 'a' }],
      [{ kind: 'type', name: 'n' }],
      [{ kind: 'missing', name: 'd' }],
      [{ kind: 'missing', name: 's' }],
    ])
  })

  it('shows {name} for an invalid date instead of throwing, and says so', () => {
    const onProblem = vi.fn()
    const nodes = parseMessage('Added {a, date} at {b, time}; {c}')
    const invalid = new Date(Number.NaN)
    expect(
      formatToString(nodes, {
        locale: 'en',
        values: { a: invalid, b: 1e20, c: invalid },
        onProblem,
      }),
    ).toBe('Added {a} at {b}; {c}')
    expect(onProblem.mock.calls).toEqual([
      [{ kind: 'type', name: 'a' }],
      [{ kind: 'type', name: 'b' }],
      [{ kind: 'type', name: 'c' }],
    ])
  })

  it('reads only its own properties of the values', () => {
    expect(format('{toString}', {})).toBe('{toString}')
  })
})

describe('formatToParts', () => {
  it('renders tags with the renderer and joins adjacent text', () => {
    const parts = formatToParts(parseMessage('Removed {title} from <link>{playlist}</link>!'), {
      locale: 'en',
      values: { title: 'Creep', playlist: 'Mix' },
      tag: (name, children) => ({ name, children }),
    })
    expect(parts).toEqual(['Removed Creep from ', { name: 'link', children: ['Mix'] }, '!'])
  })

  it('renders nested tags inside out, and # inside a tag', () => {
    const parts = formatToParts(
      parseMessage('{n, plural, other {<b>#</b> in <i><b>all</b></i>}}'),
      {
        locale: 'en',
        values: { n: 4 },
        tag: (name, children) => `[${name}:${children.join('')}]`,
      },
    )
    expect(parts).toEqual(['[b:4] in [i:[b:all]]'])
  })

  it('inlines a tag whose renderer returns nothing', () => {
    const parts = formatToParts(parseMessage('a <x>b</x> c'), {
      locale: 'en',
      tag: () => undefined,
    })
    expect(parts).toEqual(['a b c'])
  })
})
