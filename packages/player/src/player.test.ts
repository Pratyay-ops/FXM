import {
  type AudioCandidate,
  createSeededRandom,
  currentQueueItem,
  formatId,
  type QueueItem,
  restoreQueue,
} from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Engine } from './engine'
import {
  PLAYER_DEFAULTS,
  Player,
  type PlayerEventMap,
  type PlayerOptions,
  type PlayerState,
} from './player'
import type { ResolvedStream } from './resolver'
import { FakeEngine, FakeResolver, testStream, testTrack, testTracks } from './testing'

function setup(options: Partial<PlayerOptions> = {}) {
  const engine = new FakeEngine()
  const resolver = new FakeResolver()
  const player = new Player({ engine, resolver, random: createSeededRandom(1), ...options })
  return { engine, resolver, player }
}

/** Lets pending promise chains and due timers run. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Records every `trackchange` as `<previous> -> <item> (<cause>)`. */
function trackChanges(player: Player): string[] {
  const changes: string[] = []
  player.on('trackchange', ({ item, previous, cause }) => {
    changes.push(`${previous?.track.title} -> ${item?.track.title} (${cause})`)
  })
  return changes
}

/** Records every `seek` as `<position> <cause>`. */
function seeks(player: Player): string[] {
  const seen: string[] = []
  player.on('seek', ({ positionMs, cause }) => seen.push(`${positionMs} ${cause}`))
  return seen
}

const current = (player: Player) => currentQueueItem(player.getState().queue)?.track.title
const titles = (player: Player) => player.getState().queue.items.map((item) => item.track.title)
const url = (name: string) => `https://media.test/${name}`
const abc = testTracks('a', 'b', 'c')

function song(ref: string): AudioCandidate {
  return {
    source: 'ytm',
    ref,
    kind: 'song',
    title: ref,
    artists: ['Artist'],
    confidence: 0.93,
    evidence: ['isrc'],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Player: starting playback', () => {
  it('starts idle and applies the volume and mute settings to the engine', () => {
    const { player, engine } = setup({ volume: 0.4, muted: true })
    expect(player.getState()).toMatchObject({
      status: 'idle',
      buffering: false,
      positionMs: 0,
      durationMs: undefined,
      volume: 0.4,
      muted: true,
      stream: undefined,
      error: undefined,
    })
    expect(engine.volume).toBe(0.4)
    expect(engine.muted).toBe(true)
  })

  it('takes the initial queue settings', () => {
    const { player } = setup({ queue: { mode: 'all', repeat: 'all', shuffle: true } })
    expect(player.getState().queue).toMatchObject({ mode: 'all', repeat: 'all', shuffle: true })
  })

  it('plays the start track of a new queue', async () => {
    const { player, engine, resolver } = setup()
    const changes = trackChanges(player)
    const context = { type: 'album', id: formatId('ytm', 'album', 'MPREb_x'), title: 'X' } as const
    await player.setQueue(abc, { startIndex: 1, context })
    expect(current(player)).toBe('b')
    expect(changes).toEqual(['undefined -> b (queue)'])
    expect(resolver.requests).toHaveLength(1)
    expect(resolver.requests[0]?.request).toMatchObject({ reason: 'play', attempt: 0 })
    expect(resolver.requests[0]?.request).not.toHaveProperty('failure')
    expect(engine.loadedUrls).toEqual([url('b')])
    expect(engine.calls.at(-1)?.method).toBe('play')
    expect(player.getState()).toMatchObject({
      status: 'playing',
      buffering: false,
      positionMs: 0,
      durationMs: 180_000,
      stream: testStream('b'),
    })
    expect(player.getState().queue.context).toEqual(context)
  })

  it('hands the engine the queue item with the stream', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    expect(engine.source?.item?.track.title).toBe('a')
  })

  it('selects the start track without playing it when autoplay is off', async () => {
    const { player, resolver } = setup()
    await player.setQueue(abc, { startIndex: 2, autoplay: false, startAtMs: 30_000 })
    expect(current(player)).toBe('c')
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 30_000 })
    expect(resolver.requests).toHaveLength(0)
  })

  it('starts the first track at the given position', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, { startAtMs: 42_000 })
    expect(engine.loadStarts).toEqual([42_000])
    expect(player.getState().positionMs).toBe(42_000)
  })

  it('shuffles a new queue from a random track, with the injected randomness', async () => {
    const starts = new Set<string | undefined>()
    for (let seed = 0; seed < 30; seed += 1) {
      const { player } = setup({ random: createSeededRandom(seed) })
      await player.setQueue(testTracks('a', 'b', 'c', 'd'), { shuffle: true })
      expect(player.getState().queue.shuffle).toBe(true)
      starts.add(current(player))
    }
    expect([...starts].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('turns shuffle off for a new queue when asked', async () => {
    const { player } = setup({ queue: { shuffle: true } })
    await player.setQueue(abc, { shuffle: false })
    expect(player.getState().queue.shuffle).toBe(false)
    expect(titles(player)).toEqual(['a', 'b', 'c'])
  })

  it('stays idle when the mode hides every track', async () => {
    const { player, resolver, engine } = setup()
    await player.setQueue([testTrack('v', { kind: 'video' })])
    expect(player.getState()).toMatchObject({ status: 'idle' })
    expect(player.getState().queue.items).toEqual([])
    expect(resolver.requests).toHaveLength(0)
    expect(engine.count('unlock')).toBe(0)
  })

  it('records the candidate the resolver chose on the queue item', async () => {
    const { player, resolver } = setup()
    resolver.handler = () => ({ stream: testStream('song'), candidate: song('song-id') })
    await player.setQueue([testTrack('m', { kind: 'music-video' })])
    expect(currentQueueItem(player.getState().queue)?.candidate).toEqual(song('song-id'))
    expect(player.getState().status).toBe('playing')
  })

  it('tells the resolver what the engine can play', async () => {
    const { player, engine, resolver } = setup()
    engine.canPlayStream = (stream) => (stream.codec === 'opus' ? 'maybe' : 'probably')
    await player.setQueue(abc)
    const { canPlay } = resolver.requests[0]?.request ?? {}
    expect(canPlay?.(testStream('x'))).toBe('maybe')
    expect(canPlay?.(testStream('x', { codec: 'aac', container: 'm4a' }))).toBe('probably')
    expect(canPlay?.(testStream('x', { fullLength: 'capped' }))).toBe('no')
  })

  it('works with an engine that has none of the optional methods', async () => {
    const fake = new FakeEngine()
    const engine: Engine = {
      load: (source, startAtMs) => fake.load(source, startAtMs),
      play: () => fake.play(),
      pause: () => fake.pause(),
      seek: (positionMs) => fake.seek(positionMs),
      setVolume: (volume) => fake.setVolume(volume),
      setMuted: (muted) => fake.setMuted(muted),
      on: (type, listener) => fake.on(type, listener),
      destroy: () => fake.destroy(),
    }
    const resolver = new FakeResolver()
    const player = new Player({ engine, resolver })
    await player.setQueue(abc)
    expect(resolver.requests[0]?.request.canPlay(testStream('x'))).toBe('maybe')
    expect(player.getState().status).toBe('playing')
    fake.progress(170_000)
    await settle()
    expect(resolver.requestsFor('b')).toHaveLength(1)
    await player.next()
    player.destroy()
    expect(fake.loadedUrls).toEqual([url('a'), url('b')])
    expect(fake.destroyed).toBe(true)
  })

  it('follows the position and duration the engine reports', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    engine.progress(12_345)
    engine.emit('durationchange', 200_000)
    expect(player.getState()).toMatchObject({ positionMs: 12_345, durationMs: 200_000 })
    engine.emit('durationchange', Number.NaN)
    engine.emit('durationchange', 0)
    engine.emit('timeupdate', Number.POSITIVE_INFINITY)
    expect(player.getState()).toMatchObject({ positionMs: 12_345, durationMs: 200_000 })
  })

  it('ignores positions a load reports before it plays', async () => {
    const { player, engine } = setup()
    engine.startOnPlay = false
    await player.setQueue(abc, { startAtMs: 42_000 })
    engine.progress(0)
    expect(player.getState().positionMs).toBe(42_000)
    engine.emit('play', undefined)
    engine.progress(42_250)
    expect(player.getState().positionMs).toBe(42_250)
  })

  it('ignores engine events while nothing is loaded', () => {
    const { player, engine } = setup()
    engine.emit('play', undefined)
    engine.emit('timeupdate', 5000)
    engine.emit('ended', undefined)
    engine.fail('network')
    engine.emit('waiting', undefined)
    expect(player.getState()).toMatchObject({ status: 'idle', positionMs: 0, buffering: false })
  })
})

