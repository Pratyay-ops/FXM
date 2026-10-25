import { FxmError, formatId, playbackProblemError } from '@fxm/core'
import { testCandidate } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import { classifyDownloadFailure, type DownloadFailure } from './recovery'
import { NoDownloadableStreamError } from './resolver'
import { storageFullError } from './storage'
import { DownloadHttpError, DownloadNetworkError, DownloadProtocolError } from './transfer'

const online = { online: true, ipBound: false }
const signed = { online: true, ipBound: true }
const offline = { online: false, ipBound: true }

function decision(kind: DownloadFailure['kind'], code: DownloadFailure['code']) {
  return { kind, code }
}

describe('classifyDownloadFailure', () => {
  it.each<[string, unknown, DownloadFailure]>([
    ['a full storage', storageFullError(), decision('fatal', 'storage-full')],
    [
      'HTTP 403: a refused or expired URL',
      new DownloadHttpError(403, ''),
      decision('url', 'server'),
    ],
    ['HTTP 401', new DownloadHttpError(401, ''), decision('url', 'server')],
    ['HTTP 410', new DownloadHttpError(410, ''), decision('url', 'server')],
    ['HTTP 404', new DownloadHttpError(404, ''), decision('url', 'unavailable')],
    ['HTTP 416', new DownloadHttpError(416, ''), decision('restart', 'server')],
    ['HTTP 503', new DownloadHttpError(503, ''), decision('transient', 'server')],
    ['HTTP 408', new DownloadHttpError(408, ''), decision('transient', 'server')],
    ['HTTP 400', new DownloadHttpError(400, ''), decision('fatal', 'server')],
    ['a dropped request', new DownloadNetworkError(''), decision('transient', 'network')],
    [
      'a range mismatch',
      new DownloadProtocolError('range-mismatch', ''),
      decision('transient', 'server'),
    ],
    [
      'a changed file',
      new DownloadProtocolError('validator-changed', ''),
      decision('restart', 'server'),
    ],
    [
      'a resized file',
      new DownloadProtocolError('size-changed', ''),
      decision('restart', 'server'),
    ],
    [
      'bytes beyond the end',
      new DownloadProtocolError('beyond-end', ''),
      decision('restart', 'server'),
    ],
    [
      'a page instead of the file',
      new DownloadProtocolError('not-media', ''),
      decision('url', 'server'),
    ],
    [
      'no verified stream',
      new NoDownloadableStreamError('unverified', ''),
      decision('url', 'unverified'),
    ],
    [
      'no stream at all',
      new NoDownloadableStreamError('no-stream', ''),
      decision('fatal', 'unavailable'),
    ],
    ['Unsupported', new FxmError('Unsupported', ''), decision('fatal', 'unsupported')],
    ['AuthRequired', new FxmError('AuthRequired', ''), decision('fatal', 'unsupported')],
    ['BotCheck', new FxmError('BotCheck', ''), decision('fatal', 'bot-check')],
    ['GeoBlocked', new FxmError('GeoBlocked', ''), decision('fatal', 'unavailable')],
    ['Expired', new FxmError('Expired', ''), decision('url', 'server')],
    ['Network', new FxmError('Network', ''), decision('transient', 'network')],
    ['Parse', new FxmError('Parse', ''), decision('transient', 'server')],
    [
      'a file locked by another tab',
      new DOMException('', 'NoModificationAllowedError'),
      decision('transient', 'storage'),
    ],
    [
      'storage a private window blocks',
      new DOMException('', 'SecurityError'),
      decision('fatal', 'storage'),
    ],
    ['a TypeError', new TypeError('Failed to fetch'), decision('transient', 'network')],
    ['anything else', new Error('?'), decision('transient', 'unknown')],
    ['not even an error', 'boom', decision('transient', 'unknown')],
  ])('%s', (_label, error, expected) => {
    expect(classifyDownloadFailure(error, online)).toMatchObject(expected)
  })

  it('takes a request to a signed URL that got no answer for a redirect: resolve afresh', () => {
    expect(classifyDownloadFailure(new DownloadNetworkError(''), signed)).toEqual(
      decision('url', 'unverified'),
    )
  })

  it('waits for the network when offline', () => {
    expect(classifyDownloadFailure(new DownloadNetworkError(''), offline)).toEqual(
      decision('offline', 'network'),
    )
    expect(classifyDownloadFailure(new FxmError('Network', ''), offline)).toEqual(
      decision('offline', 'network'),
    )
    expect(classifyDownloadFailure(new TypeError(''), offline)).toEqual(
      decision('offline', 'network'),
    )
  })

  it('keeps the wait a server or a source asked for', () => {
    expect(classifyDownloadFailure(new DownloadHttpError(429, '', 5000), online)).toEqual({
      kind: 'transient',
      code: 'server',
      retryAfterMs: 5000,
    })
    expect(
      classifyDownloadFailure(new FxmError('RateLimited', '', { retryAfterMs: 9000 }), online),
    ).toEqual({ kind: 'transient', code: 'server', retryAfterMs: 9000 })
  })

  it('tells a match that needs review from audio that is gone', () => {
    const trackId = formatId('spotify', 'track', 'x')
    const review = playbackProblemError({
      type: 'needs-review',
      trackId,
      guess: testCandidate('a'),
      alternatives: [],
    })
    expect(classifyDownloadFailure(review, online)).toEqual(decision('fatal', 'needs-review'))
    const gone = playbackProblemError({
      type: 'unavailable',
      trackId,
      reason: 'no-match',
      alternatives: [],
    })
    expect(classifyDownloadFailure(gone, online)).toEqual(decision('fatal', 'unavailable'))
  })
})
