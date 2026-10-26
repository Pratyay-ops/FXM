import { describe, expect, it } from 'vitest'
import { isRecord, messageOf, parseOptions, requireOption } from './actions.ts'

describe('the release steps’ inputs', () => {
  it('reads --name value options, and flags without a value as true', () => {
    const options = parseOptions(['--out', 'dist', '--dry-run', '--version', '0.7.0'])
    expect([...options]).toEqual([
      ['out', 'dist'],
      ['dry-run', 'true'],
      ['version', '0.7.0'],
    ])
    expect(requireOption(options, 'out')).toBe('dist')
    expect(() => requireOption(options, 'dry-run')).toThrow('--dry-run <value> is required')
    expect(() => parseOptions(['out'])).toThrow('unexpected argument: out')
  })

  it('tells a JSON object from null, arrays and other values', () => {
    expect(isRecord({ version: '0.7.0' })).toBe(true)
    for (const value of [null, [], 'text', 1, undefined]) expect(isRecord(value)).toBe(false)
  })

  it('says what went wrong, whatever was thrown', () => {
    expect(messageOf(new Error('the key is wrong'))).toBe('the key is wrong')
    expect(messageOf('a string')).toBe('a string')
    expect(messageOf(undefined)).toBe('undefined')
  })
})
