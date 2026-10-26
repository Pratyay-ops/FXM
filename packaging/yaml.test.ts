import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { isPlainSafe, yamlBlock, yamlScalar } from './yaml.ts'

describe('hand-written YAML', () => {
  it('reads back every scalar as the same string', () => {
    const values = [
      'FXM',
      '0.6.0',
      '1.0',
      '0x10',
      'yes',
      'No',
      'null',
      '~',
      'Two modes: Music and video',
      "it's",
      '#hash',
      '- dash',
      '--share=network',
      '-',
      '---',
      '? key',
      ':colon',
      'https://example.org/a?b=c#d',
      'Tags ^v\\d+\\.\\d+\\.\\d+$',
      'a: b',
      '@at',
      'Spotify’s catalog',
    ]
    for (const value of values) {
      expect(parse(`key: ${yamlScalar(value)}\n`), value).toEqual({ key: value })
    }
    expect(isPlainSafe('0.6.0')).toBe(true)
    expect(isPlainSafe('1.0')).toBe(false)
    expect(() => yamlScalar('two\nlines')).toThrow(/one line/)
  })

  it('writes blocks that keep their lines', () => {
    const text = 'First line: with a colon\n\n- not a list\nlast'
    expect(parse(`key: ${yamlBlock(text, 2)}\n`)).toEqual({ key: text })
  })
})
