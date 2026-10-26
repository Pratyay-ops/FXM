import {
  DEFAULT_STREAMING_SETTINGS,
  type StreamingSettings,
  type StreamOption,
  sanitizeQualityPrefs,
} from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTrack, testTracks } from '../testing/fixtures'
import { ladderUrl, settle, setup, useFakeClock } from './test-harness'
import { ladderStreams } from './testing/fake-stream-source'

beforeEach(useFakeClock)

afterEach(() => {
  vi.useRealTimers()
})

/** The lifecycle with streaming settings a test can change between streams. */
function withStreaming(initial: Partial<StreamingSettings> = {}) {
  let streaming: StreamingSettings = { ...DEFAULT_STREAMING_SETTINGS, ...initial }
  const harness = setup({ lifecycle: { streaming: () => streaming } })
  return {
    ...harness,
    setStreaming(next: Partial<StreamingSettings>) {
      streaming = { ...streaming, ...next }
    },
  }
}

/** The itag of a fake ladder URL: `https://media.test/<ref>/<itag>?n=<serial>`. */
function itagOf(stream: StreamOption | undefined): string | undefined {
  return stream?.url.split('/').at(-1)?.split('?')[0]
}

describe('the quality settings (stage 4.3)', () => {
  it('streams at the Wi-Fi ceiling by default and lets the ladder probe as it does', async () => {
    const { player, engine, youtube } = setup()
    await player.setQueue([testTrack('a')])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1)])
    expect(youtube.calls[0]?.request.probe?.scope).toBe('default')
  })

  it('streams at Low on Wi-Fi with the data saver on', async () => {
    const { player, engine } = withStreaming({ dataSaver: true })
    await player.setQueue([testTrack('a')])
    // Nothing is at or below `low`, so the option that exceeds it least: AAC at 130 kbps.
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 140, 1)])
  })

  it('asks the ladder to probe only the stream it then plays, with the data saver on', async () => {
    const { player, engine, youtube } = withStreaming({ dataSaver: true })
    engine.canPlayStream = (stream) => (stream.codec === 'aac' ? 'maybe' : 'probably')
    await player.setQueue([testTrack('a')])
    const probe = youtube.calls[0]?.request.probe
    expect(probe?.scope).toBe('chosen')
    const found = ladderStreams('a', { rung: 'top', fullLength: 'unverified', serial: 1 })
    expect(itagOf(probe?.choose(found))).toBe('251')
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1)])
  })

  it('puts audio only before a muxed video on Wi-Fi with the data saver on', async () => {
    const { player, engine, youtube, setPrefs, setStreaming } = withStreaming()
    youtube.handler = async ({ ref }) => {
      const serial = youtube.calls.length
      return [
        ...ladderStreams(ref, { rung: 'top', fullLength: 'verified', serial }),
        ...ladderStreams(ref, { rung: 'fallback', fullLength: 'verified', serial }),
      ]
    }
    setPrefs(sanitizeQualityPrefs({ streaming: { wifi: 'normal' } }))
    await player.setQueue(testTracks('a', 'b'))
    // Without the data saver, the tier decides: itag 18's AAC track is `normal`.
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 18, 1)])
    expect(youtube.calls.at(-1)?.request.probe?.scope).toBe('default')
    setStreaming({ dataSaver: true })
    await player.next()
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('b', 140, 2))
    expect(youtube.calls.at(-1)?.request.probe?.scope).toBe('chosen')
  })

  it('lets the next probe plan skip a format that failed to decode', async () => {
    const { player, engine, youtube, lifecycle } = withStreaming({ dataSaver: true })
    engine.canPlayStream = (stream) => (stream.codec === 'aac' ? 'maybe' : 'probably')
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1)])
    engine.startOnPlay = true
    engine.fail('decode')
    await settle()
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('a', 140, 1))

    // A fresh resolution of the same song: Opus didn't decode here, so the plan picks AAC.
    lifecycle.flush()
    await player.setQueue([testTrack('a')])
    expect(youtube.calls).toHaveLength(2)
    const plan = youtube.calls.at(-1)?.request.probe
    const found = ladderStreams('a', { rung: 'top', fullLength: 'unverified', serial: 2 })
    expect(plan?.scope).toBe('chosen')
    expect(itagOf(plan?.choose(found))).toBe('140')
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('a', 140, 2))
  })

  it('lets the probe plan skip a URL that failed on this network', async () => {
    const { player, engine, youtube } = withStreaming({ dataSaver: true })
    engine.canPlayStream = (stream) => (stream.codec === 'aac' ? 'maybe' : 'probably')
    await player.setQueue([testTrack('a')])
    engine.progress(10_000)
    engine.fail('network')
    await settle()
    // A failure after playing resolves the same rung again, and its old URL is never reused.
    expect(youtube.calls).toHaveLength(2)
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1), ladderUrl('a', 251, 2)])
    const first = ladderStreams('a', { rung: 'top', fullLength: 'unverified', serial: 1 })
    expect(itagOf(youtube.calls.at(-1)?.request.probe?.choose(first))).toBe('140')
  })

  it('follows the connection the user chose over the detected one', async () => {
    const { player, engine, network, setPrefs, setStreaming } = withStreaming({
      connection: 'cellular',
    })
    setPrefs(sanitizeQualityPrefs({ streaming: { wifi: 'high', cellular: 'low' } }))
    await player.setQueue(testTracks('a', 'b'))
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 140, 1)])
    network.change(true)
    setStreaming({ connection: 'wifi' })
    await player.next()
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('b', 251, 2))
  })

  it('follows the detected connection on automatic', async () => {
    const { player, engine, network, setPrefs } = withStreaming({ connection: 'auto' })
    setPrefs(sanitizeQualityPrefs({ streaming: { wifi: 'high', cellular: 'low' } }))
    await player.setQueue(testTracks('a', 'b'))
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1)])
    network.change(true)
    await player.next()
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('b', 140, 2))
  })
})
