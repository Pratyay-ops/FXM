import type { StreamOption } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError } from '../engine'
import { testTrack, testTracks } from '../testing/fixtures'
import { ladderUrl, settle, setup, useFakeClock } from './test-harness'
import { FAKE_URL_LIFETIME_MS } from './testing/fake-stream-source'

beforeEach(useFakeClock)

afterEach(() => {
  vi.useRealTimers()
})

const MINUTE = 60_000

/** A failure whose HTTP status a native engine could read. */
function httpError(status: number): EngineError {
  return new EngineError('network', `HTTP ${status}`, { cause: { status } })
}

describe('re-resolving and resuming at expiry', () => {
  it('resolves a fresh URL before an expiring stream plays again, at the same position', async () => {
    const { player, engine, youtube } = setup()
    await player.setQueue(testTracks('a', 'b'))
    engine.progress(60_000)
    player.pause()
    // Paused until 5 minutes before the URL expires: inside the 10-minute margin.
    await settle(FAKE_URL_LIFETIME_MS - 5 * MINUTE)
    await player.play()
    expect(youtube.log).toEqual(['a:top', 'a:top'])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1), ladderUrl('a', 251, 2)])
    expect(engine.loadStarts).toEqual([0, 60_000])
    expect(player.getState().status).toBe('playing')
  })

  it('resolves a fresh URL when the stream expires while it plays, and resumes', async () => {
    const { player, engine, youtube } = setup()
    await player.setQueue([testTrack('a')])
    engine.progress(120_000)
    await settle(FAKE_URL_LIFETIME_MS)
    engine.fail('expired')
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top'])
    expect(engine.loadStarts).toEqual([0, 120_000])
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('a', 251, 2))
  })

  it('keeps the itag 18 fallback when it refreshes a stream that plays from it', async () => {
    const { player, engine, youtube } = setup({ tier: 'lite' })
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    engine.startOnPlay = true
    engine.fail('unsupported')
    await settle()
    engine.progress(30_000)
    await settle(FAKE_URL_LIFETIME_MS)
    engine.fail('expired')
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:fallback', 'a:fallback'])
    expect(engine.loadStarts.at(-1)).toBe(30_000)
  })
})

describe('the URL cache', () => {
  it('hands a URL out again for the same video on the same network', async () => {
    const { player, engine, youtube } = setup()
    await player.setQueue(testTracks('a', 'b'))
    await player.next()
    await player.previous()
    expect(youtube.log).toEqual(['a:top', 'b:top'])
    expect(engine.loadedUrls).toEqual([
      ladderUrl('a', 251, 1),
      ladderUrl('b', 251, 2),
      ladderUrl('a', 251, 1),
    ])
  })

  it('stops handing a URL out 10 minutes before it expires', async () => {
    const { player, youtube } = setup()
    await player.setQueue(testTracks('a', 'b'))
    await player.next()
    await settle(FAKE_URL_LIFETIME_MS - 10 * MINUTE - 1)
    await player.previous()
    expect(youtube.log).toEqual(['a:top', 'b:top'])
    await player.next()
    await settle(1)
    await player.previous()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'a:top'])
  })

  it('never hands out a URL that failed', async () => {
    const { player, engine, youtube } = setup()
    await player.setQueue(testTracks('a'))
    engine.progress(10_000)
    engine.fail('network')
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top'])
    expect(new Set(engine.loadedUrls).size).toBe(2)
  })
})

