import { DEFAULT_QUALITY_PREFS, FxmError, playabilityVerdictOf } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testTrack } from '../../testing/fixtures'
import type { StreamSourceRequest } from '../adapters'
import {
  FAKE_URL_LIFETIME_MS,
  FakeMatcher,
  FakeNetworkMonitor,
  FakeStreamSource,
  ladderStreams,
  TEST_CAPABILITIES,
  testCandidate,
  testContext,
  testSpotifyTrack,
} from './index'

function request(overrides: Partial<StreamSourceRequest> = {}): StreamSourceRequest {
  return {
    ctx: testContext('full'),
    prefs: DEFAULT_QUALITY_PREFS,
    rung: 'top',
    priority: 'current-track',
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('ladderStreams', () => {
  it('builds the top rung’s Opus and AAC streams, and itag 18 for the fallback', () => {
    const top = ladderStreams('a b', { rung: 'top', fullLength: 'verified', serial: 3 })
    expect(top.map((stream) => stream.url)).toEqual([
      'https://media.test/a%20b/251?n=3',
      'https://media.test/a%20b/140?n=3',
    ])
    expect(top[0]).not.toHaveProperty('expiresAt')
    const [fallback] = ladderStreams('a', {
      rung: 'fallback',
      fullLength: 'unverified',
      serial: 1,
      expiresAt: 5,
      host: 'x.test',
    })
    expect(fallback).toMatchObject({
      url: 'https://x.test/a/18?n=1',
      media: 'muxed-video',
      container: 'mp4',
      expiresAt: 5,
      fullLength: 'unverified',
    })
  })
})

describe('FakeStreamSource', () => {
  it('answers like the ladder: probed where bytes are readable, unverified in Lite', async () => {
    const source = new FakeStreamSource({ now: () => 1000 })
    const full = await source.resolve(testCandidate('a'), request())
    expect(full[0]).toMatchObject({
      fullLength: 'verified',
      expiresAt: 1000 + FAKE_URL_LIFETIME_MS,
    })
    const lite = await source.resolve(testCandidate('a'), request({ ctx: testContext('lite') }))
    expect(lite[0]?.fullLength).toBe('unverified')
    expect(source.log).toEqual(['a:top', 'a:top'])
    expect(source.callsFor('a')).toBe(2)
    expect(source.callsFor('b')).toBe(0)
  })

  it('caps, rejects and gives verdicts by rule', async () => {
    const source = new FakeStreamSource()
    source.capped.add('a')
    // Like the real ladder, the whole ladder falls through to itag 18 past a capped top rung.
    const top = await source.resolve(testCandidate('a'), request())
    expect(top.map((stream) => [stream.media, stream.fullLength])).toEqual([
      ['muxed-video', 'verified'],
      ['audio', 'capped'],
      ['audio', 'capped'],
    ])
    expect(top.map((stream) => source.rungOf(stream))).toEqual(['fallback', 'top', 'top'])
    source.fallThrough = false
    expect((await source.resolve(testCandidate('a'), request()))[0]?.fullLength).toBe('capped')
    const fallback = await source.resolve(testCandidate('a'), request({ rung: 'fallback' }))
    expect(fallback[0]).toMatchObject({ fullLength: 'verified', media: 'muxed-video' })
    const lite = await source.resolve(testCandidate('a'), request({ ctx: testContext('lite') }))
    expect(lite.map((stream) => stream.fullLength)).toEqual(['unverified', 'unverified'])
    source.errors.set('b', new FxmError('Network', 'x'))
    await expect(source.resolve(testCandidate('b'), request())).rejects.toThrow('x')
    source.verdicts.set('c', 'ERROR')
    const error = await source.resolve(testCandidate('c'), request()).catch((e: unknown) => e)
    expect(playabilityVerdictOf(error)).toMatchObject({ ref: 'c', status: 'ERROR' })
  })

  it('reads statuses it was given, and builds sources without a fallback or an expiry', async () => {
    const source = new FakeStreamSource({ id: 'archive', expires: false })
    expect(source.hasFallback).toBe(false)
    const [stream] = await source.resolve(
      testCandidate('a', { source: 'archive' }),
      request({ rung: 'fallback' }),
    )
    expect(stream).toMatchObject({ url: 'https://archive.test/a/251?n=1' })
    expect(stream).not.toHaveProperty('expiresAt')
    if (stream === undefined) throw new Error('no stream')
    source.statuses.set(stream.url, 403)
    expect(await source.checkStatus(stream)).toBe(403)
    expect(source.checked).toEqual([stream.url])
  })

  it('records the failed rungs reported, and reads a state off an error', () => {
    const source = new FakeStreamSource()
    const [stream] = ladderStreams('a', { rung: 'top', fullLength: 'unverified', serial: 1 })
    if (stream === undefined) throw new Error('no stream')
    source.reportFailure(stream, {
      facts: {
        kind: 'unsupported',
        started: false,
        fullLength: 'unverified',
        rung: 'top',
        cached: false,
        hasFallback: true,
        forbiddenCount: 0,
      },
      recovery: { target: 'fallback', flushAll: false, avoidFormat: false, reason: 'probe-failed' },
    })
    expect(source.reports).toEqual([{ url: stream.url, reason: 'probe-failed' }])
    const aged = Object.assign(new FxmError('Unavailable', 'age'), { state: 'age-restricted' })
    expect(source.stateOf(aged)).toBe('age-restricted')
    expect(source.stateOf(new FxmError('Unavailable', 'x'))).toBeUndefined()
    expect(source.stateOf(null)).toBeUndefined()
  })
})

describe('FakeMatcher', () => {
  it('answers the best candidate the request does not exclude', async () => {
    const matcher = new FakeMatcher()
    const track = testSpotifyTrack('S')
    const x = testCandidate('x')
    const y = testCandidate('y')
    matcher.rank(track, 'song', [
      { candidate: x, band: 'auto' },
      { candidate: y, band: 'suggest' },
    ])
    const base = {
      target: 'song',
      ctx: testContext(),
      priority: 'current-track',
      signal: new AbortController().signal,
    } as const
    expect(await matcher.match(track, { ...base, exclude: [] })).toEqual({
      band: 'auto',
      best: x,
      alternatives: [y],
    })
    expect(await matcher.match(track, { ...base, exclude: [x] })).toEqual({
      band: 'suggest',
      best: y,
      alternatives: [],
    })
    expect(await matcher.match(testTrack('a'), { ...base, exclude: [] })).toEqual({
      band: 'none',
      alternatives: [],
    })
    matcher.fail(track, 'lossless', new FxmError('Network', 'down'))
    await expect(
      matcher.match(track, { ...base, target: 'lossless', exclude: [] }),
    ).rejects.toThrow('down')
    expect(matcher.callsFor(track)).toBe(3)
    expect(matcher.callsFor(track, 'lossless')).toBe(1)
  })
})

describe('FakeNetworkMonitor', () => {
  it('changes network only when told', () => {
    const network = new FakeNetworkMonitor()
    const seen: string[] = []
    const stop = network.subscribe(() => seen.push(network.id))
    expect(network.cellular).toBe(false)
    network.change(true)
    expect(network.cellular).toBe(true)
    stop()
    network.change()
    expect(seen).toEqual(['fake-network-1'])
    expect(network.id).toBe('fake-network-2')
  })
})

describe('fixtures', () => {
  it('build tracks, candidates and contexts for each tier', async () => {
    expect(testSpotifyTrack('S')).toMatchObject({ id: 'spotify:track:S', source: 'spotify' })
    expect(testCandidate('x', { kind: 'video' })).toMatchObject({ source: 'ytm', kind: 'video' })
    expect(testContext('lite').capabilities).toEqual(TEST_CAPABILITIES.lite)
    expect(testContext('free', { mode: 'all' }).mode).toBe('all')
    await expect(testContext().fetch('https://example.test/')).rejects.toThrow('never reach')
  })
})