describe('Player: user gestures', () => {
  it('unlocks the engine before it waits for the resolver', async () => {
    const { player, engine, resolver } = setup()
    const unlocksAtResolve: number[] = []
    resolver.handler = (item) => {
      unlocksAtResolve.push(engine.count('unlock'))
      return { stream: testStream(item.track.title) }
    }
    await player.setQueue(abc)
    player.pause()
    await player.play()
    await player.next()
    await player.previous()
    await player.play(2)
    expect(unlocksAtResolve).toEqual([1, 3, 4, 5])
    expect(engine.count('unlock')).toBe(5)
  })

  it('does not unlock for a queue it does not play', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, { autoplay: false })
    await player.play(9)
    expect(engine.count('unlock')).toBe(0)
  })
})

describe('Player: editing the queue', () => {
  it('adds tracks without interrupting playback', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.playNext(testTracks('x'))
    player.addToQueue(testTracks('y'))
    expect(titles(player)).toEqual(['a', 'x', 'b', 'c', 'y'])
    expect(engine.count('load')).toBe(1)
    expect(player.getState().status).toBe('playing')
  })

  it('selects the first track added to an empty queue without playing it', async () => {
    const { player, engine, resolver } = setup()
    const changes = trackChanges(player)
    player.addToQueue(abc)
    expect(current(player)).toBe('a')
    expect(changes).toEqual(['undefined -> a (queue)'])
    expect(player.getState().status).toBe('paused')
    expect(resolver.requests).toHaveLength(0)
    await player.play()
    expect(engine.loadedUrls).toEqual([url('a')])
    expect(player.getState().status).toBe('playing')
  })

  it('plays the following track when the playing one is removed', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    const changes = trackChanges(player)
    player.remove(0)
    await settle()
    expect(current(player)).toBe('b')
    expect(changes).toEqual(['a -> b (removed)'])
    expect(engine.loadedUrls).toEqual([url('a'), url('b')])
    expect(player.getState().status).toBe('playing')
  })

  it('selects the following track without loading it when the paused one is removed', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.pause()
    player.remove(0)
    await settle()
    expect(current(player)).toBe('b')
    expect(player.getState()).toMatchObject({ status: 'paused', stream: undefined })
    expect(engine.loadedUrls).toEqual([url('a')])
  })

  it('goes idle when the last item is removed', async () => {
    const { player, engine } = setup()
    await player.setQueue(testTracks('a'))
    player.remove(0)
    expect(player.getState()).toMatchObject({ status: 'idle', stream: undefined })
    expect(engine.paused).toBe(true)
  })

  it('moves and clears items without reloading the playing one', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.move(2, 0)
    expect(titles(player)).toEqual(['c', 'a', 'b'])
    expect(current(player)).toBe('a')
    player.clearUpcoming()
    expect(titles(player)).toEqual(['c', 'a'])
    expect(engine.count('load')).toBe(1)
  })

  it('does not notify for edits that change nothing', async () => {
    const { player } = setup()
    await player.setQueue(abc)
    const listener = vi.fn()
    player.subscribe(listener)
    player.remove(7)
    player.move(0, 0)
    player.setRepeat('off')
    player.setShuffle(false)
    player.setCatalogMode('music')
    player.setCandidate(42, song('x'))
    expect(listener).not.toHaveBeenCalled()
  })

  it('applies a mode switch but keeps the playing video', async () => {
    const { player, engine } = setup({ queue: { mode: 'all' } })
    const tracks = [
      testTrack('v', { kind: 'video' }),
      testTrack('w', { kind: 'video' }),
      testTrack('s'),
    ]
    await player.setQueue(tracks)
    player.setCatalogMode('music')
    expect(titles(player)).toEqual(['v', 's'])
    expect(player.getState().status).toBe('playing')
    await player.next()
    expect(titles(player)).toEqual(['s'])
    expect(engine.loadedUrls).toEqual([url('v'), url('s')])
  })
})

