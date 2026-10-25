import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { ScrobbleError, scrobbleFailureOf } from './errors'

describe('ScrobbleError', () => {
  it('is an FxmError with the code its failure implies, unless given one', () => {
    const refused = new ScrobbleError('lastfm', 'refused', 'error 9', { serviceCode: 9 })
    expect(isFxmError(refused, 'AuthRequired')).toBe(true)
    expect(refused).toMatchObject({ service: 'lastfm', failure: 'refused', serviceCode: 9 })
    expect(new ScrobbleError('lastfm', 'rate-limited', 'slow down').code).toBe('RateLimited')
    expect(new ScrobbleError('lastfm', 'rejected', 'bad').code).toBe('Unavailable')
    const network = new ScrobbleError('listenbrainz', 'temporary', 'down', {
      code: 'Network',
      cause: new TypeError('Failed to fetch'),
    })
    expect(network.code).toBe('Network')
    expect(network.cause).toBeInstanceOf(TypeError)
    expect(network.serviceCode).toBeUndefined()
  })

  it('carries the wait a rate limit asked for', () => {
    const error = new ScrobbleError('listenbrainz', 'rate-limited', '429', { retryAfterMs: 5000 })
    expect(error.retryAfterMs).toBe(5000)
  })
})

describe('scrobbleFailureOf', () => {
  it('reads the failure of a ScrobbleError, and maps other errors', () => {
    expect(scrobbleFailureOf(new ScrobbleError('lastfm', 'rejected', 'bad'))).toBe('rejected')
    expect(scrobbleFailureOf(new FxmError('AuthRequired', 'login'))).toBe('refused')
    expect(scrobbleFailureOf(new FxmError('RateLimited', 'slow'))).toBe('rate-limited')
    expect(scrobbleFailureOf(new FxmError('Parse', 'odd'))).toBe('temporary')
    // Nothing unknown ever drops a scrobble.
    expect(scrobbleFailureOf(new TypeError('bug'))).toBe('temporary')
    expect(scrobbleFailureOf('string')).toBe('temporary')
  })
})
