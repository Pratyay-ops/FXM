import { describe, expect, it } from 'vitest'
import type { Lyrics } from '../providers'
import { parseLrc, serializeLrc } from './lrc'

/** Tricky LRC samples, and what each parses to (the source is always `lrc`). */
const SAMPLES: ReadonlyArray<[name: string, text: string, lyrics: Omit<Lyrics, 'source'>]> = [
  [
    'one timestamp per line',
    '[00:12.00]Line one\n[00:17.20]Line two\n[00:21.10]Line three',
    {
      synced: true,
      lines: [
        { timeMs: 12_000, text: 'Line one' },
        { timeMs: 17_200, text: 'Line two' },
        { timeMs: 21_100, text: 'Line three' },
      ],
    },
  ],
  [
    'every timestamp format',
    [
      '[0:5.5]single digits',
      '[01:02]whole seconds',
      '[01:02.34]hundredths',
      '[01:02:34]colon before the fraction',
      '[01:02.345]milliseconds',
      '[01:02.3456]more digits',
      '[01:02.5]tenths',
      '[ 01:03.00 ]spaces inside',
      '[100:00.00]past 99 minutes',
      '[-00:01.00]negative',
    ].join('\n'),
    {
      synced: true,
      lines: [
        { timeMs: 0, text: 'negative' },
        { timeMs: 5_500, text: 'single digits' },
        { timeMs: 62_000, text: 'whole seconds' },
        { timeMs: 62_340, text: 'hundredths' },
        { timeMs: 62_340, text: 'colon before the fraction' },
        { timeMs: 62_345, text: 'milliseconds' },
        { timeMs: 62_346, text: 'more digits' },
        { timeMs: 62_500, text: 'tenths' },
        { timeMs: 63_000, text: 'spaces inside' },
        { timeMs: 6_000_000, text: 'past 99 minutes' },
      ],
    },
  ],
  [
    'several timestamps on one line',
    '[00:10.00]Verse\n[00:20.00] [00:40.00] Chorus\n[00:30.00]Bridge',
    {
      synced: true,
      lines: [
        { timeMs: 10_000, text: 'Verse' },
        { timeMs: 20_000, text: 'Chorus' },
        { timeMs: 30_000, text: 'Bridge' },
        { timeMs: 40_000, text: 'Chorus' },
      ],
    },
  ],
  [
    'a positive offset, which shows the lyrics sooner but never before zero',
    '[offset:+500]\n[00:10.00]Later\n[00:00.20]Sooner',
    {
      synced: true,
      lines: [
        { timeMs: 0, text: 'Sooner' },
        { timeMs: 9_500, text: 'Later' },
      ],
    },
  ],
  [
    'a negative offset at the end of the file',
    '[00:10.00]Line\n[offset: -250 ]',
    { synced: true, lines: [{ timeMs: 10_250, text: 'Line' }] },
  ],
  [
    'metadata tags, and the tags that are skipped',
    [
      '[ar:Radiohead]',
      '[ti:Creep]',
      '[al:Pablo Honey]',
      '[length: 03:58.64]',
      '[au:Someone]',
      '[by:Someone Else]',
      '[re:Some Editor]',
      '[ve:1.0]',
      '[#:a comment]',
      '[00:19.16]First line',
    ].join('\n'),
    {
      synced: true,
      lines: [{ timeMs: 19_160, text: 'First line' }],
      metadata: { artist: 'Radiohead', title: 'Creep', album: 'Pablo Honey', lengthMs: 238_640 },
    },
  ],
  [
    'empty and invalid tag values',
    '[ti:]\n[length:soon]\n[offset:later]\n[x-custom:value]\n[00:01.00]Text',
    { synced: true, lines: [{ timeMs: 1_000, text: 'Text' }] },
  ],
  [
    'a title with brackets in a tag',
    '[TI:Song [Live]]\n[00:01.00]Text',
    { synced: true, lines: [{ timeMs: 1_000, text: 'Text' }], metadata: { title: 'Song [Live]' } },
  ],
  [
    'bracketed lyrics that are not tags',
    '[Verse 1: Someone]\nFirst line\n[Chorus]\nSecond line\n[Chorus: Someone]',
    {
      synced: false,
      lines: [
        { text: '[Verse 1: Someone]' },
        { text: 'First line' },
        { text: '[Chorus]' },
        { text: 'Second line' },
        { text: '[Chorus: Someone]' },
      ],
    },
  ],
  [
    'enhanced word timing',
    [
      '[00:12.00]<00:12.00>Sing <00:12.50>it <00:13.00>slowly<00:13.80>',
      '[00:14.00]<00:14.00>and <00:14.30>low',
    ].join('\n'),
    {
      synced: true,
      lines: [
        {
          timeMs: 12_000,
          text: 'Sing it slowly',
          words: [
            { timeMs: 12_000, text: 'Sing ' },
            { timeMs: 12_500, text: 'it ' },
            { timeMs: 13_000, text: 'slowly', endMs: 13_800 },
          ],
        },
        {
          timeMs: 14_000,
          text: 'and low',
          words: [
            { timeMs: 14_000, text: 'and ' },
            { timeMs: 14_300, text: 'low' },
          ],
        },
      ],
    },
  ],
  [
    'word timestamps with spaces on both sides',
    '[00:01.00] <00:01.04> Sing <00:01.16> along <00:01.82>  now ',
    {
      synced: true,
      lines: [
        {
          timeMs: 1_000,
          text: 'Sing along now',
          words: [
            { timeMs: 1_040, text: 'Sing ' },
            { timeMs: 1_160, text: 'along ' },
            { timeMs: 1_820, text: 'now' },
          ],
        },
      ],
    },
  ],
  [
    'a pause between two words',
    '[00:01.00]<00:01.00>word<00:01.40> <00:01.50>next',
    {
      synced: true,
      lines: [
        {
          timeMs: 1_000,
          text: 'word next',
          words: [
            { timeMs: 1_000, text: 'word ', endMs: 1_400 },
            { timeMs: 1_500, text: 'next' },
          ],
        },
      ],
    },
  ],
  [
    'text before the first word timestamp',
    '[00:05.00]Oh <00:05.50>yeah',
    {
      synced: true,
      lines: [
        {
          timeMs: 5_000,
          text: 'Oh yeah',
          words: [
            { timeMs: 5_000, text: 'Oh ' },
            { timeMs: 5_500, text: 'yeah' },
          ],
        },
      ],
    },
  ],
  [
    'syllables of a script without spaces',
    '[00:01.00]<00:01.00>私<00:01.20>は<00:01.40>猫<00:01.90>',
    {
      synced: true,
      lines: [
        {
          timeMs: 1_000,
          text: '私は猫',
          words: [
            { timeMs: 1_000, text: '私' },
            { timeMs: 1_200, text: 'は' },
            { timeMs: 1_400, text: '猫', endMs: 1_900 },
          ],
        },
      ],
    },
  ],
  [
    'word timing on a line with several timestamps',
    '[00:10.00][00:30.00]<00:10.00>La <00:10.50>la',
    {
      synced: true,
      lines: [
        {
          timeMs: 10_000,
          text: 'La la',
          words: [
            { timeMs: 10_000, text: 'La ' },
            { timeMs: 10_500, text: 'la' },
          ],
        },
        {
          timeMs: 30_000,
          text: 'La la',
          words: [
            { timeMs: 30_000, text: 'La ' },
            { timeMs: 30_500, text: 'la' },
          ],
        },
      ],
    },
  ],
  [
    'word timing that belongs to a later timestamp of the line',
    '[00:30.00][00:10.00]<00:10.00>La <00:10.50>la',
    {
      synced: true,
      lines: [
        {
          timeMs: 10_000,
          text: 'La la',
          words: [
            { timeMs: 10_000, text: 'La ' },
            { timeMs: 10_500, text: 'la' },
          ],
        },
        {
          timeMs: 30_000,
          text: 'La la',
          words: [
            { timeMs: 30_000, text: 'La ' },
            { timeMs: 30_500, text: 'la' },
          ],
        },
      ],
    },
  ],
  [
    'an offset that moves word times too',
    '[offset:1000]\n[00:05.00]<00:05.00>Go<00:05.50>\n[00:00.50]<00:00.50>Up<00:00.90>',
    {
      synced: true,
      lines: [
        { timeMs: 0, text: 'Up', words: [{ timeMs: 0, text: 'Up' }] },
        { timeMs: 4_000, text: 'Go', words: [{ timeMs: 4_000, text: 'Go', endMs: 4_500 }] },
      ],
    },
  ],
  [
    'word timestamps without words',
    '[00:01.00]<00:01.00> <00:01.50>\n[00:02.00]<00:02.00><00:02.10>Late<00:01.00>',
    {
      synced: true,
      lines: [
        { timeMs: 1_000, text: '' },
        { timeMs: 2_000, text: 'Late', words: [{ timeMs: 2_100, text: 'Late' }] },
      ],
    },
  ],
  [
    'blank lines, and timed empty lines that mark a pause',
    '\n[00:01.00]First\n\n\n[00:05.00]\n[00:06.00]Second\n\n',
    {
      synced: true,
      lines: [
        { timeMs: 1_000, text: 'First' },
        { timeMs: 5_000, text: '' },
        { timeMs: 6_000, text: 'Second' },
      ],
    },
  ],
  [
    'CRLF line breaks and a byte order mark',
    '\uFEFF[ti:Song]\r\n[00:01.00]One\r\n[00:02.00]Two\r\n',
    {
      synced: true,
      lines: [
        { timeMs: 1_000, text: 'One' },
        { timeMs: 2_000, text: 'Two' },
      ],
      metadata: { title: 'Song' },
    },
  ],
  [
    'CR line breaks',
    '[00:01.00]One\r[00:02.00]Two',
    {
      synced: true,
      lines: [
        { timeMs: 1_000, text: 'One' },
        { timeMs: 2_000, text: 'Two' },
      ],
    },
  ],
  [
    'plain text, with stanza breaks',
    '\n\n  First line  \nSecond line\n\n\n\nThird line\n\n',
    {
      synced: false,
      lines: [
        { text: 'First line' },
        { text: 'Second line' },
        { text: '' },
        { text: 'Third line' },
      ],
    },
  ],
  [
    'untimed lines in synced lyrics',
    'Credits: someone\n[00:01.00]One\nstray text\n[00:02.00]Two',
    {
      synced: true,
      lines: [
        { timeMs: 1_000, text: 'One' },
        { timeMs: 2_000, text: 'Two' },
      ],
    },
  ],
  [
    'more untimed text lines than timed ones',
    'Credits: someone\n[00:01.00]One\nstray text\n[00:02.00]Two\nmore text',
    {
      synced: false,
      lines: [
        { text: 'Credits: someone' },
        { text: 'One' },
        { text: 'stray text' },
        { text: 'Two' },
        { text: 'more text' },
      ],
    },
  ],
  [
    'plain text with a stray timestamp',
    'Line 1\nLine 2\n[00:10.00]Line 3\nLine 4\n\nLine 5',
    {
      synced: false,
      lines: [
        { text: 'Line 1' },
        { text: 'Line 2' },
        { text: 'Line 3' },
        { text: 'Line 4' },
        { text: '' },
        { text: 'Line 5' },
      ],
    },
  ],
  [
    'plain text with a stray line of enhanced LRC',
    'One\nTwo\n[00:05.00][00:09.00]<00:05.00>Three <00:05.50>four\nFive',
    {
      synced: false,
      lines: [{ text: 'One' }, { text: 'Two' }, { text: 'Three four' }, { text: 'Five' }],
    },
  ],
  [
    'tags LRC does not define, which are not text',
    '[x-trans:a]\n[kuwo:b]\n[00:01.00]One',
    { synced: true, lines: [{ timeMs: 1_000, text: 'One' }] },
  ],
  [
    'lines that start together, which keep their order',
    '[00:01.00]Lead\n[00:01.00]Echo\n[00:00.50]Intro',
    {
      synced: true,
      lines: [
        { timeMs: 500, text: 'Intro' },
        { timeMs: 1_000, text: 'Lead' },
        { timeMs: 1_000, text: 'Echo' },
      ],
    },
  ],
  [
    'brackets and spaces after a timestamp',
    '[00:01.00][Chorus]\n[00:02.00]  Spaced   text  ',
    {
      synced: true,
      lines: [
        { timeMs: 1_000, text: '[Chorus]' },
        { timeMs: 2_000, text: 'Spaced   text' },
      ],
    },
  ],
  [
    'text that only looks like timestamps',
    '[aa:bb]Not a time\n<3 you\n[1:2:3:4]',
    {
      synced: false,
      lines: [{ text: '[aa:bb]Not a time' }, { text: '<3 you' }, { text: '[1:2:3:4]' }],
    },
  ],
  ['empty text', '', { synced: false, lines: [] }],
  ['only blank lines', ' \n\r\n\t\n', { synced: false, lines: [] }],
  [
    'only metadata',
    '[ar:Someone]\n[ti:Something]',
    { synced: false, lines: [], metadata: { artist: 'Someone', title: 'Something' } },
  ],
]

