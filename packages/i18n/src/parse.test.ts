import { describe, expect, it } from 'vitest'
import { MessageSyntaxError, parseMessage } from './parse'

describe('parseMessage', () => {
  it('reads plain text as one piece', () => {
    expect(parseMessage('Library')).toEqual(['Library'])
    expect(parseMessage('')).toEqual([])
  })

  it('reads values, with or without spaces', () => {
    expect(parseMessage('By {artist}, {  year }')).toEqual([
      'By ',
      { type: 'value', name: 'artist' },
      ', ',
      { type: 'value', name: 'year' },
    ])
  })

  it('reads number, date and time arguments with their styles', () => {
    expect(parseMessage('{n, number}{n, number, integer}{n,number,percent}')).toEqual([
      { type: 'number', name: 'n' },
      { type: 'number', name: 'n', style: 'integer' },
      { type: 'number', name: 'n', style: 'percent' },
    ])
    expect(parseMessage('{d, date}{d, date, long}{t, time, short}')).toEqual([
      { type: 'date', name: 'd', style: 'medium' },
      { type: 'date', name: 'd', style: 'long' },
      { type: 'time', name: 't', style: 'short' },
    ])
  })

  it('reads plurals with exact options and #', () => {
    expect(parseMessage('{count, plural, =0 {No songs} one {# song} other {# songs}}')).toEqual([
      {
        type: 'plural',
        name: 'count',
        ordinal: false,
        options: {
          '=0': ['No songs'],
          one: [{ type: 'pound' }, ' song'],
          other: [{ type: 'pound' }, ' songs'],
        },
      },
    ])
  })

  it('reads selectordinal as an ordinal plural', () => {
    const [node] = parseMessage('{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}')
    expect(node).toMatchObject({ type: 'plural', ordinal: true })
  })

  it('reads selects, and keeps # as the plural number inside them', () => {
    expect(
      parseMessage('{n, plural, other {{kind, select, liked {# liked} other {# saved}}}}'),
    ).toEqual([
      {
        type: 'plural',
        name: 'n',
        ordinal: false,
        options: {
          other: [
            {
              type: 'select',
              name: 'kind',
              options: {
                liked: [{ type: 'pound' }, ' liked'],
                other: [{ type: 'pound' }, ' saved'],
              },
            },
          ],
        },
      },
    ])
  })

  it('keeps # as text outside plurals', () => {
    expect(parseMessage('Track #{n}')).toEqual(['Track #', { type: 'value', name: 'n' }])
  })

  it('reads tags, nested and inside options', () => {
    expect(parseMessage('Read <link>the <b>notes</b></link>.')).toEqual([
      'Read ',
      {
        type: 'tag',
        name: 'link',
        children: ['the ', { type: 'tag', name: 'b', children: ['notes'] }],
      },
      '.',
    ])
    expect(parseMessage('{n, plural, other {<b>#</b> songs}}')).toEqual([
      {
        type: 'plural',
        name: 'n',
        ordinal: false,
        options: { other: [{ type: 'tag', name: 'b', children: [{ type: 'pound' }] }, ' songs'] },
      },
    ])
  })

  it('keeps a < that starts no tag as text', () => {
    expect(parseMessage('Under <5 minutes, a < b')).toEqual(['Under <5 minutes, a < b'])
  })

  it('keeps a self-closing tag as text, as FormatJS does', () => {
    expect(parseMessage('a<br/>b <img />')).toEqual(['a<br/>b <img />'])
  })

  it('quotes as ICU does, so ordinary apostrophes need nothing', () => {
    expect(parseMessage("Can't play {title}")).toEqual([
      "Can't play ",
      { type: 'value', name: 'title' },
    ])
    expect(parseMessage("It''s '{literal}' and '<b>'")).toEqual(["It's {literal} and <b>"])
    expect(parseMessage("'{unterminated")).toEqual(['{unterminated'])
    expect(parseMessage("{n, plural, other {'#' is #}}")).toEqual([
      {
        type: 'plural',
        name: 'n',
        ordinal: false,
        options: { other: ['# is ', { type: 'pound' }] },
      },
    ])
    expect(parseMessage("'it''s' quoted? No: 'its'")).toEqual(["'it's' quoted? No: 'its'"])
  })

  it.each([
    ['{', 'Expected an argument name'],
    ['{name', 'Expected "}" or ","'],
    ['{name, plural}', 'Expected ","'],
    ['text }', 'Unexpected "}"'],
    ['{n, plural, one {#}}', 'Expected an "other" option'],
    ['{n, plural, single {#} other {#}}', 'Unknown plural category "single"'],
    ['{n, plural, other {a} other {b}}', 'Option "other" appears twice'],
    ['{n, plural, offset:1 other {#}}', '"offset:" is not supported'],
    ['{n, choice, 0#none|1#one}', 'Unsupported argument type "choice"'],
    ['{n, number, ::currency/EUR}', 'Expected number style'],
    ['{n, number, currency}', 'Unsupported number style "currency"'],
    ['{d, date, yMMMd}', 'Unsupported date style "yMMMd"'],
    ['<b>bold', 'Expected </b>'],
    ['bold</b>', 'Unexpected </b>'],
    ['<a><b>x</a></b>', 'Expected </b>'],
    ['{n, plural, other {<b>#}</b>}', 'Expected </b>'],
  ])('refuses %j', (message, reason) => {
    expect(() => parseMessage(message)).toThrow(MessageSyntaxError)
    expect(() => parseMessage(message)).toThrow(reason)
  })

  it('says where it stopped', () => {
    try {
      parseMessage('Hi {name')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(MessageSyntaxError)
      expect((error as MessageSyntaxError).offset).toBe(8)
      expect((error as MessageSyntaxError).source).toBe('Hi {name')
    }
  })
})