describe('Player: restoring a saved queue', () => {
  it('restores a saved queue paused at the saved position', async () => {
    const { player: before } = setup()
    await before.setQueue(abc, { startIndex: 1 })
    const saved = JSON.parse(JSON.stringify(before.getState().queue)) as unknown
    const { player, engine } = setup()
    expect(player.restore(saved, 42_000)).toBe(true)
    expect(current(player)).toBe('b')
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 42_000 })
    await player.play()
    expect(engine.loadStarts).toEqual([42_000])
  })

  it("restores an empty queue as idle, in the player's mode", async () => {
    const { player } = setup({ queue: { mode: 'all' } })
    await player.setQueue(abc)
    expect(player.restore({ items: [] }, 99)).toBe(true)
    expect(player.getState()).toMatchObject({ status: 'idle', positionMs: 0 })
    expect(player.getState().queue.mode).toBe('all')
  })

  it('refuses what is not a queue and changes nothing', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    expect(player.restore('not a queue')).toBe(false)
    expect(player.getState().status).toBe('playing')
    expect(engine.count('pause')).toBe(0)
  })

  it("drops a saved current item the player's mode hides", async () => {
    const { player: before } = setup({ queue: { mode: 'all' } })
    await before.setQueue([testTrack('v', { kind: 'video' }), testTrack('a')])
    const saved = before.getState().queue
    const { player, resolver } = setup()
    player.restore(saved)
    expect(titles(player)).toEqual(['a'])
    expect(current(player)).toBe('a')
    await player.play()
    expect(resolver.log).toEqual(['a:play#0'])
  })

  it('announces the restored item even when its uid matches the old one', async () => {
    const { player: before } = setup()
    await before.setQueue(testTracks('x'))
    const saved = before.getState().queue
    const { player, engine } = setup()
    await player.setQueue(testTracks('a'))
    expect(currentQueueItem(player.getState().queue)?.uid).toBe(currentQueueItem(saved)?.uid)
    const changes = trackChanges(player)
    player.restore(saved)
    expect(changes).toEqual(['a -> x (restore)'])
    expect(player.getState()).toMatchObject({ status: 'paused', stream: undefined })
    expect(engine.paused).toBe(true)
  })

  it('starts the failure counts over for the restored queue', async () => {
    const { player: before } = setup()
    await before.setQueue(testTracks('x'))
    const saved = before.getState().queue
    const { player, engine, resolver } = setup({ retryDelaysMs: [0] })
    await player.setQueue(testTracks('a'))
    engine.fail('network')
    engine.fail('network')
    player.restore(saved)
    await player.play()
    expect(resolver.log.at(-1)).toBe('x:play#0')
  })
})

