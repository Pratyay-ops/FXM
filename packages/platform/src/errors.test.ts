import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  isRouteUnavailable,
  isTransportError,
  ROUTE_NEEDS,
  RouteUnavailableError,
  TRANSPORT_ERROR_REASONS,
  TransportError,
} from './errors'

describe('TransportError', () => {
  it('is an Unsupported FxmError with a reason', () => {
    const cause = new TypeError('bad')
    const error = new TransportError('bad-request', 'Not an absolute URL: x', { cause })
    expect(error).toBeInstanceOf(FxmError)
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    expect(error).toMatchObject({ reason: 'bad-request', cause })
    expect('cause' in new TransportError('redirect', 'm')).toBe(false)
    expect(TRANSPORT_ERROR_REASONS).toEqual([
      'unknown-host',
      'route-closed',
      'bad-request',
      'redirect',
    ])
  })

  it('is recognized by reason, also as a copy from another bundle', () => {
    const error = new TransportError('unknown-host', 'm')
    expect(isTransportError(error)).toBe(true)
    expect(isTransportError(error, 'unknown-host')).toBe(true)
    expect(isTransportError(error, 'redirect')).toBe(false)
    expect(isTransportError(new FxmError('Unsupported', 'm'))).toBe(false)
    expect(isTransportError(Object.assign(new FxmError('Unsupported', 'm'), { reason: 'x' }))).toBe(
      false,
    )
    expect(isTransportError('unknown-host')).toBe(false)
    const copy = Object.assign(new Error('m'), {
      name: 'FxmError',
      code: 'Unsupported',
      reason: 'redirect',
    })
    expect(isTransportError(copy, 'redirect')).toBe(true)
  })
})

describe('RouteUnavailableError', () => {
  it('names the route, what would open it and the FXM Connect feature it takes', () => {
    const needs = ['connect', 'native'] as const
    const error = new RouteUnavailableError('googlevideo', needs, 'm', 'googlevideo')
    expect(error).toBeInstanceOf(TransportError)
    expect(error).toMatchObject({
      code: 'Unsupported',
      reason: 'route-closed',
      route: 'googlevideo',
      needs: ['connect', 'native'],
      connectFeature: 'googlevideo',
    })
    expect(error.needs).not.toBe(needs)
    expect(new RouteUnavailableError('user', ['sandbox'], 'm').connectFeature).toBeUndefined()
    expect(ROUTE_NEEDS).toEqual(['connect', 'lite', 'native', 'sandbox'])
  })

  it('is recognized, also as a copy from another bundle', () => {
    expect(isRouteUnavailable(new RouteUnavailableError('innertube', ['lite'], 'm'))).toBe(true)
    expect(isRouteUnavailable(new TransportError('route-closed', 'm'))).toBe(false)
    expect(isRouteUnavailable(new TransportError('unknown-host', 'm'))).toBe(false)
    const copy = Object.assign(new Error('m'), {
      name: 'FxmError',
      code: 'Unsupported',
      reason: 'route-closed',
      route: 'spotify',
      needs: ['connect'],
    })
    expect(isRouteUnavailable(copy)).toBe(true)
  })
})