describe('parseLrc', () => {
  it.each(SAMPLES)('parses %s', (_name, text, lyrics) => {
    expect(parseLrc(text)).toEqual({ ...lyrics, source: 'lrc' })
  })

  it('keeps the source it is given', () => {
    expect(parseLrc('[00:01.00]Hi', 'lrclib')).toMatchObject({ synced: true, source: 'lrclib' })
  })

  it('leaves out metadata when the text has none', () => {
    expect(parseLrc('[00:01.00]Hi')).not.toHaveProperty('metadata')
    expect(parseLrc('Hi')).not.toHaveProperty('metadata')
  })

  it('never throws on input that is not text', () => {
    expect(parseLrc(null as unknown as string)).toEqual({ synced: false, lines: [], source: 'lrc' })
  })

  it('has a real byte order mark in the sample that tests it', () => {
    const sample = SAMPLES.find(([name]) => name.includes('byte order mark'))
    expect(sample?.[1].charCodeAt(0)).toBe(0xfeff)
  })

  it('reads timed lyrics as plain text when asked', () => {
    const text = [
      '[ti:Song]',
      '[offset:500]',
      '[00:01.00]One',
      '[00:02.00]',
      '[00:03.00][00:09.00]<00:03.00>Two <00:03.50>words<00:04.00>',
      '[Chorus: Lead]',
      'Credits',
    ].join('\n')
    expect(parseLrc(text, 'test', { plain: true })).toEqual({
      synced: false,
      lines: [
        { text: 'One' },
        { text: '' },
        { text: 'Two words' },
        { text: '[Chorus: Lead]' },
        { text: 'Credits' },
      ],
      source: 'test',
      metadata: { title: 'Song' },
    })
    for (const [, sample] of SAMPLES) {
      const plain = parseLrc(sample, 'lrc', { plain: true })
      expect(plain.synced).toBe(false)
      if (!parseLrc(sample).synced) expect(plain).toEqual(parseLrc(sample))
    }
  })

  it('reads a line with 200,000 timestamps', () => {
    const text = `${'[00:01.00]'.repeat(200_000)}Again`
    const { synced, lines } = parseLrc(text)
    expect(synced).toBe(true)
    expect(lines).toHaveLength(200_000)
    expect(lines[199_999]).toEqual({ timeMs: 1_000, text: 'Again' })
    expect(parseLrc(text, 'lrc', { plain: true }).lines).toEqual([{ text: 'Again' }])
  })

  it('copies word timing to the other timestamps of a line for 10,000 words at most', () => {
    const hostile = `${'[00:00.00]'.repeat(2_000)}${'<00:00.00>w '.repeat(2_000)}`
    const started = Date.now()
    const { lines } = parseLrc(hostile)
    // Copying every word would make 4,000,000 of them and take seconds.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(lines).toHaveLength(2_000)
    expect(lines.filter((line) => line.words !== undefined)).toHaveLength(1)
    expect(lines[0]?.words).toHaveLength(2_000)
    expect(new Set(lines.map((line) => line.text)).size).toBe(1)

    const justOver = `${'[00:01.00]'.repeat(101)}${'<00:01.00>w '.repeat(100)}`
    const justUnder = `${'[00:01.00]'.repeat(99)}${'<00:01.00>w '.repeat(100)}`
    const withWords = (text: string) => parseLrc(text).lines.filter((line) => line.words).length
    expect([withWords(justOver), withWords(justUnder)]).toEqual([1, 99])
    for (const text of [hostile, justOver]) {
      const lyrics = parseLrc(text)
      expect(parseLrc(serializeLrc(lyrics))).toEqual(lyrics)
    }
  })

  it('reads long runs of spaces in linear time', () => {
    const spaces = ' '.repeat(50_000)
    const started = Date.now()
    const synced = parseLrc(
      [
        `[00:01.00]a${spaces}b`,
        `[00:02.00]<00:02.00>c${spaces}<00:03.00>d`,
        `[00:03.00]<${spaces}1:2${spaces}x`,
        `[00:04.00${spaces}x`,
      ].join('\n'),
    )
    const plain = parseLrc([`[${spaces}x`, `[ti${spaces}x]`, `x${spaces}y`].join('\n'))
    // Linear work takes a few milliseconds; backtracking through the spaces takes seconds.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(synced.lines.map((line) => line.text)).toEqual([
      `a${spaces}b`,
      'c d',
      `<${spaces}1:2${spaces}x`,
    ])
    expect(plain.lines).toHaveLength(3)
  })

  it('joins the words of every enhanced line into its text', () => {
    for (const [, text] of SAMPLES) {
      for (const line of parseLrc(text).lines) {
        if (line.words) expect(line.words.map((word) => word.text).join('')).toBe(line.text)
      }
    }
  })

  it('parses a long file in time order', () => {
    const text = Array.from({ length: 500 }, (_, i) => {
      const ms = (499 - i) * 1_000
      const minutes = String(Math.floor(ms / 60_000)).padStart(2, '0')
      const seconds = String((ms / 1000) % 60).padStart(2, '0')
      return `[${minutes}:${seconds}.00]Line ${499 - i}`
    }).join('\n')
    const { lines } = parseLrc(text)
    expect(lines).toHaveLength(500)
    expect(lines.map((line) => line.timeMs)).toEqual(lines.map((_, i) => i * 1_000))
    expect(lines.at(-1)).toEqual({ timeMs: 499_000, text: 'Line 499' })
  })
})

