import { describe, expect, it } from 'vitest'
import { FXM_ERROR_CODES, FxmError, type FxmErrorCode, isFxmError } from './errors'

describe('FxmError', () => {
  it('is an Error with a name, code and message', () => {
    const error = new FxmError('NotFound', 'Track ytm:track:abc does not exist')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(FxmError)
    expect(error.name).toBe('FxmError')
    expect(error.code).toBe('NotFound')
    expect(error.message).toBe('Track ytm:track:abc does not exist')
    expect(error.retryAfterMs).toBeUndefined()
    expect(error.stack).toContain('FxmError')
  })

  it('keeps the underlying cause as the standard Error.cause', () => {
    const cause = new TypeError('Failed to fetch')
    const error = new FxmError('Network', 'Search failed', { cause })
    expect(error.cause).toBe(cause)
  })

  it('keeps an explicitly undefined cause, and has none when it is left out', () => {
    expect('cause' in new FxmError('Parse', 'x')).toBe(false)
    const error = new FxmError('Parse', 'x', { cause: undefined })
    expect('cause' in error).toBe(true)
    expect(error.cause).toBeUndefined()
  })

  it('carries the retry delay of a rate limit', () => {
    const error = new FxmError('RateLimited', 'Slow down', { retryAfterMs: 30_000 })
    expect(error.retryAfterMs).toBe(30_000)
  })

  it('has every code of the brief', () => {
    expect(FXM_ERROR_CODES).toEqual([
      'NotFound',
      'RateLimited',
      'AuthRequired',
      'Unavailable',
      'GeoBlocked',
      'Expired',
      'BotCheck',
      'Unsupported',
      'Network',
      'Parse',
    ])
  })
})

describe('isFxmError', () => {
  it.each(FXM_ERROR_CODES)('recognizes a %s error', (code) => {
    const error = new FxmError(code, 'x')
    expect(isFxmError(error)).toBe(true)
    expect(isFxmError(error, code)).toBe(true)
  })

  it('checks the code when one is given', () => {
    const error = new FxmError('GeoBlocked', 'Not in your region')
    expect(isFxmError(error, 'GeoBlocked')).toBe(true)
    expect(isFxmError(error, 'NotFound')).toBe(false)
  })

  it('recognizes an FxmError from another copy of the module', () => {
    const foreign = Object.assign(new Error('x'), { name: 'FxmError', code: 'BotCheck' })
    expect(isFxmError(foreign)).toBe(true)
    expect(isFxmError(foreign, 'BotCheck')).toBe(true)
    expect(isFxmError(foreign, 'Expired')).toBe(false)
  })

  it.each([
    ['a plain Error', new Error('x')],
    [
      'an Error with an unknown code',
      Object.assign(new Error('x'), { name: 'FxmError', code: 'Nope' }),
    ],
    ['an Error named FxmError without a code', Object.assign(new Error('x'), { name: 'FxmError' })],
    ['a look-alike object', { name: 'FxmError', code: 'NotFound', message: 'x' }],
    ['a string', 'NotFound'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isFxmError(value)).toBe(false)
  })

  it('narrows to FxmError', () => {
    const value: unknown = new FxmError('Unsupported', 'Needs FXM Connect')
    if (!isFxmError(value)) throw new Error('expected an FxmError')
    const code: FxmErrorCode = value.code
    expect(code).toBe('Unsupported')
  })
})
