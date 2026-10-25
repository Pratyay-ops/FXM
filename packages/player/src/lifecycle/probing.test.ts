import { sanitizeQualityPrefs } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTrack, testTracks } from '../testing/fixtures'
import { ladderUrl, settle, setup, useFakeClock } from './test-harness'
import { FAKE_URL_LIFETIME_MS, ladderStreams } from './testing/fake-stream-source'

beforeEach(useFakeClock)

afterEach(() => {
  vi.useRealTimers()
})

describe('capped URLs: the HTTP end-of-file probe, where bytes are readable', () => {
  it('falls back to itag 18 when the probe finds the top rung capped', async () => {
    const { player, engine, youtube } = setup({ tier: 'full' })
    youtube.capped.add('a')
    await player.setQueue([testTrack('a')])
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 18, 2)])
    expect(player.getState()).toMatchObject({
      status: 'playing',
      stream: { media: 'muxed-video', fullLength: 'verified', codec: 'aac' },
    })
  })

  it('remembers the working rung for the video on this network', async () => {
    const { player, engine, youtube } = setup({ tier: 'full' })
    youtube.capped.add('a')
    await player.setQueue(testTracks('a', 'b'))
    await player.next()
    await player.previous()
    expect(youtube.log).toEqual(['a:top', 'a:fallback', 'b:top'])
    expect(engine.loadedUrls).toEqual([
      ladderUrl('a', 18, 2),
      ladderUrl('b', 251, 3),
      ladderUrl('a', 18, 2),
    ])
  })

  it('falls back to itag 18 when the player can play nothing from the top rung', async () => {
    const { player, engine, youtube } = setup({ tier: 'full' })
    engine.canPlayStream = (stream) => (stream.container === 'mp4' ? 'maybe' : 'no')
    await player.setQueue([testTrack('a')])
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 18, 2)])
  })

  it('re-resolves a verified URL that fails before it plays on the same rung', async () => {
    const { player, engine, youtube } = setup({ tier: 'full' })
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    engine.startOnPlay = true
    engine.fail('network')
    await settle()
    // The probe proved the URL is not capped, so the ladder keeps its best rung.
    expect(youtube.log).toEqual(['a:top', 'a:top'])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1), ladderUrl('a', 251, 2)])
    expect(player.getState().status).toBe('playing')
  })
})

describe('capped URLs: the media element’s first request, where bytes are unreadable', () => {
  it('in Lite, falls back to itag 18 after a media error before the first play', async () => {
    const { player, engine, youtube } = setup({ tier: 'lite' })
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    expect(player.getState().stream?.fullLength).toBe('unverified')
    engine.startOnPlay = true
    // MEDIA_ERR_SRC_NOT_SUPPORTED: how a capped URL's refused request shows in a browser.
    engine.fail('unsupported')
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1), ladderUrl('a', 18, 2)])
    expect(player.getState()).toMatchObject({ status: 'playing', stream: { media: 'muxed-video' } })
  })

  it('in Lite, falls back to itag 18 after a stall before the first play', async () => {
    const { player, engine, youtube } = setup({ tier: 'lite' })
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    engine.startOnPlay = true
    // The player gives up on a load that never plays after its stall timeout.
    await settle(15_000)
    await settle(1)
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
    expect(player.getState()).toMatchObject({ status: 'playing', stream: { media: 'muxed-video' } })
  })

  it('then re-resolves from the top when itag 18 fails before it plays too', async () => {
    const { player, engine, youtube } = setup({ tier: 'lite' })
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    engine.fail('unsupported')
    await settle()
    engine.fail('unsupported')
    await settle(1000)
    expect(youtube.log).toEqual(['a:top', 'a:fallback', 'a:top'])
    expect(engine.loadedUrls).toEqual([
      ladderUrl('a', 251, 1),
      ladderUrl('a', 18, 2),
      ladderUrl('a', 251, 3),
    ])
  })

  it('treats a probe that could not read the bytes after a redirect like Lite', async () => {
    const { player, engine, youtube } = setup({ tier: 'full' })
    // With FXM Connect, a googlevideo redirect makes the bytes unreadable: 1.4 then returns the
    // URL unverified, and the media element's first request is the probe.
    youtube.handler = async (candidate, request) =>
      ladderStreams(candidate.ref, {
        rung: request.rung,
        fullLength: 'unverified',
        serial: youtube.calls.length,
        expiresAt: Date.now() + FAKE_URL_LIFETIME_MS,
      })
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    engine.startOnPlay = true
    engine.fail('unsupported')
    await settle()
    expect(youtube.checked).toEqual([ladderUrl('a', 251, 1)])
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
    expect(player.getState().stream?.media).toBe('muxed-video')
  })

  it('re-resolves the same rung after a failure in the middle of the track, and resumes', async () => {
    const { player, engine, youtube } = setup({ tier: 'lite' })
    await player.setQueue([testTrack('a')])
    engine.progress(60_000)
    engine.fail('network')
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top'])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1), ladderUrl('a', 251, 2)])
    expect(engine.loadStarts).toEqual([0, 60_000])
  })
})

describe('format choice per canPlayType', () => {
  it('plays Opus 251 where the player is sure of Opus in WebM', async () => {
    const { player, engine } = setup()
    await player.setQueue([testTrack('a')])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1)])
  })

  it('plays AAC 140 where the player only may play Opus', async () => {
    const { player, engine } = setup()
    engine.canPlayStream = (stream) => (stream.codec === 'opus' ? 'maybe' : 'probably')
    await player.setQueue([testTrack('a')])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 140, 1)])
  })

  it('plays another format from the same resolution when one cannot be decoded', async () => {
    const { player, engine, youtube } = setup()
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    engine.startOnPlay = true
    engine.fail('decode')
    await settle()
    expect(youtube.log).toEqual(['a:top'])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1), ladderUrl('a', 140, 1)])
  })

  it('streams at the cellular ceiling on mobile data', async () => {
    const { player, engine, network, setPrefs } = setup()
    setPrefs(sanitizeQualityPrefs({ streaming: { wifi: 'high', cellular: 'low' } }))
    network.change(true)
    await player.setQueue([testTrack('a')])
    // Nothing is at or below `low`, so the option that exceeds it least: AAC at 130 kbps.
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 140, 1)])
  })
})
