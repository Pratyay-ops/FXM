import {
  currentQueueItem,
  entityKey,
  type NetworkCapabilities,
  type QueueItem,
  type QueueState,
  type RadioPick,
  recSeedOf,
  seedKey,
  type Track,
  trackKeys,
} from '@fxm/core'
import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTrack, testTracks } from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHomeServicesStore,
  type HomeSources,
  type HomeSourcesSnapshot,
  staticSources,
} from '../home/services'
import { fakeRecommendations, homeServices, TIERS } from '../home/testing'
import { AUTOPLAY_SETTLE_MS, connectAutoplay, type PlanExtension } from './autoplay'
import { createAutoplayMarksStore, isAutoplayItem } from './autoplay-marks'
import { createAutoplayStore } from './autoplay-store'
import type { AppExtensionRequest, Extension } from './extend'

const NOW = Date.UTC(2026, 9, 26, 12)

const titles = (items: readonly QueueItem[]) => items.map((item) => item.track.title)

/** `track`, picked from the radio of `seed`. */
function pickOf(track: Track, seed: Track): RadioPick {
  const ref = recSeedOf(seed)
  return {
    track,
    score: 1,
    seed: { key: seedKey(ref) ?? '', seed, ref, parts: ['radio'], purposes: ['radio'], weight: 1 },
  }
}

/** A promise to settle by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Sources whose reach a test changes, telling subscribers. */
function changingSources(capabilities: NetworkCapabilities): HomeSources & {
  reach(next: NetworkCapabilities): void
  /** How many listen. */
  readonly listeners: number
} {
  let snapshot: HomeSourcesSnapshot = { capabilities, spotifyEnabled: true }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    context: (options) => staticSources(snapshot.capabilities).context(options),
    reach(next) {
      snapshot = { capabilities: next, spotifyEnabled: true }
      for (const listener of [...listeners]) listener()
    },
    get listeners() {
      return listeners.size
    },
  }
}

/**
 * A player on fakes with autoplay connected: its plans answer with `count` new songs named
 * `radio <n>`, from the radio of the track playing, unless a test answers otherwise.
 */
function setup({
  services = homeServices('full', { recommendations: fakeRecommendations() }),
} = {}) {
  const engine = new FakeEngine()
  const player = new Player({
    engine,
    resolver: new FakeResolver(),
    queue: { mode: 'music' },
    retryDelaysMs: [0],
    stallTimeoutMs: 0,
    preload: false,
  })
  const store = createHomeServicesStore(services)
  const settings = createAutoplayStore({ storage: () => undefined })
  const marks = createAutoplayMarksStore({ storage: () => undefined })
  const requests: AppExtensionRequest[] = []
  const errors: unknown[] = []
  let made = 0
  const radio = (request: AppExtensionRequest): Extension => {
    const seed = currentQueueItem(request.queue)?.track ?? testTrack('nothing')
    return {
      picks: Array.from({ length: request.count }, () =>
        pickOf(testTrack(`radio ${++made}`), seed),
      ),
    }
  }
  const answers: Array<(request: AppExtensionRequest) => Promise<Extension>> = []
  const plan: PlanExtension = (request) => {
    requests.push(request)
    const answer = answers.shift()
    return answer === undefined ? Promise.resolve(radio(request)) : answer(request)
  }
  const disconnect = connectAutoplay(player, {
    services: store,
    settings,
    marks,
    plan,
    now: () => NOW,
    syncTabs: false,
    onError: (error) => errors.push(error),
  })
  return {
    player,
    engine,
    store,
    settings,
    marks,
    requests,
    errors,
    disconnect,
    radio,
    /** Answers the next plans with these, in order. */
    answer(...next: Array<(request: AppExtensionRequest) => Promise<Extension>>) {
      answers.push(...next)
    },
    /** The items autoplay marked, by title. */
    marked: () =>
      titles(
        player
          .getState()
          .queue.items.filter((item) => isAutoplayItem(marks.getState().marks, item)),
      ),
  }
}

/** Waits out the settling time, and lets the plan finish. */
async function settle(ms = AUTOPLAY_SETTLE_MS) {
  await vi.advanceTimersByTimeAsync(ms)
}

