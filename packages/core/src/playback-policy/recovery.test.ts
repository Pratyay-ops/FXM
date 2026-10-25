import { describe, expect, it } from 'vitest'
import { FxmError } from '../errors'
import {
  httpStatusOf,
  planStreamRecovery,
  type StreamFailureFacts,
  type StreamRecovery,
} from './recovery'

describe('httpStatusOf', () => {
  it('reads a status from the error or its cause chain', () => {
    expect(httpStatusOf({ status: 403 })).toBe(403)
    expect(httpStatusOf(new Error('HTTP', { cause: { status: 410 } }))).toBe(410)
    const deep = new FxmError('Network', 'x', {
      cause: new Error('y', { cause: { cause: { status: 401 } } }),
    })
    expect(httpStatusOf(deep)).toBe(401)
  })

  it.each([
    ['nothing', undefined],
    ['a string', 'HTTP 403'],
    ['an error without a status', new Error('x')],
    ['a status that is no HTTP status', { status: 42 }],
    ['a fractional status', { status: 403.5 }],
    ['a status string', { status: '403' }],
  ])('finds none in %s', (_label, value) => {
    expect(httpStatusOf(value)).toBeUndefined()
  })

  it('stops following the cause chain after a few levels', () => {
    let error: unknown = { status: 403 }
    for (let level = 0; level < 10; level += 1) error = { cause: error }
    expect(httpStatusOf(error)).toBeUndefined()
  })
})

describe('planStreamRecovery', () => {
  const facts = (overrides: Partial<StreamFailureFacts>): StreamFailureFacts => ({
    kind: 'media',
    started: false,
    fullLength: 'unverified',
    rung: 'top',
    cached: false,
    hasFallback: true,
    forbiddenCount: 0,
    ...overrides,
  })
  const next = (overrides: Partial<StreamFailureFacts>): string => {
    const { target, reason, flushAll, avoidFormat }: StreamRecovery = planStreamRecovery(
      facts(overrides),
    )
    return [target, reason, flushAll ? 'flush' : '', avoidFormat ? 'avoid-format' : '']
      .filter(Boolean)
      .join(' ')
  }

  it.each<[string, Partial<StreamFailureFacts>, string]>([
    // The media element's first request is the probe (Lite, or a probe that failed CORS).
    ['an unverified URL that fails before it plays', {}, 'fallback probe-failed'],
    [
      'an unverified fallback URL that fails before it plays',
      { rung: 'fallback' },
      'top fallback-failed',
    ],
    [
      'an unverified URL of a source without a fallback',
      { hasFallback: false },
      'top probe-failed',
    ],
    // The end-of-file probe passed, so the URL is not capped.
    ['a verified URL that fails before it plays', { fullLength: 'verified' }, 'same first-request'],
    ['a stream that fails after it played', { started: true }, 'same mid-play'],
    [
      'a fallback stream that fails after it played',
      { started: true, rung: 'fallback' },
      'same mid-play',
    ],
    // Readable statuses.
    ['an expired URL', { kind: 'expired', started: true }, 'same expired'],
    ['410 Gone', { status: 410 }, 'same expired'],
    ['401', { status: 401, started: true }, 'same unauthorized'],
    ['a 403 on a cached URL', { status: 403, cached: true }, 'same ip-changed flush'],
    [
      'a cached URL that 403s again',
      { status: 403, cached: true, forbiddenCount: 3 },
      'same ip-changed flush',
    ],
    ['the first 403 on a fresh URL', { status: 403 }, 'same forbidden'],
    ['a second 403 on a fresh URL', { status: 403, forbiddenCount: 1 }, 'fallback forbidden-again'],
    [
      'a second 403 on the fallback rung',
      { status: 403, forbiddenCount: 1, rung: 'fallback' },
      'top forbidden-again',
    ],
    ['another status, before it played', { status: 500 }, 'fallback probe-failed'],
    // Decoding.
    ['a stream that cannot be decoded', { kind: 'decode' }, 'same decode avoid-format'],
  ])('%s: %s', (_label, overrides, expected) => {
    expect(next(overrides)).toBe(expected)
  })
})
