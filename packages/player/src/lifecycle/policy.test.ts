import {
  createQueue,
  currentQueueItem,
  FxmError,
  formatId,
  isFxmError,
  playbackProblemOf,
  type QueueItem,
  type StreamOption,
  setQueue,
  type Track,
} from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeResolver } from '../testing/fake-resolver'
import { testStream, testTrack, testTracks } from '../testing/fixtures'
import type { OfflineStore } from './adapters'
import { StreamLifecycle } from './stream-lifecycle'
import { ladderUrl, playRequest, settle, setup, useFakeClock } from './test-harness'
import { FakeStreamSource } from './testing/fake-stream-source'
import { testCandidate, testContext, testSpotifyTrack } from './testing/fixtures'

beforeEach(useFakeClock)

afterEach(() => {
  vi.useRealTimers()
})

const flac = testCandidate('item/track.flac', {
  source: 'archive',
  signals: { isrcVerified: false, sourceAlbumMatch: false },
})

function archiveSource() {
  return new FakeStreamSource({ id: 'archive', expires: false, now: () => Date.now() })
}

describe('the order of preference', () => {
  it('plays an offline copy first', async () => {
    const offlineStream = testStream('offline', {
      url: 'blob:fxm/offline-a',
      fullLength: 'verified',
    })
    const offline: OfflineStore = {
      find: async (track) => (track.title === 'a' ? offlineStream : undefined),
    }
    const { player, engine, youtube } = setup({ offline })
    await player.setQueue(testTracks('a', 'b'))
    expect(engine.loadedUrls).toEqual(['blob:fxm/offline-a'])
    expect(youtube.calls).toHaveLength(0)
  })

  it('skips an offline copy that failed, and one the store cannot read', async () => {
    const offlineStream = testStream('offline', {
      url: 'blob:fxm/offline-a',
      fullLength: 'verified',
    })
    let broken = false
    const offline: OfflineStore = {
      find: async () => {
        if (broken) throw new Error('storage gone')
        return offlineStream
      },
    }
    const { player, engine, youtube } = setup({ offline })
    await player.setQueue([testTrack('a')])
    engine.fail('decode')
    await settle()
    expect(engine.loadedUrls).toEqual(['blob:fxm/offline-a', ladderUrl('a', 251, 1)])
    broken = true
    engine.progress(10_000)
    engine.fail('network')
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top'])
  })

  it('plays an ISRC-verified or Auto lossless match first with "prefer lossless" on', async () => {
    const archive = archiveSource()
    const { player, engine, youtube, matcher, recorded } = setup({
      sources: [archive],
      settings: { preferLossless: true },
    })
    matcher.rank(testTrack('a'), 'lossless', [{ candidate: flac, band: 'auto' }])
    await player.setQueue([testTrack('a')])
    expect(youtube.calls).toHaveLength(0)
    expect(engine.loadedUrls).toEqual(['https://archive.test/item%2Ftrack.flac/251?n=1'])
    expect(recorded()).toEqual(flac)
  })

  it('plays an ISRC-verified lossless guess first, and the song for a guess without one', async () => {
    const archive = archiveSource()
    const verified = { ...flac, signals: { isrcVerified: true, sourceAlbumMatch: false } }
    const { player, youtube, matcher } = setup({
      sources: [archive],
      settings: { preferLossless: true },
    })
    matcher.rank(testTrack('a'), 'lossless', [{ candidate: verified, band: 'suggest' }])
    matcher.rank(testTrack('b'), 'lossless', [{ candidate: flac, band: 'suggest' }])
    await player.setQueue(testTracks('a', 'b'))
    expect(archive.log).toEqual(['item/track.flac:top'])
    await player.next()
    expect(youtube.log).toEqual(['b:top'])
  })

  it('falls back to the song when the lossless match fails in any way', async () => {
    const { player, youtube, matcher } = setup({ settings: { preferLossless: true } })
    matcher.fail(testTrack('a'), 'lossless', new FxmError('Network', 'archive.org is down'))
    await player.setQueue([testTrack('a')])
    expect(youtube.log).toEqual(['a:top'])
  })

  it('matches a Spotify track to its song and records the match', async () => {
    const spotify = testSpotifyTrack('S')
    const { player, matcher, recorded } = setup()
    matcher.rank(spotify, 'song', [{ candidate: testCandidate('song'), band: 'auto' }])
    await player.setQueue([spotify])
    expect(recorded()).toEqual(testCandidate('song'))
    expect(matcher.calls[0]?.request).toMatchObject({ target: 'song', priority: 'playback' })
  })

  it('plays a music video in Music mode as its linked song', async () => {
    const video = testTrack('v', { kind: 'music-video', songId: formatId('ytm', 'track', 'song') })
    const { player, youtube, matcher, recorded } = setup()
    await player.setQueue([video])
    expect(youtube.log).toEqual(['song:top'])
    expect(recorded()).toMatchObject({ source: 'ytm', ref: 'song', kind: 'song' })
    expect(matcher.calls).toHaveLength(0)
  })

  it('tries the Invidious instance the user entered after the ladder gives up', async () => {
    const invidious = new FakeStreamSource({ host: 'invidious.test', now: () => Date.now() })
    const { player, engine, youtube } = setup({ invidious, settings: { useInvidious: true } })
    youtube.errors.set('a', new FxmError('BotCheck', 'LOGIN_REQUIRED'))
    await player.setQueue([testTrack('a')])
    expect(invidious.log).toEqual(['a:top'])
    expect(engine.loadedUrls).toEqual(['https://invidious.test/a/251?n=1'])
    expect(player.getState().status).toBe('playing')
  })

  it('keeps Invidious off until the user turns it on', async () => {
    const invidious = new FakeStreamSource({ host: 'invidious.test' })
    const { player, youtube } = setup({ invidious })
    youtube.errors.set('a', new FxmError('BotCheck', 'LOGIN_REQUIRED'))
    await player.setQueue([testTrack('a')])
    expect(invidious.calls).toHaveLength(0)
    expect(player.getState()).toMatchObject({
      status: 'error',
      error: { reason: 'action-required' },
    })
  })

  it('needs FXM Connect or Lite for YouTube audio', async () => {
    const { player, youtube, failed } = setup({ tier: 'free' })
    await player.setQueue([testTrack('a'), testSpotifyTrack('S')])
    expect(youtube.calls).toHaveLength(0)
    expect(isFxmError(failed[0], 'Unsupported')).toBe(true)
    expect(player.getState()).toMatchObject({
      status: 'error',
      error: { reason: 'action-required' },
    })
  })

  it('cannot match songs without YouTube access', async () => {
    const spotify = testSpotifyTrack('S')
    const { player, matcher, failed } = setup({ tier: 'free' })
    await player.setQueue([spotify])
    expect(matcher.calls).toHaveLength(0)
    expect(isFxmError(failed[0], 'Unsupported')).toBe(true)
  })

  it('reports "Unavailable", with the alternatives, when nothing matches', async () => {
    const spotify = testSpotifyTrack('S')
    const near = testCandidate('near')
    const { player, matcher, failed } = setup()
    matcher.rank(spotify, 'song', [
      { candidate: near, band: 'none' },
      { candidate: testCandidate('far'), band: 'none' },
    ])
    await player.setQueue([spotify])
    expect(playbackProblemOf(failed[0])).toEqual({
      type: 'unavailable',
      trackId: spotify.id,
      reason: 'no-match',
      alternatives: [testCandidate('far')],
    })
  })

  it('reports a track that nothing on the platform can play as unavailable', async () => {
    const local: Track = { ...testTrack('l'), id: formatId('local', 'track', 'l'), source: 'local' }
    const { player, failed } = setup()
    await player.setQueue([local])
    expect(playbackProblemOf(failed[0])).toMatchObject({ reason: 'no-source' })
  })

  it('plays only stored matches without a matching engine', async () => {
    const spotify = testSpotifyTrack('S')
    const youtube = new FakeStreamSource()
    const lifecycle = new StreamLifecycle({ sources: [youtube], context: () => testContext() })
    const item = (track: Track): QueueItem => {
      const queue = setQueue(createQueue(), [track])
      const found = currentQueueItem(queue)
      if (found === undefined) throw new Error('empty queue')
      return found
    }
    const request = playRequest()
    await expect(lifecycle.resolve(item(spotify), request)).rejects.toMatchObject({
      code: 'Unavailable',
    })
    await lifecycle.confirmMatch(spotify, testCandidate('song'))
    const resolved = await lifecycle.resolve(item(spotify), request)
    expect(resolved.candidate).toEqual(testCandidate('song'))
  })
})

