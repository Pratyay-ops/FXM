import {
  type AudioCandidate,
  createSeededRandom,
  currentQueueItem,
  formatId,
  restoreQueue,
  type Track,
} from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAYER_DEFAULTS, Player, type PlayerOptions, type PlayerState } from './player'
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

const current = (player: Player) => currentQueueItem(player.getState().queue)?.track.title
const titles = (player: Player) => player.getState().queue.items.map((item) => item.track.title)
const url = (name: string) => `https://media.test/${name}`
const abc = testTracks('a', 'b', 'c')

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
    const changes: (string | undefined)[] = []
    player.on('trackchange', ({ item, previous }) => {
      changes.push(`${previous?.track.title} -> ${item?.track.title}`)
    })
    const context = { type: 'album', id: formatId('ytm', 'album', 'MPREb_x'), title: 'X' } as const
    await player.setQueue(abc, 1, context)
    expect(current(player)).toBe('b')
    expect(changes).toEqual(['undefined -> b'])
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
    expect(player.getState().queue.context?.title).toBe('X')
  })

  it('hands the engine the queue item with the stream', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    expect(engine.source?.item?.track.title).toBe('a')
  })

  it('selects the start track without playing it when autoplay is off', async () => {
    const { player, resolver } = setup()
    await player.setQueue(abc, 2, undefined, { autoplay: false })
    expect(current(player)).toBe('c')
    expect(player.getState().status).toBe('paused')
    expect(resolver.requests).toHaveLength(0)
  })

  it('stays idle when the mode hides every track', async () => {
    const { player, resolver } = setup()
    await player.setQueue([testTrack('v', { kind: 'video' })])
    expect(player.getState()).toMatchObject({ status: 'idle' })
    expect(player.getState().queue.items).toEqual([])
    expect(resolver.requests).toHaveLength(0)
  })

  it('records the candidate the resolver chose on the queue item', async () => {
    const chosen: AudioCandidate = {
      source: 'ytm',
      ref: 'song-id',
      kind: 'song',
      title: 'Song',
      artists: ['Artist'],
      confidence: 0.93,
      evidence: ['isrc'],
    }
    const { player, resolver } = setup()
    resolver.handler = () => ({ stream: testStream('song'), candidate: chosen })
    await player.setQueue([testTrack('m', { kind: 'music-video' })])
    expect(currentQueueItem(player.getState().queue)?.candidate).toEqual(chosen)
    expect(player.getState().status).toBe('playing')
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
    await player.setQueue(abc, 0, undefined, { autoplay: false })
    await player.play(9)
    await player.setQueue([testTrack('v', { kind: 'video' })])
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
    player.addToQueue(abc)
    expect(current(player)).toBe('a')
    expect(player.getState().status).toBe('paused')
    expect(resolver.requests).toHaveLength(0)
    await player.play()
    expect(engine.loadedUrls).toEqual([url('a')])
    expect(player.getState().status).toBe('playing')
  })

  it('plays the following track when the playing one is removed', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.remove(0)
    await settle()
    expect(current(player)).toBe('b')
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
    player.setMode('music')
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
    player.setMode('music')
    expect(titles(player)).toEqual(['v', 's'])
    expect(player.getState().status).toBe('playing')
    await player.next()
    expect(titles(player)).toEqual(['s'])
    expect(engine.loadedUrls).toEqual([url('v'), url('s')])
  })

  it('restores a saved queue paused at the saved position', async () => {
    const { player: before } = setup()
    await before.setQueue(abc, 1)
    const saved = JSON.parse(JSON.stringify(before.getState().queue)) as unknown
    const { player, engine } = setup()
    const queue = restoreQueue(saved)
    if (queue === null) throw new Error('The queue did not restore')
    player.restore(queue, 42_000)
    expect(current(player)).toBe('b')
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 42_000 })
    await player.play()
    const load = engine.calls.find((call) => call.method === 'load')
    expect(load?.args[1]).toBe(42_000)
  })

  it("restores an empty queue as idle, in the player's mode", async () => {
    const { player } = setup({ queue: { mode: 'all' } })
    await player.setQueue(abc)
    player.restore(restoreQueue({ items: [] }) ?? player.getState().queue, 99)
    expect(player.getState()).toMatchObject({ status: 'idle', positionMs: 0 })
    expect(player.getState().queue.mode).toBe('all')
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
    await player.setQueue(abc)
    engine.progress(30_000)
    await player.play(2)
    expect(current(player)).toBe('c')
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
    const seeks: number[] = []
    player.on('seek', ({ positionMs }) => seeks.push(positionMs))
    await player.setQueue(abc)
    player.seek(60_000)
    player.seek(-5)
    player.seek(10_000_000)
    player.seek(Number.NaN)
    player.seekBy(-30_000)
    expect(seeks).toEqual([60_000, 0, 180_000, 150_000])
    expect(
      engine.calls.filter((call) => call.method === 'seek').map((call) => call.args[0]),
    ).toEqual(seeks)
    expect(player.getState().positionMs).toBe(150_000)
  })

  it('starts a track that is not loaded yet where it was seeked to', async () => {
    const { player, engine } = setup()
    player.addToQueue(abc)
    player.seek(30_000)
    expect(engine.count('seek')).toBe(0)
    await player.play()
    expect(engine.calls.find((call) => call.method === 'load')?.args[1]).toBe(30_000)
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
    await player.setQueue(abc)
    engine.progress(90_000)
    player.stop()
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 0 })
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
    await player.next()
    expect(current(player)).toBe('b')
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
    await player.setQueue(abc, 2)
    await player.next()
    expect(current(player)).toBe('c')
    expect(engine.count('load')).toBe(1)
  })

  it('goes back early in a track', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, 1)
    engine.progress(2000)
    await player.previous()
    expect(current(player)).toBe('a')
    expect(engine.loadedUrls).toEqual([url('b'), url('a')])
  })

  it('restarts the track more than 3 s in', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, 1)
    engine.progress(5000)
    await player.previous()
    expect(current(player)).toBe('b')
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
    await player.setQueue(abc, 2)
    player.pause()
    await player.previous()
    expect(current(player)).toBe('b')
    expect(player.getState().status).toBe('paused')
    expect(resolver.requests).toHaveLength(1)
  })

  it('wraps around with repeat all', async () => {
    const { player } = setup({ queue: { repeat: 'all' } })
    await player.setQueue(abc, 2)
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
    engine.end()
    await settle()
    expect(current(player)).toBe('b')
    expect(engine.loadedUrls).toEqual([url('a'), url('b')])
    expect(player.getState().status).toBe('playing')
  })

  it('ends after the last track when repeat is off', async () => {
    const { player, engine } = setup()
    const queueEnd = vi.fn()
    player.on('queueend', queueEnd)
    await player.setQueue(abc, 2)
    engine.emit('durationchange', 181_000)
    engine.end()
    await settle()
    expect(queueEnd).toHaveBeenCalledOnce()
    expect(player.getState()).toMatchObject({ status: 'ended', positionMs: 181_000 })
    expect(engine.count('load')).toBe(1)
  })

  it('plays the last track again when asked to play after the end', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(abc, 2)
    engine.end()
    await player.play()
    expect(current(player)).toBe('c')
    expect(engine.calls.at(-2)).toEqual({ method: 'seek', args: [0] })
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 0 })
    expect(resolver.requests).toHaveLength(1)
  })

  it('plays what was added after the end', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, 2)
    engine.end()
    player.addToQueue(testTracks('d'))
    await player.play()
    expect(current(player)).toBe('d')
    expect(engine.loadedUrls.at(-1)).toBe(url('d'))
  })

  it('rewinds an ended track paused when it is seeked or restarted while paused', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc, 2)
    engine.end()
    player.seek(10_000)
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 10_000 })
    engine.end()
    player.stop()
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 0 })
  })

  it('starts over after the last track with repeat all', async () => {
    const { player, engine } = setup({ queue: { repeat: 'all' } })
    await player.setQueue(abc, 2)
    engine.end()
    await settle()
    expect(current(player)).toBe('a')
    expect(player.getState().status).toBe('playing')
  })

  it('replays the track with repeat one, without resolving it again', async () => {
    const { player, engine, resolver } = setup({ queue: { repeat: 'one' } })
    const seeks = vi.fn()
    player.on('seek', seeks)
    await player.setQueue(abc)
    engine.progress(179_000)
    engine.end()
    await settle()
    expect(current(player)).toBe('a')
    expect(seeks).toHaveBeenCalledWith({ positionMs: 0 })
    expect(engine.calls.slice(-2)).toEqual([
      { method: 'seek', args: [0] },
      { method: 'play', args: [] },
    ])
    expect(resolver.requests).toHaveLength(1)
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 0 })
  })

  it('still skips to the next track with repeat one', async () => {
    const { player } = setup({ queue: { repeat: 'one' } })
    await player.setQueue(abc, 2)
    await player.next()
    expect(current(player)).toBe('a')
  })

  it('replays the only track of a repeat-all queue', async () => {
    const { player, engine } = setup({ queue: { repeat: 'all' } })
    await player.setQueue(testTracks('a'))
    engine.end()
    await settle()
    expect(current(player)).toBe('a')
    expect(engine.count('load')).toBe(1)
    expect(engine.calls.at(-1)?.method).toBe('play')
    await player.next()
    expect(engine.count('load')).toBe(1)
    expect(player.getState().positionMs).toBe(0)
  })

  it('keeps playing the current track when shuffle turns on', async () => {
    const { player, engine } = setup()
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e', 'f'), 2)
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

  it('shuffles a new queue, starting with the chosen track', async () => {
    const { player } = setup({ queue: { shuffle: true } })
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e'), 3)
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
  it('prepares the next track 30 s before the end of the current one', async () => {
    const onPreload = vi.fn()
    const { player, engine, resolver } = setup({ onPreload })
    await player.setQueue(abc)
    engine.progress(149_000)
    expect(resolver.requestsFor('b')).toHaveLength(0)
    engine.progress(150_000)
    await settle()
    expect(resolver.requestsFor('b')).toEqual([
      expect.objectContaining({ reason: 'preload', attempt: 0 }),
    ])
    expect(engine.preloaded?.stream.url).toBe(url('b'))
    expect(engine.preloaded?.item?.track.title).toBe('b')
    const [next, upcoming] = onPreload.mock.calls[0] ?? []
    expect(next.track.title).toBe('b')
    expect(upcoming.map((item: { track: Track }) => item.track.title)).toEqual(['b', 'c'])
    engine.progress(170_000)
    await settle()
    expect(resolver.requestsFor('b')).toHaveLength(1)
    expect(onPreload).toHaveBeenCalledOnce()
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
    ['preloading off', { preload: false }, abc],
    ['nothing next', {}, testTracks('a')],
  ] as const)('does not prepare with %s', async (_name, options, tracks) => {
    const { player, engine, resolver } = setup(options)
    await player.setQueue(tracks)
    engine.progress(179_000)
    await settle()
    expect(resolver.requests).toHaveLength(1)
    expect(engine.count('preload')).toBe(0)
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

  it('does not hand the engine a stream it cannot play', async () => {
    const { player, engine } = setup()
    engine.canPlayStream = (stream) => (stream.url === url('b') ? 'no' : 'maybe')
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    expect(engine.count('preload')).toBe(0)
  })

  it('keeps working when the hook throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { player, engine } = setup({
      onPreload: () => {
        throw new Error('hook bug')
      },
    })
    await player.setQueue(abc)
    engine.progress(170_000)
    await settle()
    expect(error).toHaveBeenCalledOnce()
    expect(engine.preloaded?.stream.url).toBe(url('b'))
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
    player.restore(player.getState().queue)
    expect(engine.calls.length).toBe(calls)
    expect(listener).not.toHaveBeenCalled()
  })

  it('documents its defaults', () => {
    expect(PLAYER_DEFAULTS).toMatchObject({
      maxRetries: 3,
      retryDelaysMs: [0, 1000, 3000],
      maxConsecutiveFailures: 4,
      preloadLeadMs: 30_000,
    })
  })
})
