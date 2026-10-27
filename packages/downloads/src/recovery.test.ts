import { FxmError, formatId, playbackProblemError } from '@fxm/core'
import { testCandidate } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import { classifyDownloadFailure, type DownloadFailure } from './recovery'
import { NoDownloadableStreamError, UnreadableStreamError } from './resolver'
import { storageFullError, storageUnavailableError } from './storage'
import { DownloadHttpError, DownloadNetworkError, DownloadProtocolError } from './transfer'

const online = { online: true, ipBound: false, platform: 'web' } as const
const signed = { online: true, ipBound: true, platform: 'web' } as const
const offline = { online: false, ipBound: true, platform: 'web' } as const

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
    [
      'a dropped request',
      new DownloadNetworkError('', 'request'),
      decision('transient', 'network'),
    ],
    [
      'an answer that broke off',
      new DownloadNetworkError('', 'body'),
      decision('transient', 'network'),
    ],
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
      'a file far larger than the track',
      new DownloadProtocolError('too-large', ''),
      decision('fatal', 'too-large'),
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
    [
      'a browser without sync access handles',
      new DOMException('', 'NotSupportedError'),
      decision('fatal', 'storage'),
    ],
    [
      'a storage worker that failed or stopped answering',
      storageUnavailableError(),
      decision('fatal', 'storage'),
    ],
    ['a TypeError', new TypeError('Failed to fetch'), decision('transient', 'network')],
    ['anything else', new Error('?'), decision('transient', 'unknown')],
    ['not even an error', 'boom', decision('transient', 'unknown')],
  ])('%s', (_label, error, expected) => {
    expect(classifyDownloadFailure(error, online)).toMatchObject(expected)
  })

  it('takes a request to a signed URL that got no answer on the web for a redirect', () => {
    expect(classifyDownloadFailure(new DownloadNetworkError('', 'request'), signed)).toEqual(
      decision('url', 'unverified'),
    )
  })

  it("ends at once with bytes the browser won't let the page read", () => {
    // A readability check found out: no fresh resolution or retry can change it.
    expect(classifyDownloadFailure(new UnreadableStreamError('redirected', ''), signed)).toEqual(
      decision('fatal', 'redirected'),
    )
    expect(classifyDownloadFailure(new UnreadableStreamError('refused', ''), signed)).toEqual(
      decision('fatal', 'unreadable'),
    )
  })

  it('retries the same signed URL after its answer broke off: the URL works', () => {
    expect(classifyDownloadFailure(new DownloadNetworkError('', 'body'), signed)).toEqual(
      decision('transient', 'network'),
    )
  })

  it('expects no redirect where native HTTP follows it: desktop and Android', () => {
    for (const platform of ['desktop', 'android'] as const) {
      expect(
        classifyDownloadFailure(new DownloadNetworkError('', 'request'), { ...signed, platform }),
      ).toEqual(decision('transient', 'network'))
    }
  })

  it('waits for the network when offline', () => {
    expect(classifyDownloadFailure(new DownloadNetworkError('', 'request'), offline)).toEqual(
      decision('offline', 'network'),
    )
    expect(classifyDownloadFailure(new DownloadNetworkError('', 'body'), offline)).toEqual(
      decision('offline', 'network'),
    )
    expect(classifyDownloadFailure(new FxmError('Network', ''), offline)).toEqual(
      decision('offline', 'network'),
    )
    expect(classifyDownloadFailure(new TypeError(''), offline)).toEqual(
      decision('offline', 'network'),
    )
  })

  it('keeps the wait a server asked for', () => {
    expect(classifyDownloadFailure(new DownloadHttpError(429, '', 5000), online)).toEqual({
      kind: 'transient',
      code: 'server',
      retryAfterMs: 5000,
    })
  })

  it('holds back when the request budget or a source asks to slow down', () => {
    expect(
      classifyDownloadFailure(new FxmError('RateLimited', '', { retryAfterMs: 9000 }), online),
    ).toEqual({ kind: 'throttled', code: 'server', retryAfterMs: 9000 })
    expect(classifyDownloadFailure(new FxmError('RateLimited', ''), online)).toEqual(
      decision('throttled', 'server'),
    )
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