describe('Player: transport', () => {
  it('pauses and resumes without reloading', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.pause()
    expect(player.getState().status).toBe('paused')
    expect(engine.paused).toBe(true)
    await player.play()
    expect(player.getState().status).toBe('playing')
    expect(engine.count('load')).toBe(1)
  })

  it('toggles between playing and paused', async () => {
    const { player } = setup()
    await player.setQueue(abc)
    await player.toggle()
    expect(player.getState().status).toBe('paused')
    await player.toggle()
    expect(player.getState().status).toBe('playing')
  })

  it('loads a track paused when the user pauses while it resolves', async () => {
    const { player, engine, resolver } = setup()
    const gate = deferred<ResolvedStream>()
    resolver.handler = () => gate.promise
    const starting = player.setQueue(abc)
    expect(player.getState()).toMatchObject({ status: 'loading', buffering: true })
    player.pause()
    gate.resolve({ stream: testStream('a') })
    await starting
    expect(engine.count('load')).toBe(1)
    expect(engine.count('play')).toBe(0)
    expect(player.getState()).toMatchObject({ status: 'paused', buffering: false })
  })

  it('pauses a track that is loaded but not yet playing', async () => {
    const { player, engine } = setup()
    engine.startOnPlay = false
    await player.setQueue(abc)
    expect(player.getState().status).toBe('loading')
    player.pause()
    expect(engine.count('pause')).toBe(1)
    expect(player.getState().status).toBe('paused')
  })

  it('jumps to an item and plays it from the start', async () => {
    const { player, engine } = setup()
    const changes = trackChanges(player)
    await player.setQueue(abc)
    engine.progress(30_000)
    await player.play(2)
    expect(current(player)).toBe('c')
    expect(changes.at(-1)).toBe('a -> c (jump)')
    expect(engine.loadedUrls).toEqual([url('a'), url('c')])
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 0 })
  })

  it('ignores an invalid index and resumes for the current one', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.pause()
    await player.play(9)
    expect(player.getState().status).toBe('paused')
    await player.play(0)
    expect(player.getState().status).toBe('playing')
    expect(engine.count('load')).toBe(1)
  })

  it('does nothing when asked to play while playing or with an empty queue', async () => {
    const { player, engine } = setup()
    await player.play()
    expect(engine.calls).toEqual([
      { method: 'setVolume', args: [1] },
      { method: 'setMuted', args: [false] },
    ])
    await player.setQueue(abc)
    const plays = engine.count('play')
    await player.play()
    expect(engine.count('play')).toBe(plays)
  })

  it('seeks within the track, clamped to it', async () => {
    const { player, engine } = setup()
    const seen = seeks(player)
    await player.setQueue(abc)
    player.seek(60_000)
    player.seek(-5)
    player.seek(10_000_000)
    player.seek(Number.NaN)
    player.seekBy(-30_000)
    expect(seen).toEqual(['60000 user', '0 user', '180000 user', '150000 user'])
    expect(
      engine.calls.filter((call) => call.method === 'seek').map((call) => call.args[0]),
    ).toEqual([60_000, 0, 180_000, 150_000])
    expect(player.getState().positionMs).toBe(150_000)
  })

  it('starts a track that is not loaded yet where it was seeked to', async () => {
    const { player, engine } = setup()
    player.addToQueue(abc)
    player.seek(30_000)
    expect(engine.count('seek')).toBe(0)
    await player.play()
    expect(engine.loadStarts).toEqual([30_000])
  })

  it('ignores seeks with nothing queued', () => {
    const { player, engine } = setup()
    player.seek(1000)
    player.stop()
    expect(engine.count('seek')).toBe(0)
    expect(player.getState().positionMs).toBe(0)
  })

  it('stops by pausing and rewinding', async () => {
    const { player, engine } = setup()
    const seen = seeks(player)
    await player.setQueue(abc)
    engine.progress(90_000)
    player.stop()
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 0 })
    expect(seen).toEqual(['0 user'])
    expect(engine.paused).toBe(true)
  })

  it('clamps the volume and sets mute', () => {
    const { player, engine } = setup()
    player.setVolume(2)
    expect(player.getState().volume).toBe(1)
    player.setVolume(-1)
    expect(engine.volume).toBe(0)
    player.setVolume(Number.NaN)
    expect(player.getState().volume).toBe(0)
    player.setMuted(true)
    expect(player.getState().muted).toBe(true)
    expect(engine.muted).toBe(true)
  })
})

describe('Player: next and previous', () => {
  it('skips to the next track and keeps playing', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    const changes = trackChanges(player)
    await player.next()
    expect(current(player)).toBe('b')
    expect(changes).toEqual(['a -> b (next)'])
    expect(engine.loadedUrls).toEqual([url('a'), url('b')])
    expect(player.getState().status).toBe('playing')
  })

  it('skips while paused without loading anything', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc)
    player.pause()
    await player.next()
    expect(current(player)).toBe('b')
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 0, stream: undefined })
    expect(resolver.requests).toHaveLength(1)
    await player.play()
    expect(engine.loadedUrls).toEqual([url('a'), url('b')])
  })

  it('does nothing at the end of the queue with repeat off', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, { startIndex: 2 })
    await player.next()
    expect(current(player)).toBe('c')
    expect(engine.count('load')).toBe(1)
  })

  it('goes back early in a track', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, { startIndex: 1 })
    const changes = trackChanges(player)
    engine.progress(2000)
    await player.previous()
    expect(current(player)).toBe('a')
    expect(changes).toEqual(['b -> a (previous)'])
    expect(engine.loadedUrls).toEqual([url('b'), url('a')])
  })

  it('restarts the track more than 3 s in', async () => {
    const { player, engine } = setup()
    const seen = seeks(player)
    await player.setQueue(abc, { startIndex: 1 })
    engine.progress(5000)
    await player.previous()
    expect(current(player)).toBe('b')
    expect(seen).toEqual(['0 restart'])
    expect(engine.calls.at(-2)).toEqual({ method: 'seek', args: [0] })
    expect(engine.calls.at(-1)?.method).toBe('play')
    expect(player.getState()).toMatchObject({ positionMs: 0, status: 'playing' })
    expect(engine.count('load')).toBe(1)
  })

  it('restarts the first track, and a paused track stays paused', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.pause()
    engine.progress(1000)
    await player.previous()
    expect(current(player)).toBe('a')
    expect(player.getState()).toMatchObject({ positionMs: 0, status: 'paused' })
  })

  it('goes back while paused without loading anything', async () => {
    const { player, resolver } = setup()
    await player.setQueue(abc, { startIndex: 2 })
    player.pause()
    await player.previous()
    expect(current(player)).toBe('b')
    expect(player.getState().status).toBe('paused')
    expect(resolver.requests).toHaveLength(1)
  })

  it('wraps around with repeat all', async () => {
    const { player } = setup({ queue: { repeat: 'all' } })
    await player.setQueue(abc, { startIndex: 2 })
    await player.next()
    expect(current(player)).toBe('a')
    await player.previous()
    expect(current(player)).toBe('c')
  })

  it('does nothing with an empty queue', async () => {
    const { player, engine } = setup()
    await player.next()
    await player.previous()
    expect(engine.count('load')).toBe(0)
  })
})