describe('prefetching and shared resolutions', () => {
  it('prefetches the next three tracks when the player prepares the next one', async () => {
    const { player, engine, youtube } = setup()
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e'))
    engine.emit('durationchange', 180_000)
    engine.progress(150_000)
    await settle()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'c:top', 'd:top'])
    expect(youtube.calls.slice(1).map((call) => call.request.priority)).toEqual([
      'prefetch',
      'prefetch',
      'prefetch',
    ])
    engine.end()
    await settle()
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('b', 251, 2))
    expect(youtube.callsFor('b')).toBe(1)
  })

  it('shares a resolution in flight between the player and the prefetch', async () => {
    const { lifecycle, player, engine, youtube } = setup()
    const pending: ((options: StreamOption[]) => void)[] = []
    await player.setQueue(testTracks('a', 'b'))
    youtube.handler = (candidate, request) =>
      new Promise((resolve) => pending.push(() => resolve(youtube.answer(candidate, request))))
    const [, b] = player.getState().queue.items
    if (b === undefined) throw new Error('no second item')
    lifecycle.prefetch([b])
    await settle()
    const moving = player.next()
    await settle()
    expect(youtube.callsFor('b')).toBe(1)
    for (const release of pending) release([])
    await moving
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('b', 251, 2))
    expect(youtube.callsFor('b')).toBe(1)
  })

  it('lets a later prefetch take over from an earlier one', async () => {
    const { lifecycle, player, youtube } = setup()
    await player.setQueue(testTracks('a', 'b', 'c', 'd'))
    const [, b, c, d] = player.getState().queue.items
    if (b === undefined || c === undefined || d === undefined) throw new Error('short queue')
    lifecycle.prefetch([b, c])
    lifecycle.prefetch([d])
    await settle()
    expect(youtube.log).toEqual(['a:top', 'b:top', 'd:top'])
  })

  it('never prefetches the current item or more than the limit', async () => {
    const { lifecycle, player, youtube } = setup({ lifecycle: { prefetchCount: 1 } })
    await player.setQueue(testTracks('a', 'b', 'c'))
    const items = player.getState().queue.items
    lifecycle.prefetch([...items, ...items])
    await settle()
    expect(youtube.log).toEqual(['a:top', 'b:top'])
  })
})