describe('flushing the URL cache', () => {
  it('drops every cached URL when the network changes', async () => {
    const { player, youtube, network, events } = setup()
    await player.setQueue(testTracks('a', 'b'))
    network.change()
    expect(events.flushes).toEqual([{ reason: 'network', dropped: 1 }])
    await player.next()
    await player.previous()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'a:top'])
  })

  it('never caches what was resolved on the network before a change', async () => {
    const { player, youtube, network } = setup()
    let release: () => void = () => {}
    const answer = youtube.handler
    youtube.handler = (candidate, request) =>
      new Promise<StreamOption[]>((resolve) => {
        release = () => resolve(youtube.answer(candidate, request))
      })
    const starting = player.setQueue(testTracks('a', 'b'))
    await settle()
    network.change()
    youtube.handler = answer
    release()
    await starting
    await player.next()
    await player.previous()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'a:top'])
  })

  it('never caches what was resolved before an IP change flushed the cache', async () => {
    const { lifecycle, player, engine, youtube, events } = setup()
    await player.setQueue(testTracks('a', 'b', 'c'))
    await player.next()
    await player.previous()
    let release: () => void = () => {}
    const answer = youtube.handler
    youtube.handler = (candidate, request) =>
      candidate.ref === 'c'
        ? new Promise<StreamOption[]>((resolve) => {
            release = () => resolve(youtube.answer(candidate, request))
          })
        : answer(candidate, request)
    const c = player.getState().queue.items[2]
    if (c === undefined) throw new Error('short queue')
    lifecycle.prefetch([c])
    await settle()
    // The cached URL answers 403 while c is still being resolved, on the old IP address.
    engine.emit('error', httpError(403))
    await settle()
    expect(events.flushes.map((flush) => flush.reason)).toEqual(['ip-changed'])
    youtube.handler = answer
    release()
    await settle()
    await player.play(2)
    expect(youtube.log.filter((entry) => entry.startsWith('c'))).toEqual(['c:top', 'c:top'])
  })

  it('never caches what was resolved before a manual flush', async () => {
    const { lifecycle, player, youtube } = setup()
    let release: () => void = () => {}
    const answer = youtube.handler
    youtube.handler = (candidate, request) =>
      new Promise<StreamOption[]>((resolve) => {
        release = () => resolve(youtube.answer(candidate, request))
      })
    const starting = player.setQueue(testTracks('a', 'b'))
    await settle()
    lifecycle.flush()
    youtube.handler = answer
    release()
    await starting
    await player.next()
    await player.previous()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'a:top'])
  })

  it('learns nothing from a stream resolved before a flush', async () => {
    const { lifecycle, player, engine, youtube, events } = setup()
    await player.setQueue(testTracks('a', 'b'))
    await player.next()
    await player.previous()
    // E.g. a native network callback, while a plays from the cache.
    lifecycle.flush()
    engine.emit('error', httpError(403))
    await settle()
    // Its URL died with the old network: no second flush, and no 403 counted against the rung.
    expect(events.flushes.map((flush) => flush.reason)).toEqual(['manual'])
    engine.emit('error', httpError(403))
    await settle(1000)
    expect(youtube.log).toEqual(['a:top', 'b:top', 'a:top', 'a:top'])
  })

  it('drops every cached URL on a 403 for a cached URL, a probable IP change', async () => {
    const { lifecycle, player, engine, youtube, events } = setup()
    await player.setQueue(testTracks('a', 'b', 'c'))
    lifecycle.prefetch(player.getState().queue.items.slice(1))
    await settle()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'c:top'])
    await player.next()
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('b', 251, 2))
    engine.emit('error', httpError(403))
    await settle()
    expect(events.flushes).toEqual([{ reason: 'ip-changed', dropped: 3 }])
    // The 403 is resolved again on the same rung first.
    expect(youtube.log).toEqual(['a:top', 'b:top', 'c:top', 'b:top'])
    await player.next()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'c:top', 'b:top', 'c:top'])
  })

  it('reads the status with a probe where the bytes are readable', async () => {
    const { player, engine, youtube, events } = setup({ tier: 'full' })
    await player.setQueue(testTracks('a', 'b'))
    await player.next()
    await player.previous()
    youtube.statuses.set(ladderUrl('a', 251, 1), 403)
    // `<audio>` reports a refused request as a media error, never with its status.
    engine.fail('unsupported')
    await settle()
    expect(youtube.checked).toEqual([ladderUrl('a', 251, 1)])
    expect(events.flushes).toEqual([{ reason: 'ip-changed', dropped: 2 }])
  })

  it('drops only the failed URL where no status is readable', async () => {
    const { player, engine, youtube, events } = setup({ tier: 'lite' })
    await player.setQueue(testTracks('a', 'b'))
    await player.next()
    await player.previous()
    engine.progress(5000)
    engine.fail('unsupported')
    await settle()
    expect(youtube.checked).toEqual([])
    expect(events.flushes).toEqual([])
    await player.next()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'a:top'])
  })

  it('resolves again once on a 403 before it changes rung', async () => {
    const { player, engine, youtube } = setup()
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    engine.emit('error', httpError(403))
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top'])
    engine.emit('error', httpError(403))
    await settle(1000)
    expect(youtube.log).toEqual(['a:top', 'a:top', 'a:fallback'])
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('a', 18, 3))
  })

  it('counts 403s per failure episode, so a 403 much later keeps the rung', async () => {
    const { player, engine, youtube } = setup()
    engine.startOnPlay = false
    await player.setQueue([testTrack('a')])
    engine.startOnPlay = true
    engine.emit('error', httpError(403))
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top'])
    expect(player.getState().status).toBe('playing')
    // Two hours of normal play later, the fresh URL answers 403 once.
    engine.progress(60_000)
    await settle(2 * 60 * MINUTE)
    engine.emit('error', httpError(403))
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top', 'a:top'])
    expect(player.getState().stream?.media).toBe('audio')
  })

  it('resolves again on 401 and 410 where the status is readable', async () => {
    const { player, engine, youtube } = setup()
    await player.setQueue([testTrack('a')])
    engine.progress(20_000)
    engine.emit('error', httpError(401))
    await settle()
    engine.progress(40_000)
    engine.emit('error', httpError(410))
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top', 'a:top'])
    expect(engine.loadStarts).toEqual([0, 20_000, 40_000])
  })

  it('drops every cached URL on request', () => {
    const { lifecycle, events } = setup()
    lifecycle.flush()
    expect(events.flushes).toEqual([{ reason: 'manual', dropped: 0 }])
  })
})