const queueTitles = (player: Player) => titles(player.getState().queue.items)
const upcoming = (queue: QueueState) => titles(queue.items.slice(queue.index + 1))

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('connectAutoplay', () => {
  it('adds a batch once fewer than three tracks remain, after the queue settles', async () => {
    const { player, requests, marks, marked } = setup()
    await player.setQueue(testTracks('a', 'b', 'c'), { startIndex: 1 })

    await settle(AUTOPLAY_SETTLE_MS - 1)
    expect(requests).toEqual([])
    await settle(1)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ count: 4, now: NOW })
    expect(titles(requests[0]?.queue.items ?? [])).toEqual(['a', 'b', 'c'])
    expect(queueTitles(player)).toEqual(['a', 'b', 'c', 'radio 1', 'radio 2', 'radio 3', 'radio 4'])
    expect(marked()).toEqual(['radio 1', 'radio 2', 'radio 3', 'radio 4'])
    // Each mark names the radio's seed: the track that played when it was planned.
    const first = player.getState().queue.items[3] as QueueItem
    expect(marks.getState().marks[String(first.uid)]?.seed).toBe(testTrack('b').id)
  })

  it('adds nothing while enough remain, repeat is on, autoplay is off, or YouTube is out of reach', async () => {
    const enough = setup()
    await enough.player.setQueue(testTracks('a', 'b', 'c', 'd'), { startIndex: 0 })
    await settle()
    expect(enough.requests).toEqual([])

    const repeating = setup()
    repeating.player.setRepeat('all')
    await repeating.player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(repeating.requests).toEqual([])

    const off = setup()
    off.settings.getState().setEnabled(false)
    await off.player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(off.requests).toEqual([])

    const free = setup({
      services: homeServices('free', { recommendations: fakeRecommendations() }),
    })
    await free.player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(free.requests).toEqual([])

    const unwired = setup({ services: homeServices('full') })
    await unwired.player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(unwired.requests).toEqual([])
  })

  it('plans a burst of changes once', async () => {
    const { player, requests } = setup()
    await player.setQueue(testTracks('a', 'b', 'c'), { startIndex: 1, autoplay: false })
    await settle(1000)
    await player.next()
    await settle(AUTOPLAY_SETTLE_MS - 1)
    expect(requests).toEqual([])
    await settle(1)
    expect(requests).toHaveLength(1)
    expect(currentQueueItem(requests[0]?.queue as QueueState)?.track.title).toBe('c')
  })

  it('plans one state of the queue once, and again when the queue moves on', async () => {
    const { player, requests, answer } = setup()
    answer(async () => ({ picks: [] }))
    await player.setQueue(testTracks('a', 'b', 'c', 'd'), { startIndex: 0 })
    await settle()
    expect(requests).toHaveLength(0)
    await player.next()
    await settle()
    expect(requests).toHaveLength(1)
    // Nothing found: a pause, a seek or the volume don't make it ask again.
    player.pause()
    player.seek(20_000)
    player.setVolume(0.2)
    await settle(5 * AUTOPLAY_SETTLE_MS)
    expect(requests).toHaveLength(1)
    await player.next()
    await settle()
    expect(requests).toHaveLength(2)
    expect(upcoming(player.getState().queue)).toEqual([
      'd',
      'radio 1',
      'radio 2',
      'radio 3',
      'radio 4',
    ])
  })

  it('drops a plan whose queue changed meanwhile, and plans the queue as it is', async () => {
    const { player, requests, answer, marked } = setup()
    const late = deferred<Extension>()
    answer(() => late.promise)
    await player.setQueue(testTracks('a', 'b'), { startIndex: 0 })
    await settle()
    expect(requests).toHaveLength(1)

    await player.next()
    expect(requests[0]?.signal?.aborted).toBe(true)
    late.resolve({ picks: [pickOf(testTrack('stale'), testTrack('a'))] })
    await settle()

    expect(requests).toHaveLength(2)
    expect(queueTitles(player)).not.toContain('stale')
    expect(marked()).toEqual(['radio 1', 'radio 2', 'radio 3', 'radio 4'])
  })

  it('plans a state of the queue again when it comes back after its plan was dropped', async () => {
    const { player, requests, answer } = setup()
    answer(() => new Promise(() => {}))
    await player.setQueue(testTracks('a', 'b'), { startIndex: 0 })
    await settle()
    await player.next()
    await settle(AUTOPLAY_SETTLE_MS / 2)
    await player.previous()
    await settle()
    expect(requests).toHaveLength(2)
    expect(currentQueueItem(requests[1]?.queue as QueueState)?.track.title).toBe('a')
    expect(upcoming(player.getState().queue)).toEqual([
      'b',
      'radio 1',
      'radio 2',
      'radio 3',
      'radio 4',
    ])
  })

  it('doesn’t take songs the catalog mode hid for songs the user removed', async () => {
    const { player, requests, answer } = setup()
    player.setCatalogMode('all')
    answer(async (request) => ({
      picks: [pickOf(testTrack('clip', { kind: 'video' }), request.queue.items[0]?.track as Track)],
    }))
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(upcoming(player.getState().queue)).toEqual(['clip'])
    player.setCatalogMode('music')
    expect(upcoming(player.getState().queue)).toEqual([])
    await settle()
    expect(requests).toHaveLength(2)
    expect([...(requests[1]?.exclude ?? [])]).toEqual([])
  })

  it('drops a plan when the catalog mode changes', async () => {
    const { player, requests, answer } = setup()
    const late = deferred<Extension>()
    answer(() => late.promise)
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    player.setCatalogMode('all')
    expect(requests[0]?.signal?.aborted).toBe(true)
    await settle()
    expect(requests[1]?.queue.mode).toBe('all')
  })

  it('plays on when the queue ended while a plan was on its way', async () => {
    const { player, engine, requests, answer } = setup()
    const late = deferred<Extension>()
    answer(() => late.promise)
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(requests).toHaveLength(1)

    engine.end()
    expect(player.getState().status).toBe('ended')
    late.resolve({ picks: [pickOf(testTrack('next up'), testTrack('a'))] })
    await settle(0)

    expect(currentQueueItem(player.getState().queue)?.track.title).toBe('next up')
    expect(['loading', 'playing']).toContain(player.getState().status)
  })

  it('tries again at once when the queue ends after a plan found nothing, and plays on', async () => {
    const { player, engine, requests, answer } = setup()
    answer(async () => ({ picks: [] }))
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(requests).toHaveLength(1)

    engine.end()
    await settle(0)

    expect(requests).toHaveLength(2)
    expect(currentQueueItem(player.getState().queue)?.track.title).toBe('radio 1')
    expect(['loading', 'playing']).toContain(player.getState().status)
  })

  it('adds without playing to a queue that ended before', async () => {
    const { player, engine, settings, requests } = setup()
    settings.getState().setEnabled(false)
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    engine.end()
    settings.getState().setEnabled(true)
    await settle()
    expect(requests).toHaveLength(1)
    expect(player.getState().status).toBe('ended')
    expect(upcoming(player.getState().queue)).toEqual(['radio 1', 'radio 2', 'radio 3', 'radio 4'])
  })

  it('stops adding when switched off, and takes out the songs it added that haven’t played', async () => {
    const { player, settings, requests, marked } = setup()
    await player.setQueue(testTracks('a', 'b', 'c'), { startIndex: 1 })
    await settle()
    await player.next()
    await player.next()
    player.addToQueue([testTrack('mine')])
    expect(currentQueueItem(player.getState().queue)?.track.title).toBe('radio 1')

    settings.getState().setEnabled(false)

    expect(queueTitles(player)).toEqual(['a', 'b', 'c', 'radio 1', 'mine'])
    expect(marked()).toEqual(['radio 1'])
    await player.next()
    await settle()
    expect(requests).toHaveLength(1)

    // On again: the queue is low, so it adds at once, and what it took out counts as nothing
    // the user removed.
    settings.getState().setEnabled(true)
    await settle()
    expect(requests).toHaveLength(2)
    expect([...(requests[1]?.exclude ?? [])]).toEqual([])
    expect(upcoming(player.getState().queue)).toEqual(['radio 5', 'radio 6', 'radio 7', 'radio 8'])
  })

  it('drops a plan on its way when switched off', async () => {
    const { player, settings, requests, answer } = setup()
    const late = deferred<Extension>()
    answer(() => late.promise)
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    settings.getState().setEnabled(false)
    expect(requests[0]?.signal?.aborted).toBe(true)
    late.resolve({ picks: [pickOf(testTrack('stale'), testTrack('a'))] })
    await settle()
    expect(queueTitles(player)).toEqual(['a'])
  })

  it('never brings back a song the user removed', async () => {
    const { player, requests } = setup()
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(upcoming(player.getState().queue)).toEqual(['radio 1', 'radio 2', 'radio 3', 'radio 4'])

    player.remove(2)
    player.remove(2)
    await settle()

    expect(requests).toHaveLength(2)
    const exclude = new Set(requests[1]?.exclude)
    for (const key of [...trackKeys(testTrack('radio 2')), ...trackKeys(testTrack('radio 3'))]) {
      expect(exclude.has(key)).toBe(true)
    }
    expect(exclude.has(entityKey(testTrack('radio 1').id))).toBe(false)
  })

  it('counts nothing as removed when a new queue replaces the old one', async () => {
    const { player, requests } = setup()
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    await player.setQueue(testTracks('x'), { startIndex: 0 })
    await settle()
    expect(requests).toHaveLength(2)
    expect([...(requests[1]?.exclude ?? [])]).toEqual([])
  })

  it('keeps marks only for the items of the queue, also a restored one', async () => {
    const marks = createAutoplayMarksStore({ storage: () => undefined })
    const kept = testTrack('kept')
    marks.getState().add([
      { uid: 0, trackId: kept.id, seed: kept.id },
      { uid: 1, trackId: testTrack('gone').id, seed: kept.id },
    ])
    const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    const saved = { items: [{ uid: 0, track: kept }], index: 0, playedUids: [], nextUid: 1 }
    expect(player.restore({ ...saved, mode: 'music', repeat: 'off', shuffle: false }, 0)).toBe(true)
    const disconnect = connectAutoplay(player, {
      services: createHomeServicesStore(homeServices('free')),
      settings: createAutoplayStore({ storage: () => undefined }),
      marks,
      syncTabs: false,
    })
    expect(Object.keys(marks.getState().marks)).toEqual(['0'])
    disconnect()
  })

  it('starts once the platform reaches YouTube', async () => {
    const sources = changingSources(TIERS.free)
    const { player, requests } = setup({
      services: { sources, recommendations: fakeRecommendations() },
    })
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(requests).toEqual([])

    sources.reach(TIERS.lite)
    await settle()
    expect(requests).toHaveLength(1)
  })

  it('starts once the recommendation sources are wired in, and follows the new services', async () => {
    const before = changingSources(TIERS.full)
    const { player, store, requests } = setup({ services: { sources: before } })
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(requests).toEqual([])
    expect(before.listeners).toBe(1)

    const after = changingSources(TIERS.full)
    store.set({ sources: after, recommendations: fakeRecommendations() })
    await settle()
    expect(requests).toHaveLength(1)
    expect(before.listeners).toBe(0)
    expect(after.listeners).toBe(1)
  })

  it('refills a queue the user emptied of its songs', async () => {
    const { player, requests } = setup()
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    player.clearUpcoming()
    await settle()
    expect(requests).toHaveLength(2)
    expect(upcoming(player.getState().queue)).toEqual(['radio 5', 'radio 6', 'radio 7', 'radio 8'])
    // What the user cleared doesn't come again.
    expect(new Set(requests[1]?.exclude).has(entityKey(testTrack('radio 1').id))).toBe(true)
  })

  it('reports a plan that failed, and tries that queue again only once it changes', async () => {
    const { player, requests, errors, answer } = setup()
    const failure = new Error('Library blocked')
    answer(async () => {
      throw failure
    })
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    expect(errors).toEqual([failure])
    await settle(5 * AUTOPLAY_SETTLE_MS)
    expect(requests).toHaveLength(1)
    player.addToQueue([testTrack('b')])
    await settle()
    expect(requests).toHaveLength(2)
  })

  it('stops when disconnected, dropping a plan on its way', async () => {
    const { player, requests, answer, disconnect } = setup()
    const late = deferred<Extension>()
    answer(() => late.promise)
    await player.setQueue(testTracks('a'), { startIndex: 0 })
    await settle()
    disconnect()
    expect(requests[0]?.signal?.aborted).toBe(true)
    late.resolve({ picks: [pickOf(testTrack('stale'), testTrack('a'))] })
    await settle()
    await player.next()
    player.addToQueue([testTrack('b')])
    await settle()
    expect(requests).toHaveLength(1)
    expect(queueTitles(player)).toEqual(['a', 'b'])
  })
})