describe('Player: auto-advance, repeat and shuffle', () => {
  it('plays the next track when one ends', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    const changes = trackChanges(player)
    engine.end()
    await settle()
    expect(current(player)).toBe('b')
    expect(changes).toEqual(['a -> b (ended)'])
    expect(engine.loadedUrls).toEqual([url('a'), url('b')])
    expect(player.getState().status).toBe('playing')
  })

  it('ends after the last track when repeat is off', async () => {
    const { player, engine } = setup()
    const queueEnd = vi.fn()
    player.on('queueend', queueEnd)
    await player.setQueue(abc, { startIndex: 2 })
    engine.emit('durationchange', 181_000)
    engine.end()
    await settle()
    expect(queueEnd).toHaveBeenCalledOnce()
    expect(player.getState()).toMatchObject({ status: 'ended', positionMs: 181_000 })
    expect(engine.count('load')).toBe(1)
  })

  it('plays the last track again when asked to play after the end', async () => {
    const { player, engine, resolver } = setup()
    const seen = seeks(player)
    await player.setQueue(abc, { startIndex: 2 })
    engine.end()
    await player.play()
    expect(current(player)).toBe('c')
    expect(seen).toEqual(['0 restart'])
    expect(engine.calls.at(-2)).toEqual({ method: 'seek', args: [0] })
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 0 })
    expect(resolver.requests).toHaveLength(1)
  })

  it('plays what was added after the end', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, { startIndex: 2 })
    const changes = trackChanges(player)
    engine.end()
    player.addToQueue(testTracks('d'))
    await player.play()
    expect(current(player)).toBe('d')
    expect(changes).toEqual(['c -> d (next)'])
    expect(engine.loadedUrls.at(-1)).toBe(url('d'))
  })

  it('rewinds an ended track paused when it is seeked or restarted while paused', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, { startIndex: 2 })
    engine.end()
    player.seek(10_000)
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 10_000 })
    engine.end()
    player.stop()
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 0 })
  })

  it('starts over after the last track with repeat all', async () => {
    const { player, engine } = setup({ queue: { repeat: 'all' } })
    await player.setQueue(abc, { startIndex: 2 })
    engine.end()
    await settle()
    expect(current(player)).toBe('a')
    expect(player.getState().status).toBe('playing')
  })

  it('replays the track with repeat one, without resolving it again', async () => {
    const { player, engine, resolver } = setup({ queue: { repeat: 'one' } })
    const seen = seeks(player)
    const changes = trackChanges(player)
    await player.setQueue(abc)
    engine.progress(179_000)
    engine.end()
    await settle()
    expect(current(player)).toBe('a')
    expect(seen).toEqual(['0 repeat'])
    expect(changes).toEqual(['undefined -> a (queue)'])
    expect(engine.calls.slice(-2)).toEqual([
      { method: 'seek', args: [0] },
      { method: 'play', args: [] },
    ])
    expect(resolver.requests).toHaveLength(1)
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 0 })
  })

  it('still skips to the next track with repeat one', async () => {
    const { player } = setup({ queue: { repeat: 'one' } })
    await player.setQueue(abc, { startIndex: 2 })
    await player.next()
    expect(current(player)).toBe('a')
  })

  it('replays the only track of a repeat-all queue', async () => {
    const { player, engine } = setup({ queue: { repeat: 'all' } })
    const seen = seeks(player)
    await player.setQueue(testTracks('a'))
    engine.end()
    await settle()
    expect(current(player)).toBe('a')
    expect(engine.count('load')).toBe(1)
    expect(engine.calls.at(-1)?.method).toBe('play')
    await player.next()
    expect(engine.count('load')).toBe(1)
    expect(player.getState().positionMs).toBe(0)
    expect(seen).toEqual(['0 repeat', '0 restart'])
  })

  it('keeps playing the current track when shuffle turns on', async () => {
    const { player, engine } = setup()
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e', 'f'), { startIndex: 2 })
    player.setShuffle(true)
    const { queue } = player.getState()
    expect(queue.shuffle).toBe(true)
    expect(current(player)).toBe('c')
    expect(queue.index).toBe(0)
    expect(titles(player)).not.toEqual(['c', 'a', 'b', 'd', 'e', 'f'])
    expect(engine.count('load')).toBe(1)
  })

  it('plays in the shuffled order, goes back to what played and unshuffles', async () => {
    const { player, engine } = setup()
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e', 'f'))
    player.setShuffle(true)
    const order = titles(player)
    await player.next()
    engine.end()
    await settle()
    expect(current(player)).toBe(order[2])
    expect(engine.loadedUrls).toEqual(order.slice(0, 3).map(url))
    await player.previous()
    expect(current(player)).toBe(order[1])
    player.setShuffle(false)
    expect(titles(player)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(current(player)).toBe(order[1])
  })

  it('goes back to the track that was playing after a jump while shuffled', async () => {
    const { player } = setup()
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e', 'f'))
    player.setShuffle(true)
    const [first, , , , fifth] = titles(player)
    await player.play(4)
    expect(current(player)).toBe(fifth)
    await player.previous()
    expect(current(player)).toBe(first)
  })

  it('shuffles a new queue, starting with the chosen track', async () => {
    const { player } = setup({ queue: { shuffle: true } })
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e'), { startIndex: 3 })
    expect(current(player)).toBe('d')
    expect(player.getState().queue.index).toBe(0)
    expect([...titles(player)].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('sets the repeat mode', () => {
    const { player } = setup()
    player.setRepeat('one')
    expect(player.getState().queue.repeat).toBe('one')
  })
})

describe('Player: preloading the next track', () => {
  /** Records every `preload` event as `<next>: <upcoming…>`. */
  function preloads(player: Player): string[] {
    const seen: string[] = []
    const name = (item: QueueItem) => item.track.title
    player.on('preload', ({ next, upcoming }: PlayerEventMap['preload']) => {
      seen.push(`${name(next)}: ${upcoming.map(name).join(' ')}`)
    })
    return seen
  }

  it('prepares the next track 30 s before the end of the current one', async () => {
    const { player, engine, resolver } = setup()
    const announced = preloads(player)
    await player.setQueue(abc)
    engine.progress(149_000)
    expect(resolver.requestsFor('b')).toHaveLength(0)
    expect(announced).toEqual([])
    engine.progress(150_000)
    await settle()
    expect(resolver.requestsFor('b')).toEqual([
      expect.objectContaining({ reason: 'preload', attempt: 0 }),
    ])
    expect(engine.preloaded?.stream.url).toBe(url('b'))
    expect(engine.preloaded?.item?.track.title).toBe('b')
    expect(announced).toEqual(['b: b c'])
    engine.progress(170_000)
    await settle()
    expect(resolver.requestsFor('b')).toHaveLength(1)
    expect(announced).toHaveLength(1)
  })

  it('announces the next track without resolving it when preloading is off', async () => {
    const { player, engine, resolver } = setup({ preload: false })
    const announced = preloads(player)
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    expect(announced).toEqual(['b: b c'])
    expect(resolver.requestsFor('b')).toHaveLength(0)
    expect(engine.count('preload')).toBe(0)
  })

  it('announces the first item again at the end of a repeat-all queue', async () => {
    const { player, engine } = setup({ queue: { repeat: 'all' } })
    const announced = preloads(player)
    await player.setQueue(abc, { startIndex: 2 })
    engine.progress(170_000)
    expect(announced).toEqual(['a: '])
  })

  it('announces again when the next track changes', async () => {
    const { player, engine } = setup()
    const announced = preloads(player)
    await player.setQueue(abc)
    engine.progress(170_000)
    player.playNext(testTracks('x'))
    engine.progress(171_000)
    expect(announced).toEqual(['b: b c', 'x: x b c'])
  })

  it('plays the prepared stream without resolving it again', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    engine.end()
    await settle()
    expect(current(player)).toBe('b')
    expect(engine.loadedUrls).toEqual([url('a'), url('b')])
    expect(resolver.requestsFor('b')).toHaveLength(1)
  })

  it('shares a preparation still in flight with the load', async () => {
    const { player, engine, resolver } = setup()
    const gate = deferred<ResolvedStream>()
    await player.setQueue(abc)
    resolver.handler = () => gate.promise
    engine.progress(170_000)
    engine.end()
    await settle()
    expect(player.getState().status).toBe('loading')
    gate.resolve({ stream: testStream('b') })
    await settle()
    expect(resolver.requestsFor('b')).toHaveLength(1)
    expect(engine.loadedUrls).toEqual([url('a'), url('b')])
  })

  it('aborts a preparation taken over by a load when the user skips on', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc)
    resolver.handler = () => new Promise(() => {})
    engine.progress(170_000)
    engine.end()
    await settle()
    const preload = resolver.requestsFor('b')[0]
    expect(preload?.signal.aborted).toBe(false)
    void player.next()
    await settle()
    expect(preload?.signal.aborted).toBe(true)
  })

  it('uses the duration the engine reports', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc)
    engine.emit('durationchange', 60_000)
    engine.progress(30_000)
    await settle()
    expect(resolver.requestsFor('b')).toHaveLength(1)
  })

  it('prepares a short track as soon as its duration is known', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue([testTrack('a', { durationMs: 20_000 }), testTrack('b')])
    engine.emit('durationchange', 20_000)
    await settle()
    expect(resolver.requestsFor('b')).toHaveLength(1)
  })

  it('does not prepare without a known duration', async () => {
    const { player, engine, resolver } = setup()
    const { durationMs: _unknown, ...noDuration } = testTrack('a')
    await player.setQueue([noDuration, testTrack('b')])
    engine.progress(10_000_000)
    await settle()
    expect(resolver.requestsFor('b')).toHaveLength(0)
  })

  it.each([
    ['repeat one', { queue: { repeat: 'one' } }, abc],
    ['nothing next', {}, testTracks('a')],
    ['the only track next again', { queue: { repeat: 'all' } }, testTracks('a')],
  ] as const)('does not prepare or announce with %s', async (_name, options, tracks) => {
    const { player, engine, resolver } = setup(options)
    const announced = preloads(player)
    await player.setQueue(tracks)
    engine.progress(179_000)
    await settle()
    expect(resolver.requests).toHaveLength(1)
    expect(engine.count('preload')).toBe(0)
    expect(announced).toEqual([])
  })

  it('drops the preparation when the next track changes', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    const preload = resolver.requestsFor('b')[0]
    player.addToQueue(testTracks('d'))
    expect(preload?.signal.aborted).toBe(false)
    player.playNext(testTracks('x'))
    expect(preload?.signal.aborted).toBe(true)
    expect(engine.preloaded).toBeNull()
    engine.progress(171_000)
    await settle()
    expect(resolver.requestsFor('x')).toEqual([expect.objectContaining({ reason: 'preload' })])
  })

  it('resolves again when the preparation failed', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc)
    resolver.handler = (item, request) => {
      if (request.reason === 'preload') throw new Error('offline')
      return { stream: testStream(item.track.title) }
    }
    engine.progress(170_000)
    await settle()
    expect(engine.count('preload')).toBe(0)
    engine.end()
    await settle()
    expect(resolver.requestsFor('b').map((request) => request.reason)).toEqual(['preload', 'play'])
    expect(engine.loadedUrls.at(-1)).toBe(url('b'))
  })

  it('resolves again when the prepared stream is about to expire', async () => {
    let now = 1_000_000
    const { player, engine, resolver } = setup({ now: () => now })
    resolver.handler = (item, request) => ({
      stream: testStream(`${item.track.title}-${request.reason}`, {
        expiresAt: now + 60 * 60_000,
      }),
    })
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    now += 55 * 60_000
    engine.end()
    await settle()
    expect(resolver.requestsFor('b').map((request) => request.reason)).toEqual(['preload', 'play'])
    expect(engine.loadedUrls.at(-1)).toBe(url('b-play'))
  })

  it('does not hand the engine a stream it cannot play or a capped one', async () => {
    const { player, engine, resolver } = setup()
    engine.canPlayStream = (stream) => (stream.url === url('b') ? 'no' : 'maybe')
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    expect(engine.count('preload')).toBe(0)
    resolver.handler = (item) => ({
      stream: testStream(`${item.track.title}2`, { fullLength: 'capped' }),
    })
    player.playNext(testTracks('x'))
    engine.progress(171_000)
    await settle()
    expect(resolver.requestsFor('x')).toHaveLength(1)
    expect(engine.preloaded).toBeNull()
  })

  it('keeps working when a preload listener throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { player, engine } = setup()
    player.on('preload', () => {
      throw new Error('listener bug')
    })
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    expect(error).toHaveBeenCalledOnce()
    expect(engine.preloaded?.stream.url).toBe(url('b'))
  })
})