describe('retries and the circuit breaker', () => {
  it('stops after 4 tracks fail every retry, asking for fresh audio each time', async () => {
    const { player, youtube } = setup()
    for (const ref of ['a', 'b', 'c', 'd', 'e']) {
      youtube.errors.set(ref, new FxmError('Network', 'timeout'))
    }
    const circuit: number[] = []
    player.on('circuitopen', ({ failures }) => circuit.push(failures))
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e'))
    await vi.runAllTimersAsync()
    expect(circuit).toEqual([4])
    expect(player.getState().error?.reason).toBe('circuit-open')
    expect(youtube.calls).toHaveLength(16)
    expect(youtube.callsFor('e')).toBe(0)
  })

  it('waits longer before each retry', async () => {
    const { player, youtube } = setup()
    youtube.errors.set('a', new FxmError('Network', 'timeout'))
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    expect(youtube.callsFor('a')).toBe(2)
    await settle(999)
    expect(youtube.callsFor('a')).toBe(2)
    await settle(1)
    expect(youtube.callsFor('a')).toBe(3)
    await settle(3000)
    expect(youtube.callsFor('a')).toBe(4)
  })
})

describe('the resolver contract', () => {
  function firstItem(tracks: readonly Track[]): QueueItem {
    const found = currentQueueItem(setQueue(createQueue(), tracks))
    if (found === undefined) throw new Error('empty queue')
    return found
  }

  it('rejects once destroyed, and its signal aborts a resolution', async () => {
    const youtube = new FakeStreamSource()
    const lifecycle = new StreamLifecycle({ sources: [youtube], context: () => testContext() })
    const abort = new AbortController()
    abort.abort(new Error('skipped'))
    await expect(
      lifecycle.resolve(firstItem([testTrack('a')]), playRequest(abort.signal)),
    ).rejects.toThrow('skipped')
    lifecycle.destroy()
    lifecycle.destroy()
    lifecycle.prefetch([firstItem([testTrack('a')])])
    lifecycle.flush()
    await expect(lifecycle.resolve(firstItem([testTrack('a')]), playRequest())).rejects.toThrow(
      'destroyed',
    )
    expect(youtube.calls).toHaveLength(0)
  })

  it('never plays a guess for a player it does not follow', async () => {
    const spotify = testSpotifyTrack('S')
    const { lifecycle, matcher } = setup({ attach: false })
    matcher.rank(spotify, 'song', [{ candidate: testCandidate('g'), band: 'suggest' }])
    const request = playRequest()
    const error = await lifecycle.resolve(firstItem([spotify]), request).catch((e: unknown) => e)
    expect(playbackProblemOf(error)?.type).toBe('needs-review')
  })

  it('follows only the player attached last, until it is detached', async () => {
    const spotify = testSpotifyTrack('S')
    const { lifecycle, player, engine, matcher, failed } = setup({ attach: false })
    matcher.rank(spotify, 'song', [{ candidate: testCandidate('g'), band: 'suggest' }])
    const stale = lifecycle.attach(player)
    const detach = lifecycle.attach(player)
    stale()
    await player.setQueue([spotify])
    expect(engine.loadedUrls).toEqual([ladderUrl('g', 251, 1)])
    detach()
    await player.setQueue([spotify])
    expect(playbackProblemOf(failed[0])?.type).toBe('needs-review')
  })

  it('reports to the player whether a failed stream had started playing', async () => {
    const resolver = new FakeResolver()
    const { player, engine } = setup({ player: { resolver } })
    engine.startOnPlay = false
    await player.setQueue(testTracks('a'))
    engine.fail('unsupported')
    await settle()
    engine.emit('play', undefined)
    engine.progress(5000)
    engine.fail('network')
    await settle(1000)
    expect(resolver.requestsFor('a').map((request) => request.failure?.started)).toEqual([
      undefined,
      false,
      true,
    ])
  })
})
