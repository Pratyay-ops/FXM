import { describe, expect, it } from 'vitest'
import { ENGINE_ERROR_TYPES, EngineError, isEngineError } from './engine'

describe('EngineError', () => {
  it('carries a type, a message and an optional cause', () => {
    const cause = new Error('403')
    const error = new EngineError('expired', 'The URL expired', { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('EngineError')
    expect(error.type).toBe('expired')
    expect(error.message).toBe('The URL expired')
    expect(error.cause).toBe(cause)
    expect(new EngineError('network', 'offline')).not.toHaveProperty('cause')
  })

  it('lists every type', () => {
    expect(ENGINE_ERROR_TYPES).toEqual([
      'network',
      'decode',
      'autoplay-blocked',
      'unsupported',
      'expired',
    ])
  })
})

describe('isEngineError', () => {
  it('recognizes engine errors, optionally of one type', () => {
    const error = new EngineError('decode', 'bad bytes')
    expect(isEngineError(error)).toBe(true)
    expect(isEngineError(error, 'decode')).toBe(true)
    expect(isEngineError(error, 'network')).toBe(false)
  })

  it.each([new Error('decode'), { type: 'decode' }, null, 'decode'])('rejects %j', (value) => {
    expect(isEngineError(value)).toBe(false)
  })
})