describe('Player: choosing another version', () => {
  it('resolves the new candidate for the playing item and carries on where it was', async () => {
    const { player, engine, resolver } = setup()
    resolver.handler = (item) => ({
      stream: testStream(item.candidate?.ref ?? item.track.title),
    })
    await player.setQueue(abc)
    engine.progress(42_000)
    const uid = currentQueueItem(player.getState().queue)?.uid ?? -1
    player.setCandidate(uid, song('other'))
    await settle()
    expect(resolver.log).toEqual(['a:play#0', 'a:replace#0'])
    expect(resolver.requests.at(-1)?.item.candidate).toEqual(song('other'))
    expect(engine.loadedUrls).toEqual([url('a'), url('other')])
    expect(engine.loadStarts).toEqual([0, 42_000])
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 42_000 })
    expect(currentQueueItem(player.getState().queue)?.candidate).toEqual(song('other'))
  })

  it('reloads a paused item paused', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc)
    engine.progress(10_000)
    player.pause()
    const plays = engine.count('play')
    player.setCandidate(currentQueueItem(player.getState().queue)?.uid ?? -1, song('other'))
    await settle()
    expect(resolver.log.at(-1)).toBe('a:replace#0')
    expect(engine.count('play')).toBe(plays)
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 10_000 })
  })

  it('reloads an ended item from the start', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, { startIndex: 2 })
    engine.end()
    player.setCandidate(currentQueueItem(player.getState().queue)?.uid ?? -1, song('other'))
    await settle()
    expect(engine.loadStarts.at(-1)).toBe(0)
    expect(player.getState().status).toBe('paused')
  })

  it('only records the candidate for an item that is not loaded', async () => {
    const { player, resolver } = setup()
    player.addToQueue(abc)
    const [first, second] = player.getState().queue.items
    player.setCandidate(second?.uid ?? -1, song('b2'))
    player.setCandidate(first?.uid ?? -1, song('a2'))
    await settle()
    expect(resolver.requests).toHaveLength(0)
    expect(player.getState().queue.items.map((item) => item.candidate?.ref)).toEqual([
      'a2',
      'b2',
      undefined,
    ])
    player.setCandidate(second?.uid ?? -1)
    expect(player.getState().queue.items[1]).not.toHaveProperty('candidate')
  })

  it('prepares the next item again after its candidate changed', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    const next = player.getState().queue.items[1]
    const first = resolver.requestsFor('b')[0]
    player.setCandidate(next?.uid ?? -1, song('b2'))
    expect(first?.signal.aborted).toBe(true)
    engine.progress(171_000)
    await settle()
    expect(resolver.requestsFor('b')).toHaveLength(2)
    expect(resolver.requests.at(-1)?.item.candidate).toEqual(song('b2'))
  })

  it('ignores a candidate the mode does not let play', async () => {
    const { player, resolver } = setup()
    await player.setQueue(abc)
    const uid = currentQueueItem(player.getState().queue)?.uid ?? -1
    player.setCandidate(uid, { ...song('v'), kind: 'video' })
    await settle()
    expect(resolver.requests).toHaveLength(1)
  })
})

