import { createQueue, currentQueueItem, setQueue } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { FakeEngine, FakeResolver, testStream, testTrack, testTracks } from './index'

describe('FakeEngine', () => {
  it('records calls and plays only a loaded source', async () => {
    const engine = new FakeEngine()
    const plays: string[] = []
    engine.on('play', () => plays.push('play'))
    await engine.play()
    expect(plays).toEqual([])
    await engine.load({ stream: testStream('a') }, 1000)
    expect(engine.positionMs).toBe(1000)
    await engine.play()
    expect(plays).toEqual(['play'])
    expect(engine.paused).toBe(false)
    expect(engine.count('play')).toBe(2)
    expect(engine.loadedUrls).toEqual(['https://media.test/a'])
  })

  it('stays silent on play when asked to, and fails on demand', async () => {
    const engine = new FakeEngine()
    const events: string[] = []
    engine.on('play', () => events.push('play'))
    engine.on('error', (error) => events.push(error.type))
    engine.on('ended', () => events.push('ended'))
    engine.on('timeupdate', (ms) => events.push(`at ${ms}`))
    await engine.load({ stream: testStream('a') })
    engine.startOnPlay = false
    await engine.play()
    engine.playError = 'autoplay-blocked'
    await engine.play()
    engine.progress(5000)
    engine.fail('decode', 'broken')
    engine.end()
    expect(events).toEqual(['autoplay-blocked', 'at 5000', 'decode', 'ended'])
    expect(engine.paused).toBe(true)
  })

  it('records the other controls', () => {
    const engine = new FakeEngine()
    engine.seek(42)
    engine.setVolume(0.5)
    engine.setMuted(true)
    engine.preload(null)
    engine.pause()
    expect(engine.canPlay(testStream('a'))).toBe(true)
    engine.destroy()
    expect(engine).toMatchObject({ positionMs: 42, volume: 0.5, muted: true, destroyed: true })
    expect(engine.preloaded).toBeNull()
    expect(engine.calls.map((call) => call.method)).toEqual([
      'seek',
      'setVolume',
      'setMuted',
      'preload',
      'pause',
      'destroy',
    ])
  })
})

describe('FakeResolver', () => {
  it('resolves every item to a test stream by default and records the requests', async () => {
    const resolver = new FakeResolver()
    const queue = setQueue(createQueue(), testTracks('a', 'b'))
    const item = currentQueueItem(queue)
    if (item === undefined) throw new Error('empty queue')
    const signal = new AbortController().signal
    const resolved = await resolver.resolve(item, { reason: 'play', attempt: 0, signal })
    expect(resolved).toEqual({ stream: testStream('a') })
    expect(resolver.requestsFor('a')).toEqual([{ reason: 'play', attempt: 0, signal }])
    expect(resolver.requestsFor('b')).toEqual([])
  })
})

describe('fixtures', () => {
  it('builds predictable tracks and streams', () => {
    expect(testTrack('a')).toMatchObject({ id: 'ytm:track:a', title: 'a', kind: 'song' })
    expect(testTrack('v', { kind: 'video' }).kind).toBe('video')
    expect(testStream('a b')).toMatchObject({
      url: 'https://media.test/a%20b',
      protocol: 'progressive',
    })
  })
})