describe('serializeLrc', () => {
  it.each(SAMPLES)('round-trips %s', (_name, text) => {
    const lyrics = parseLrc(text)
    expect(parseLrc(serializeLrc(lyrics))).toEqual(lyrics)
  })

  it.each(SAMPLES)('writes %s the same way every time', (_name, text) => {
    const once = serializeLrc(parseLrc(text))
    expect(serializeLrc(parseLrc(once))).toBe(once)
  })

  it('writes metadata, line timestamps and word timestamps', () => {
    const lyrics = parseLrc(
      [
        '[al:Album]',
        '[ar:Artist]',
        '[ti:Title]',
        '[length:3:05]',
        '[offset:+100]',
        '[00:01.10]One',
        '[00:02.10][00:04.10]<00:02.10>Two <00:02.60>words<00:03.00>',
        '[00:05.10]',
      ].join('\n'),
    )
    expect(serializeLrc(lyrics)).toBe(
      [
        '[ti:Title]',
        '[ar:Artist]',
        '[al:Album]',
        '[length:03:05.00]',
        '[00:01.00]One',
        '[00:02.00]<00:02.00>Two <00:02.50>words<00:02.90>',
        '[00:04.00]<00:04.00>Two <00:04.50>words<00:04.90>',
        '[00:05.00]',
        '',
      ].join('\n'),
    )
  })

  it('writes plain lyrics as text, with an empty line for each stanza break', () => {
    const lyrics: Lyrics = {
      synced: false,
      lines: [{ text: 'One' }, { text: '' }, { text: 'Two' }],
      source: 'test',
    }
    expect(serializeLrc(lyrics)).toBe('One\n\nTwo\n')
  })

  it('writes milliseconds only when hundredths are not exact', () => {
    const lyrics: Lyrics = {
      synced: true,
      lines: [
        { timeMs: 61_230, text: 'a' },
        { timeMs: 61_234, text: 'b' },
        { timeMs: 61_234.6, text: 'c' },
        { timeMs: -5, text: 'd' },
      ],
      source: 'test',
    }
    expect(serializeLrc(lyrics)).toBe('[01:01.23]a\n[01:01.234]b\n[01:01.235]c\n[00:00.00]d\n')
  })

  it('leaves out untimed lines of synced lyrics and keeps every text on one line', () => {
    const lyrics: Lyrics = {
      synced: true,
      lines: [
        { text: 'No time' },
        { timeMs: 1_000, text: 'Two\nlines' },
        {
          timeMs: 2_000,
          text: 'ignored',
          words: [
            { timeMs: 2_000, text: 'Word\r\n' },
            { timeMs: 2_500, text: 'break' },
          ],
        },
      ],
      source: 'test',
      metadata: { title: 'A\ntitle', artist: '', lengthMs: 1_500 },
    }
    expect(serializeLrc(lyrics)).toBe(
      [
        '[ti:A title]',
        '[length:00:01.50]',
        '[00:01.00]Two lines',
        '[00:02.00]<00:02.00>Word <00:02.50>break',
        '',
      ].join('\n'),
    )
  })

  it('writes no timestamp that is not a finite number', () => {
    const lyrics: Lyrics = {
      synced: true,
      lines: [
        { timeMs: Number.NaN, text: 'Lost' },
        { timeMs: 1_000, text: 'Kept', words: [{ timeMs: Number.NaN, text: 'Kept' }] },
      ],
      source: 'test',
      metadata: { lengthMs: Number.POSITIVE_INFINITY },
    }
    expect(serializeLrc(lyrics)).toBe('[00:01.00]<00:00.00>Kept\n')
  })

  it('writes nothing for lyrics without lines or metadata', () => {
    expect(serializeLrc({ synced: false, lines: [], source: 'test' })).toBe('')
  })

  it('writes long runs of spaces in linear time', () => {
    const spaces = ' '.repeat(50_000)
    const started = Date.now()
    const written = serializeLrc({
      synced: true,
      lines: [
        { timeMs: 1_000, text: `a${spaces}b` },
        { timeMs: 2_000, text: `c${spaces}d \n ${spaces}e` },
        { timeMs: 3_000, text: 'f', words: [{ timeMs: 3_000, text: `f${spaces}g${spaces}` }] },
      ],
      source: 'test',
      metadata: { title: `t${spaces}u` },
    })
    // Linear work takes a few milliseconds; backtracking through the spaces takes seconds.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(written.split('\n')).toEqual([
      `[ti:t${spaces}u]`,
      `[00:01.00]a${spaces}b`,
      `[00:02.00]c${spaces}d e`,
      `[00:03.00]<00:03.00>f${spaces}g${spaces}`,
      '',
    ])
  })
})