describe('Player: overlapping requests', () => {
  it('plays only the last of several quick skips', async () => {
    const { player, engine, resolver } = setup()
    const gates = new Map<string, ReturnType<typeof deferred<ResolvedStream>>>()
    resolver.handler = (item) => {
      const gate = deferred<ResolvedStream>()
      gates.set(item.track.title, gate)
      return gate.promise
    }
    void player.setQueue(testTracks('a', 'b', 'c', 'd'))
    void player.next()
    void player.next()
    await settle()
    for (const [name, gate] of [...gates].reverse()) gate.resolve({ stream: testStream(name) })
    await settle()
    expect(current(player)).toBe('c')
    expect(engine.loadedUrls).toEqual([url('c')])
    expect(resolver.requestsFor('a')[0]?.signal.aborted).toBe(true)
    expect(resolver.requestsFor('b')[0]?.signal.aborted).toBe(true)
    expect(resolver.requestsFor('c')[0]?.signal.aborted).toBe(false)
    expect(player.getState().status).toBe('playing')
  })

  it('ignores a failed resolution that a new queue replaced', async () => {
    const { player, engine, resolver } = setup()
    const gate = deferred<ResolvedStream>()
    resolver.handler = () => gate.promise
    void player.setQueue(abc)
    resolver.handler = (item) => ({ stream: testStream(item.track.title) })
    await player.setQueue(testTracks('x'))
    gate.reject(new Error('too late'))
    await settle()
    expect(engine.loadedUrls).toEqual([url('x')])
    expect(player.getState()).toMatchObject({ status: 'playing', error: undefined })
  })
})

