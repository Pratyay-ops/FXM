import { FxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { EngineError } from '../engine'
import type { PlayerOptions } from '../player'
import type { ResolvedStream } from '../resolver'
import { testStream, testTracks } from '../testing/fixtures'
import { nativeSetup, settle } from './test-harness'

/** The calls after `from`, without the volume ones. */
function callsSince(calls: readonly string[], from: number): string[] {
  return calls.slice(from).filter((call) => !call.startsWith('setVolume'))
}

/** A connected player playing `a` of the given queue, with Media3 queued up. */
async function playing(...titles: string[]) {
  return playingWith({}, ...titles)
}

/** {@link playing} with the harness's options, e.g. without the engine's resolver wrapper. */
async function playingWith(
  options: { wrap?: boolean; player?: Partial<PlayerOptions> },
  ...titles: string[]
) {
  const setup = nativeSetup(options)
  await setup.connect()
  await setup.player.setQueue(testTracks(...titles))
  await settle()
  setup.plugin.ready()
  await settle()
  return setup
}

describe('crossing a track boundary in Media3', () => {
  it('lets the facade follow without pausing or loading anything', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c')
    expect(plugin.entries.map((entry) => entry.metadata.title)).toEqual(['a', 'b', 'c'])
    const causes: string[] = []
    player.on('trackchange', ({ cause }) => causes.push(cause))
    const from = plugin.calls.length
    plugin.advance()
    await settle()
    expect(current()).toBe('b')
    expect(causes).toEqual(['ended'])
    expect(player.getState().status).toBe('playing')
    const calls = callsSince(plugin.calls, from)
    expect(calls.some((call) => call === 'pause' || call.startsWith('load'))).toBe(false)
    // The queue's tail moves along.
    expect(calls).toContain('setUpcoming:[c]')
  })

  it('takes over the position Media3 reached meanwhile', async () => {
    const { plugin, player } = await playing('a', 'b')
    plugin.advance()
    plugin.progress(2_500, 200_000)
    await settle()
    expect(player.getState()).toMatchObject({ positionMs: 2_500, durationMs: 200_000 })
  })

  it('follows through every entry Media3 played while the page was busy', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c', 'd')
    const changes: string[] = []
    player.on('trackchange', ({ item, cause }) => changes.push(`${item?.track.title}:${cause}`))
    const from = plugin.calls.length
    plugin.advance()
    plugin.advance()
    await settle()
    expect(current()).toBe('c')
    expect(changes).toEqual(['b:ended', 'c:ended'])
    expect(player.getState().status).toBe('playing')
    expect(callsSince(plugin.calls, from).some((call) => call.startsWith('load'))).toBe(false)
  })

  it('switches Media3 to the facade’s item when the queue changed at the boundary', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c')
    const from = plugin.calls.length
    // The user removes b just as Media3 starts it, before the queue's tail reached Media3.
    player.remove(1)
    plugin.advance()
    await settle()
    expect(current()).toBe('c')
    const calls = callsSince(plugin.calls, from)
    expect(calls).toContain('pause')
    expect(calls).toContain('load:c@0+[]')
  })

  it('stops Media3 when the facade’s queue ended', async () => {
    const { plugin, player } = await playing('a', 'b')
    player.remove(1)
    plugin.advance()
    await settle()
    expect(player.getState().status).toBe('ended')
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('pauses Media3 when the user paused while the facade caught up', async () => {
    const { plugin, player, current } = await playing('a', 'b')
    plugin.advance()
    // The facade is still resolving b.
    player.pause()
    await settle()
    expect(current()).toBe('b')
    expect(player.getState().status).toBe('paused')
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('reports a failure of the entry Media3 moved to, once the facade has it', async () => {
    const { plugin, player, resolver } = await playing('a', 'b')
    plugin.advance()
    plugin.fail({ status: 410 })
    await settle()
    const retry = resolver.requestsFor('b').find((request) => request.reason === 'retry')
    expect(retry?.failure?.error).toMatchObject({ type: 'network' } satisfies Partial<EngineError>)
    expect(plugin.calls.filter((call) => call.startsWith('load:b'))).toHaveLength(1)
    expect(player.getState().queue.index).toBe(1)
  })

  it('lets Media3 loop a track on repeat one, without seeking it back', async () => {
    const { plugin, player } = await playing('a', 'b')
    player.setRepeat('one')
    await settle()
    expect(plugin.repeat).toBe('one')
    const seeks: string[] = []
    player.on('seek', ({ cause }) => seeks.push(cause))
    const from = plugin.calls.length
    plugin.repeatRound()
    await settle()
    expect(seeks).toEqual(['repeat'])
    expect(callsSince(plugin.calls, from).some((call) => call.startsWith('seek'))).toBe(false)
    expect(player.getState().status).toBe('playing')
  })

  it('goes back to the facade’s item when repeat one came on as Media3 moved on', async () => {
    const { plugin, player, current, native } = await playing('a', 'b')
    // Media3 crosses the boundary before the new repeat mode reaches it.
    player.setRepeat('one')
    plugin.advance()
    await settle()
    expect(current()).toBe('a')
    expect(native()[0]).toBe('a')
    expect(plugin.repeat).toBe('one')
    expect(plugin.state.playWhenReady).toBe(true)
    plugin.ready()
    await settle()
    expect(player.getState().status).toBe('playing')
  })

  it('hands the system’s next and previous to the facade', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c')
    const causes: string[] = []
    player.on('trackchange', ({ cause }) => causes.push(cause))
    plugin.command('next')
    await settle()
    expect(plugin.calls).toContain('ack')
    expect(current()).toBe('b')
    plugin.ready()
    plugin.command('previous')
    await settle()
    expect(current()).toBe('a')
    expect(causes).toEqual(['next', 'previous'])
  })

  it('skips to a queued entry by its id, so Media3 keeps its buffer', async () => {
    const { plugin, player } = await playing('a', 'b', 'c')
    const queued = plugin.entries[1]?.id
    await player.next()
    expect(plugin.entries[0]?.id).toBe(queued)
  })

  it('pauses Media3 when the facade stops for good', async () => {
    const { plugin, player, resolver } = await playing('a', 'b')
    resolver.handler = () => {
      throw new FxmError('BotCheck', 'Sign in to confirm you’re not a bot')
    }
    plugin.fail({ status: 403 })
    await settle()
    expect(player.getState()).toMatchObject({
      status: 'error',
      error: { reason: 'action-required' },
    })
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('releases Media3 when the queue is emptied', async () => {
    const { plugin, player } = await playing('a', 'b')
    await player.setQueue([])
    await settle()
    expect(plugin.calls).toContain('release')
    expect(plugin.entries).toEqual([])
  })
})

describe('taking over what Media3 plays', () => {
  it('answers the facade’s resolution from Media3’s entry, without a request', async () => {
    const { plugin, player, resolver, current } = await playing('a', 'b', 'c')
    resolver.handler = (item, request) => {
      if (item.track.title === 'b' && request.reason === 'play') {
        throw new FxmError('BotCheck', 'Sign in to confirm you’re not a bot')
      }
      return { stream: testStream(item.track.title) }
    }
    plugin.advance()
    await settle()
    expect(current()).toBe('b')
    expect(player.getState()).toMatchObject({
      status: 'playing',
      stream: { url: testStream('b').url },
    })
    expect(resolver.requestsFor('b').map((request) => request.reason)).toEqual(['preload'])
    expect(plugin.state.playWhenReady).toBe(true)
  })

  it('without the wrapper, a failed resolution leaves Media3 paused with the facade', async () => {
    const { plugin, player, resolver } = await playingWith({ wrap: false }, 'a', 'b', 'c')
    resolver.handler = (item, request) => {
      if (item.track.title === 'b' && request.reason !== 'preload') {
        throw new FxmError('Network', 'offline for a moment')
      }
      return { stream: testStream(item.track.title) }
    }
    plugin.advance()
    // The user pauses while the facade resolves b, which fails.
    player.pause()
    await settle()
    expect(player.getState().status).toBe('paused')
    expect(plugin.state.playWhenReady).toBe(false)
    // Playing again resolves b afresh and takes Media3's entry over.
    resolver.handler = (item) => ({ stream: testStream(item.track.title) })
    await player.play()
    await settle()
    expect(player.getState().status).toBe('playing')
    expect(plugin.state.playWhenReady).toBe(true)
    expect(plugin.calls.some((call) => call.startsWith('load:b'))).toBe(false)
    player.pause()
    await settle()
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('pauses Media3 at once when the user pauses during a slow hand-over', async () => {
    const { plugin, player, resolver } = await playingWith({ wrap: false }, 'a', 'b', 'c')
    let release: (value: ResolvedStream) => void = () => {}
    resolver.handler = (item, request) => {
      if (item.track.title === 'b' && request.reason !== 'preload') {
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return { stream: testStream(item.track.title) }
    }
    plugin.advance()
    player.pause()
    await settle()
    expect(plugin.state.playWhenReady).toBe(false)
    release({ stream: testStream('b') })
    await settle()
    expect(player.getState().status).toBe('paused')
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('seeks to where the user moved while the facade caught up', async () => {
    const { plugin, player } = await playingWith({ wrap: false }, 'a', 'b')
    plugin.advance()
    player.seek(60_000)
    await settle()
    expect(plugin.calls).toContain('seek:60000')
    expect(plugin.calls.filter((call) => call.startsWith('seek'))).toEqual(['seek:60000'])
  })

  it('brings Media3 back to the facade’s item when its queue ends at a later step', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c')
    plugin.advance()
    plugin.advance()
    // c leaves the facade's queue while it catches up with Media3, which already plays it.
    player.remove(2)
    await settle()
    expect(current()).toBe('b')
    expect(player.getState().status).toBe('ended')
    expect(plugin.state.playWhenReady).toBe(false)
    expect(plugin.entries[0]?.metadata.title).toBe('b')
    // Play and pause in the app reach Media3, on the facade's item.
    await player.play()
    await settle()
    expect(plugin.state).toMatchObject({ playWhenReady: true })
    expect(plugin.entries[0]?.metadata.title).toBe('b')
    player.pause()
    await settle()
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('ends with Media3 when it played the whole queue while the facade was busy', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c')
    const ends: string[] = []
    player.on('queueend', () => ends.push('end'))
    plugin.advance()
    plugin.advance()
    plugin.end()
    await settle()
    expect(current()).toBe('c')
    expect(player.getState().status).toBe('ended')
    expect(ends).toEqual(['end'])
    expect(plugin.state).toMatchObject({ state: 'ended', playing: false })
    expect(plugin.calls.some((call) => call.startsWith('load'))).toBe(true)
    expect(plugin.calls.filter((call) => call.startsWith('load'))).toHaveLength(1)
  })

  it('pauses from the app also reach Media3 without connect', async () => {
    const { plugin, engine, player } = nativeSetup()
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    plugin.ready()
    const next = player.getState().queue.items[1]
    if (next === undefined) throw new Error('no next item')
    engine.preload({ stream: testStream('b'), item: next })
    await settle()
    plugin.advance()
    await settle()
    expect(player.getState().status).toBe('playing')
    player.pause()
    await settle()
    expect(plugin.state.playWhenReady).toBe(false)
  })
})

describe('the system controls while paused', () => {
  it('next moves Media3 to the queued entry, and play plays it', async () => {
    const { plugin, player, current, native } = await playing('a', 'b', 'c')
    player.pause()
    await settle()
    const queued = plugin.entries[1]?.id
    plugin.command('next')
    await settle()
    expect(current()).toBe('b')
    expect(player.getState().status).toBe('paused')
    // Media3 skips to its queued entry, keeping its buffer, and shows it.
    expect(native()[0]).toBe('b')
    expect(plugin.entries[0]?.id).toBe(queued)
    expect(plugin.state.playWhenReady).toBe(false)
    // The lock screen's play button.
    plugin.systemPlay(true)
    plugin.ready()
    plugin.progress(5_000, 180_000)
    await settle()
    expect(current()).toBe('b')
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 5_000 })
    expect(native()[0]).toBe('b')
    expect(plugin.calls.filter((call) => call.startsWith('load:b'))).toHaveLength(1)
  })

  it('next twice while paused moves Media3 along its queue', async () => {
    const { plugin, player, current, native } = await playing('a', 'b', 'c', 'd')
    player.pause()
    await settle()
    await player.next()
    await player.next()
    await settle()
    expect(current()).toBe('c')
    expect(native()).toEqual(['c', 'd'])
    expect(plugin.state.playWhenReady).toBe(false)
    await player.play()
    plugin.ready()
    await settle()
    expect(player.getState().status).toBe('playing')
    expect(plugin.calls.filter((call) => call.startsWith('load:c'))).toHaveLength(1)
  })

  it('play on the lock screen after the facade stopped tries the item again', async () => {
    const { plugin, player, resolver } = await playing('a', 'b')
    resolver.handler = () => {
      throw new FxmError('BotCheck', 'Sign in to confirm you’re not a bot')
    }
    plugin.fail({ status: 403 })
    await settle()
    expect(player.getState().status).toBe('error')
    expect(plugin.state.playWhenReady).toBe(false)
    // The user cleared the check; the lock screen's play button.
    resolver.handler = (item) => ({ stream: testStream(`${item.track.title}-fresh`) })
    plugin.systemPlay(true)
    await settle()
    expect(plugin.entries[0]?.source.url).toBe(testStream('a-fresh').url)
    plugin.ready()
    await settle()
    expect(player.getState().status).toBe('playing')
  })

  it('previous to an item Media3 does not hold: play loads it, not the old track', async () => {
    const { plugin, player, current, native } = await playing('a', 'b', 'c')
    await player.next()
    await settle()
    plugin.ready()
    player.pause()
    await settle()
    plugin.command('previous')
    await settle()
    expect(current()).toBe('a')
    expect(native()[0]).toBe('b')
    plugin.systemPlay(true)
    await settle()
    // Media3 stops the old track while the facade loads its own.
    expect(plugin.calls).toContain('pause')
    expect(native()[0]).toBe('a')
    plugin.ready()
    await settle()
    expect(player.getState().status).toBe('playing')
    expect(current()).toBe('a')
  })

  it('a pause as Media3 crosses a boundary keeps both paused on the next item', async () => {
    const { plugin, player, current, native } = await playing('a', 'b', 'c')
    player.pause()
    // Media3 had already moved on when the pause arrived.
    plugin.advance()
    plugin.systemPlay(false)
    await settle()
    expect(current()).toBe('b')
    expect(player.getState().status).toBe('paused')
    expect(native()[0]).toBe('b')
    expect(plugin.state.playWhenReady).toBe(false)
    await player.play()
    plugin.ready()
    await settle()
    expect(player.getState().status).toBe('playing')
    expect(plugin.calls.some((call) => call.startsWith('load:b'))).toBe(false)
  })

  it('play on the lock screen after the queue ended plays the last track again', async () => {
    const { plugin, player, current } = await playing('a')
    plugin.end()
    await settle()
    expect(player.getState().status).toBe('ended')
    plugin.systemPlay(true)
    plugin.ready()
    await settle()
    expect(current()).toBe('a')
    expect(player.getState().status).toBe('playing')
  })

  it('a stop from a headset or a car pauses the facade', async () => {
    const { plugin, player } = await playing('a', 'b')
    expect(player.getState().status).toBe('playing')
    plugin.stop()
    await settle()
    expect(player.getState().status).toBe('paused')
    await player.play()
    await settle()
    expect(plugin.calls.at(-1)).toBe('play')
  })

  it('a stop pauses the facade without connect too', async () => {
    const { plugin, player } = nativeSetup()
    await player.setQueue(testTracks('a'))
    plugin.ready()
    await settle()
    plugin.stop()
    await settle()
    expect(player.getState().status).toBe('paused')
  })
})
