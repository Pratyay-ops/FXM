import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  isSpotifyError,
  redact,
  SPOTIFY_ERROR_REASONS,
  SPOTIFY_REASON_CODES,
  SpotifyError,
} from './errors'

describe('SpotifyError', () => {
  it('is an FxmError with a reason, whose code the reason decides', () => {
    const error = new SpotifyError('paused', 'slow down', { retryAfterMs: 5 })
    expect(error).toBeInstanceOf(FxmError)
    expect(isFxmError(error, 'RateLimited')).toBe(true)
    expect(error).toMatchObject({ name: 'FxmError', reason: 'paused', retryAfterMs: 5 })
    expect(isSpotifyError(error)).toBe(true)
    expect(isSpotifyError(error, 'paused')).toBe(true)
    expect(isSpotifyError(error, 'network')).toBe(false)
  })

  it('gives every reason exactly its code', () => {
    for (const reason of SPOTIFY_ERROR_REASONS) {
      const error = new SpotifyError(reason, 'x')
      expect(error.code, reason).toBe(SPOTIFY_REASON_CODES[reason])
      expect(isFxmError(error, error.code)).toBe(true)
      expect(isSpotifyError(error, reason)).toBe(true)
    }
    expect(SPOTIFY_REASON_CODES).toMatchObject({
      'account-unsupported': 'Unsupported',
      'login-required': 'AuthRequired',
      'secret-unavailable': 'Unavailable',
      'bad-cursor': 'Unsupported',
      network: 'Network',
    })
  })

  it('keeps the cause', () => {
    const cause = new TypeError('bridge gone')
    expect(new SpotifyError('network', 'failed', { cause }).cause).toBe(cause)
  })

  it('recognizes errors from another copy of the module, and nothing else', () => {
    const foreign = Object.assign(new Error('x'), {
      name: 'FxmError',
      code: 'Network',
      reason: 'network',
    })
    expect(isSpotifyError(foreign, 'network')).toBe(true)
    expect(isSpotifyError(new FxmError('Network', 'plain'))).toBe(false)
    expect(isSpotifyError(Object.assign(new Error('x'), { reason: 'network' }))).toBe(false)
    expect(isSpotifyError({ name: 'FxmError', code: 'Network', reason: 'network' })).toBe(false)
    // A code that does not belong to the reason.
    const mismatched = Object.assign(new Error('x'), {
      name: 'FxmError',
      code: 'NotFound',
      reason: 'paused',
    })
    expect(isSpotifyError(mismatched)).toBe(false)
  })

  it('lists each reason once', () => {
    expect(new Set(SPOTIFY_ERROR_REASONS).size).toBe(SPOTIFY_ERROR_REASONS.length)
    expect(SPOTIFY_ERROR_REASONS).toEqual(Object.keys(SPOTIFY_REASON_CODES))
  })
})

describe('redact', () => {
  it('hides query strings and bearer tokens', () => {
    expect(redact('GET https://open.spotify.com/api/token?totp=123456&totpVer=61 failed')).toBe(
      'GET https://open.spotify.com/api/token?… failed',
    )
    expect(redact('Authorization: Bearer BQAbc.def-ghi_jkl')).toBe('Authorization: Bearer …')
    expect(redact('nothing secret here')).toBe('nothing secret here')
  })
})