describe('Player: state and events', () => {
  it('passes each new state with the one it replaces', async () => {
    const { player } = setup()
    const states: [PlayerState, PlayerState][] = []
    const stop = player.subscribe((state, previous) => states.push([state, previous]))
    player.setVolume(0.5)
    expect(states).toHaveLength(1)
    expect(states[0]?.[0].volume).toBe(0.5)
    expect(states[0]?.[1].volume).toBe(1)
    expect(states[0]?.[0]).toBe(player.getState())
    stop()
    player.setVolume(0.2)
    expect(states).toHaveLength(1)
  })

  it('keeps going when a subscriber throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { player } = setup()
    const after = vi.fn()
    player.subscribe(() => {
      throw new Error('ui bug')
    })
    player.subscribe(after)
    await player.setQueue(abc)
    expect(after).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    expect(player.getState().status).toBe('playing')
  })

  it('removes an event listener', async () => {
    const { player } = setup()
    const listener = vi.fn()
    const off = player.on('seek', listener)
    off()
    await player.setQueue(abc)
    player.seek(1000)
    expect(listener).not.toHaveBeenCalled()
  })

  it('destroys the engine and ignores every later call', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    const listener = vi.fn()
    player.subscribe(listener)
    player.destroy()
    player.destroy()
    expect(engine.destroyed).toBe(true)
    expect(engine.count('destroy')).toBe(1)
    const calls = engine.calls.length
    await player.setQueue(abc)
    await player.play(1)
    await player.play()
    await player.next()
    await player.previous()
    await player.toggle()
    player.pause()
    player.seek(5)
    player.stop()
    player.setVolume(0.1)
    player.setMuted(true)
    player.addToQueue(abc)
    player.setCandidate(0, song('x'))
    expect(player.restore(player.getState().queue)).toBe(false)
    expect(engine.calls.length).toBe(calls)
    expect(listener).not.toHaveBeenCalled()
  })

  it('documents its defaults', () => {
    expect(PLAYER_DEFAULTS).toMatchObject({
      maxRetries: 3,
      retryDelaysMs: [0, 1000, 3000],
      maxConsecutiveFailures: 4,
      maxConsecutiveSkips: 10,
      stallTimeoutMs: 15_000,
      preloadLeadMs: 30_000,
      refreshBeforeExpiryMs: 600_000,
    })
  })
})

describe('restoreQueue round trip through the player', () => {
  it('keeps the candidate a played item was matched to', async () => {
    const { player: before, resolver } = setup()
    resolver.handler = () => ({ stream: testStream('song'), candidate: song('matched') })
    await before.setQueue([testTrack('m', { kind: 'music-video' })])
    const saved = restoreQueue(JSON.parse(JSON.stringify(before.getState().queue)))
    expect(saved?.items[0]?.candidate).toEqual(song('matched'))
    const { player, resolver: next } = setup()
    player.restore(saved)
    await player.play()
    expect(next.requests[0]?.item.candidate).toEqual(song('matched'))
  })
})
