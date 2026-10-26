import { currentQueueItem, FxmError, type QueueState, type StreamOption } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { EngineError } from '../engine'
import { testStream, testTrack, testTracks } from '../testing/fixtures'
import { nativeSetup, settle } from './test-harness'

const titles = (entries: readonly { metadata: { title: string } }[]) =>
  entries.map((entry) => entry.metadata.title)

describe('the native queue', () => {
  it('keeps the next items resolved in Media3, one at a time, at the prefetch priority', async () => {
    const { plugin, player, resolver, connect } = nativeSetup()
    await connect({ depth: 3 })
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e'))
    await settle()
    expect(titles(plugin.entries)).toEqual(['a', 'b', 'c', 'd'])
    expect(plugin.hasMore).toBe(true)
    expect(resolver.log).toEqual(['a:play#0', 'b:preload#0', 'c:preload#0', 'd:preload#0'])
  })

  it('stops at the audio it may queue ahead', async () => {
    const { plugin, player, connect } = nativeSetup()
    await connect({ depth: 10, aheadMs: 300_000 })
    await player.setQueue(testTracks('a', 'b', 'c', 'd'))
    await settle()
    // Three minutes each: after b, six minutes are queued, past the five allowed.
    expect(titles(plugin.entries)).toEqual(['a', 'b', 'c'])
  })

  it('queues only what resolved, and tries the rest again on the next track', async () => {
    const { plugin, player, resolver, connect } = nativeSetup()
    resolver.handler = (item, request) => {
      if (item.track.title === 'c' && request.reason === 'preload') {
        throw new FxmError('RateLimited', 'The request budget is spent', { retryAfterMs: 60_000 })
      }
      return { stream: testStream(item.track.title) }
    }
    await connect()
    await player.setQueue(testTracks('a', 'b', 'c', 'd'))
    await settle()
    expect(titles(plugin.entries)).toEqual(['a', 'b'])
    expect(plugin.hasMore).toBe(true)
    expect(resolver.requestsFor('c')).toHaveLength(1)
    plugin.ready()
    plugin.advance()
    await settle()
    expect(resolver.requestsFor('c')).toHaveLength(2)
  })

  it('follows queue edits, wraps around for repeat all, and loops one item natively', async () => {
    const { plugin, player, connect } = nativeSetup()
    await connect()
    await player.setQueue(testTracks('a', 'b', 'c'))
    await settle()
    player.move(2, 1)
    await settle()
    expect(titles(plugin.entries)).toEqual(['a', 'c', 'b'])
    player.setRepeat('all')
    await settle()
    expect(titles(plugin.entries)).toEqual(['a', 'c', 'b'])
    player.play(2)
    await settle()
    expect(titles(plugin.entries)).toEqual(['b', 'a', 'c'])
    expect(plugin.repeat).toBe('all')
    // A one-item queue on repeat all is repeat one.
    await player.setQueue(testTracks('z'))
    await settle()
    expect(titles(plugin.entries)).toEqual(['z'])
    expect(plugin.repeat).toBe('one')
  })

  it('uses the stream the facade preloads', async () => {
    const { plugin, engine, player, resolver, connect } = nativeSetup()
    resolver.handler = (item, request) => {
      if (request.reason === 'preload') throw new FxmError('Network', 'offline for a moment')
      return { stream: testStream(item.track.title) }
    }
    await connect()
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    expect(titles(plugin.entries)).toEqual(['a'])
    const next = player.getState().queue.items[1]
    if (next === undefined) throw new Error('no next item')
    engine.preload({ stream: testStream('b-preloaded'), item: next })
    await settle()
    expect(plugin.entries[1]?.source.url).toBe(testStream('b-preloaded').url)
  })

  it('without a connected player, queues what the facade preloads, and drops it on null', async () => {
    const { plugin, engine } = nativeSetup()
    await engine.load({ stream: testStream('a'), item: { uid: 1, track: testTrack('a') } })
    engine.preload({ stream: testStream('b'), item: { uid: 2, track: testTrack('b') } })
    await settle()
    expect(plugin.calls.slice(-2)).toEqual(['load:a@0+[]', 'setUpcoming:[b]'])
    engine.preload(null)
    await settle()
    expect(titles(plugin.entries)).toEqual(['a'])
    // Nothing queued, nothing to drop.
    engine.preload(null)
    await settle()
    expect(plugin.calls.filter((call) => call.startsWith('setUpcoming'))).toHaveLength(2)
  })

  it('connected, follows the facade’s queue rather than what it preloads or drops', async () => {
    const { plugin, engine, player, connect } = nativeSetup()
    await connect()
    await player.setQueue(testTracks('a', 'b', 'c'))
    await settle()
    engine.preload(null)
    await settle()
    expect(titles(plugin.entries)).toEqual(['a', 'b', 'c'])
  })

  it('sends a tail Media3 refused again with the next change', async () => {
    const { plugin, player, connect } = nativeSetup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const setUpcoming = plugin.setUpcoming.bind(plugin)
    let refuse = true
    plugin.setUpcoming = async (options) => {
      if (refuse) throw Object.assign(new Error('The player failed'), { code: 'INTERNAL' })
      return setUpcoming(options)
    }
    await connect()
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    player.addToQueue(testTracks('c'))
    await settle()
    // b was resolved after the load, and every tail since was refused.
    expect(titles(plugin.entries)).toEqual(['a'])
    expect(errors).toHaveBeenCalled()
    refuse = false
    player.addToQueue(testTracks('d'))
    await settle()
    expect(titles(plugin.entries)).toEqual(['a', 'b', 'c', 'd'])
    errors.mockRestore()
  })

  it('stores a snapshot Media3 refused again with the next change', async () => {
    const { plugin, player, connect } = nativeSetup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = plugin.saveSnapshot.bind(plugin)
    let refuse = true
    plugin.saveSnapshot = async (options) => {
      if (refuse)
        throw Object.assign(new Error('The snapshot is too large'), { code: 'BAD_REQUEST' })
      return save(options)
    }
    await connect()
    await player.setQueue(testTracks('a', 'b'), { autoplay: false })
    await settle()
    expect(plugin.snapshot).toBeNull()
    refuse = false
    player.setRepeat('all')
    await settle()
    expect(JSON.parse(plugin.snapshot ?? 'null')).toMatchObject({ v: 1, queue: { repeat: 'all' } })
    errors.mockRestore()
  })

  it('resolves an entry whose URL expires afresh, telling the lifecycle which one expires', async () => {
    let round = 0
    const { plugin, player, resolver, connect } = nativeSetup()
    resolver.handler = (item) => {
      round += 1
      return { stream: testStream(`${item.track.title}-${round}`) }
    }
    await connect()
    await player.setQueue(testTracks('a', 'b', 'c'))
    await settle()
    const queued = plugin.entries[1]
    expect(queued?.metadata.title).toBe('b')
    plugin.request(queued?.id ?? '', 'expiring')
    await settle()
    const request = resolver.requestsFor('b').at(-1)
    expect(request?.reason).toBe('preload')
    expect(request?.failure?.error).toBeInstanceOf(EngineError)
    expect(request?.failure?.error).toMatchObject({ type: 'expired' })
    expect(request?.failure?.stream?.url).toBe(queued?.source.url)
    expect(plugin.entries[1]?.id).toBe(queued?.id)
    expect(plugin.entries[1]?.source.url).not.toBe(queued?.source.url)
  })

  it('does not queue a stream that expires too soon, nor resolve it again and again', async () => {
    const { plugin, player, resolver, connect } = nativeSetup()
    resolver.handler = (item, request) => ({
      stream: testStream(item.track.title, {
        ...(request.reason === 'preload' ? { expiresAt: Date.now() + 60_000 } : {}),
      }),
    })
    await connect()
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    expect(titles(plugin.entries)).toEqual(['a'])
    expect(resolver.requestsFor('b')).toHaveLength(1)
  })

  it('ignores requests for entries it does not know', async () => {
    const { plugin, player, resolver, connect } = nativeSetup()
    await connect()
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    const before = resolver.requests.length
    plugin.request('unknown', 'network')
    plugin.request(plugin.entries[0]?.id ?? '', 'network')
    await settle()
    expect(resolver.requests).toHaveLength(before)
  })
})

describe('network changes', () => {
  it('reach the lifecycle’s network monitor once per change', async () => {
    const { plugin, engine } = nativeSetup()
    await settle()
    const changes = vi.fn()
    const stop = engine.network.subscribe(changes)
    const before = engine.network.id
    plugin.changeNetwork(true)
    expect(changes).toHaveBeenCalledTimes(1)
    expect(engine.network.id).not.toBe(before)
    expect(engine.network.cellular).toBe(true)
    stop()
    plugin.changeNetwork(false)
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('resolve IP-bound upcoming entries afresh on the new network', async () => {
    const { plugin, player, resolver, connect } = nativeSetup()
    let round = 0
    resolver.handler = (item) => {
      round += 1
      return {
        stream: testStream(`${item.track.title}-${round}`, {
          ipBound: true,
          expiresAt: Date.now() + 6 * 3_600_000,
        }),
      }
    }
    await connect()
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    const queued = plugin.entries[1]
    expect(queued?.source.network).toBe(0)
    plugin.changeNetwork()
    await settle()
    expect(plugin.entries[1]?.id).toBe(queued?.id)
    expect(plugin.entries[1]?.source).toMatchObject({ network: 1, ipBound: true })
    expect(plugin.entries[1]?.source.url).not.toBe(queued?.source.url)
  })
})

describe('when the page comes back', () => {
  /** A page that played a, b and c until Media3 moved on to b at 30 s, and then died. */
  async function diedOnB() {
    const first = nativeSetup()
    await first.connect()
    await first.player.setQueue(testTracks('a', 'b', 'c'))
    await settle()
    first.plugin.ready()
    first.plugin.advance()
    await settle()
    first.plugin.progress(30_000, 200_000)
    const session = await first.plugin.attach()
    first.plugin.detach()
    return session
  }

  it('restores the queue and adopts what Media3 plays, without reloading it', async () => {
    const session = await diedOnB()
    const second = nativeSetup({ fake: { session } })
    const connection = await second.connect()
    expect(connection.resumed).toBe(true)
    await settle()
    expect(second.current()).toBe('b')
    expect(second.player.getState()).toMatchObject({ status: 'playing', positionMs: 30_000 })
    expect(second.plugin.calls.some((call) => call.startsWith('load'))).toBe(false)
    // It goes on feeding Media3's queue.
    expect(titles(second.plugin.entries)).toEqual(['b', 'c'])
  })

  it('stays paused where Media3 is paused', async () => {
    const session = await diedOnB()
    const second = nativeSetup({
      fake: { session: { ...session, playWhenReady: false, playing: false } },
    })
    await second.connect()
    await settle()
    expect(second.current()).toBe('b')
    expect(second.player.getState()).toMatchObject({ status: 'paused', positionMs: 30_000 })
    await second.player.play()
    await settle()
    expect(second.player.getState().status).toBe('playing')
    expect(second.plugin.calls.some((call) => call.startsWith('load'))).toBe(false)
  })

  it('continues with the next item when Media3 ran out', async () => {
    const session = await diedOnB()
    const second = nativeSetup({
      fake: { session: { ...session, state: 'ended', playing: false } },
    })
    await second.connect()
    await settle()
    expect(second.current()).toBe('c')
    expect(second.plugin.calls.some((call) => call.startsWith('load:c@0'))).toBe(true)
  })

  it('starts empty without a snapshot', async () => {
    const session = await diedOnB()
    const second = nativeSetup({ fake: { session: { ...session, snapshot: null } } })
    const connection = await second.connect()
    expect(connection.resumed).toBe(false)
    expect(second.player.getState().queue.items).toEqual([])
  })

  it('reports a failure Media3 met while the page was gone, once the player has the entry', async () => {
    const session = await diedOnB()
    const second = nativeSetup({
      fake: {
        session: {
          ...session,
          state: 'idle',
          playing: false,
          error: { type: 'network', status: 403, message: 'HTTP 403' },
        },
      },
    })
    await second.connect()
    await settle()
    const retry = second.resolver.requestsFor('b').find((request) => request.reason === 'retry')
    expect(retry?.failure?.error).toMatchObject({ type: 'network' })
    expect(retry?.failure?.positionMs).toBe(30_000)
    expect(second.plugin.calls.some((call) => call.startsWith('load:b@30000'))).toBe(true)
  })

  it('keeps Media3 playing when resolving its item again would fail', async () => {
    const session = await diedOnB()
    const second = nativeSetup({ fake: { session } })
    second.resolver.handler = (item) => {
      if (item.track.title === 'b') throw new FxmError('Network', 'offline for a moment')
      return { stream: testStream(item.track.title) }
    }
    await second.connect()
    await settle()
    expect(second.current()).toBe('b')
    expect(second.player.getState()).toMatchObject({
      status: 'playing',
      stream: { url: testStream('b').url },
    })
    expect(second.plugin.state.playWhenReady).toBe(true)
    expect(second.resolver.requestsFor('b')).toEqual([])
    expect(second.plugin.calls.some((call) => call.startsWith('load'))).toBe(false)
  })

  it('connects without waiting for the player to take the entry over', async () => {
    const session = await diedOnB()
    // A page wired without the engine's resolver wrapper resolves b again, slowly.
    const second = nativeSetup({ fake: { session }, wrap: false })
    let release: (value: { stream: StreamOption }) => void = () => {}
    second.resolver.handler = (item) =>
      item.track.title === 'b'
        ? new Promise((resolve) => {
            release = resolve
          })
        : { stream: testStream(item.track.title) }
    const connection = await second.connect()
    expect(connection.resumed).toBe(true)
    expect(second.player.getState().status).toBe('loading')
    release({ stream: testStream('b') })
    await settle()
    expect(second.player.getState().status).toBe('playing')
    expect(second.plugin.calls.some((call) => call.startsWith('load'))).toBe(false)
  })

  it('wraps around for repeat all when Media3 ran out on the last item', async () => {
    const first = nativeSetup()
    await first.connect()
    await first.player.setQueue(testTracks('a', 'b'))
    first.player.setRepeat('all')
    await settle()
    first.plugin.ready()
    first.plugin.advance()
    await settle()
    const session = await first.plugin.attach()
    first.plugin.detach()
    const second = nativeSetup({
      fake: { session: { ...session, state: 'ended', playing: false } },
    })
    await second.connect()
    await settle()
    expect(second.current()).toBe('a')
    expect(second.player.getState().status).not.toBe('paused')
    expect(second.plugin.calls.some((call) => call.startsWith('load:a@0'))).toBe(true)
  })

  it('lets the player’s own item play when the restored queue lost Media3’s', async () => {
    const session = await diedOnB()
    const snapshot = JSON.parse(session.snapshot ?? 'null') as { v: 1; queue: QueueState }
    // b is gone from the stored queue (say the catalog mode hides it now).
    const queue = {
      ...snapshot.queue,
      items: snapshot.queue.items.filter((item) => item.track.title !== 'b'),
    }
    const second = nativeSetup({
      fake: { session: { ...session, snapshot: JSON.stringify({ v: 1, queue }) } },
    })
    const connection = await second.connect()
    expect(connection.resumed).toBe(true)
    await settle()
    expect(second.current()).toBe('c')
    expect(second.player.getState().status).not.toBe('paused')
    expect(second.native()[0]).toBe('c')
  })

  /**
   * A page in Music + Video mode that played three videos until Media3 moved on to v2 at 30 s,
   * and then died; with `switchToMusic`, the user switched to Music mode while v2 played, which
   * keeps v2 and drops the other videos (`setQueueMode`).
   */
  async function diedOnVideo(switchToMusic: boolean) {
    const first = nativeSetup({ player: { queue: { mode: 'all' } } })
    await first.connect()
    await first.player.setQueue(
      ['v1', 'v2', 'v3'].map((name) => testTrack(name, { kind: 'video' })),
    )
    await settle()
    first.plugin.ready()
    first.plugin.advance()
    await settle()
    if (switchToMusic) first.player.setCatalogMode('music')
    await settle()
    first.plugin.progress(30_000, 200_000)
    const session = await first.plugin.attach()
    first.plugin.detach()
    return session
  }

  it.each([
    ['restored into Music mode', false],
    ['after a switch to Music mode while one played', true],
  ])(
    'lets Media3 go when the catalog mode hides every stored item: videos %s',
    async (_name, switchToMusic) => {
      const session = await diedOnVideo(switchToMusic)
      expect(session).toMatchObject({ playWhenReady: true, positionMs: 30_000 })
      expect(session.entries[0]?.metadata.title).toBe('v2')
      const stored = JSON.parse(session.snapshot ?? 'null') as { queue: QueueState }
      expect(stored.queue.mode).toBe(switchToMusic ? 'music' : 'all')
      // The page comes back in Music mode, which hides every video.
      const second = nativeSetup({ fake: { session } })
      const before = second.player.getState()
      const connection = await second.connect()
      expect(connection.resumed).toBe(false)
      await settle()
      // The player is as it was, ready for the app's own restore, and Media3 let go of the video
      // the player could neither show nor stop.
      expect(second.player.getState()).toBe(before)
      expect(second.plugin.calls).toContain('release')
      expect(second.plugin.state.playWhenReady).toBe(false)
      expect(second.plugin.entries).toEqual([])
      // The app restores its own queue: playing and pausing in the app drive Media3.
      await second.player.setQueue(testTracks('x', 'y'))
      second.plugin.ready()
      await settle()
      expect(second.native()[0]).toBe('x')
      expect(second.plugin.state.playWhenReady).toBe(true)
      second.player.pause()
      await settle()
      expect(second.plugin.state.playWhenReady).toBe(false)
    },
  )

  it('takes Media3’s entry over when the app restored the same queue first', async () => {
    const session = await diedOnB()
    const snapshot = JSON.parse(session.snapshot ?? 'null') as { v: 1; queue: QueueState }
    const second = nativeSetup({ fake: { session } })
    // The app restores its own saved copy of the queue before connecting, against the docs.
    second.player.restore({ ...snapshot.queue, index: 1 }, 12_000)
    const connection = await second.connect()
    expect(connection.resumed).toBe(true)
    await settle()
    expect(second.current()).toBe('b')
    expect(second.player.getState().status).toBe('playing')
    expect(second.plugin.calls.some((call) => call.startsWith('load'))).toBe(false)
    expect(second.plugin.calls.some((call) => call.startsWith('seek'))).toBe(false)
  })

  it('releases Media3 when the app restored another queue first', async () => {
    const session = await diedOnB()
    const second = nativeSetup({ fake: { session } })
    await second.player.setQueue(testTracks('x', 'y'), { autoplay: false })
    const connection = await second.connect()
    expect(connection.resumed).toBe(false)
    await settle()
    expect(second.plugin.calls).toContain('release')
    expect(second.plugin.state.playWhenReady).toBe(false)
    // Pausing and playing in the app now drive Media3.
    await second.player.play()
    second.plugin.ready()
    await settle()
    expect(second.native()[0]).toBe('x')
    second.player.pause()
    await settle()
    expect(second.plugin.state.playWhenReady).toBe(false)
  })

  it('pauses Media3 when the app restores a queue after connecting without a snapshot', async () => {
    const session = await diedOnB()
    const second = nativeSetup({ fake: { session: { ...session, snapshot: null } } })
    const connection = await second.connect()
    expect(connection.resumed).toBe(false)
    second.player.restore({ items: [] }, 0)
    await second.player.setQueue(testTracks('x'), { autoplay: false })
    await settle()
    expect(second.plugin.state.playWhenReady).toBe(false)
  })

  it('never plays an entry for another track that reuses its uid', async () => {
    const { plugin, player, connect, native } = nativeSetup()
    await connect()
    await player.setQueue(testTracks('a', 'b', 'c'))
    await settle()
    plugin.ready()
    player.pause()
    await settle()
    // A restored queue numbers its items as it was saved: uid 1 is now z, not b.
    const z = testTracks('y', 'z', 'w')
    player.restore({
      items: z.map((track, uid) => ({ uid, track })),
      index: 0,
      playedUids: [],
      mode: 'music',
      repeat: 'off',
      shuffle: false,
      nextUid: 3,
    })
    await settle()
    await player.next()
    await settle()
    expect(native()[0]).not.toBe('b')
    plugin.systemPlay(true)
    plugin.ready()
    await settle()
    expect(native()[0]).toBe('z')
  })

  it('keeps a snapshot of the queue in Media3, trimmed around the current item', async () => {
    const { plugin, player, connect } = nativeSetup()
    await connect()
    const tracks = Array.from({ length: 450 }, (_, index) => testTrack(`t${index}`))
    await player.setQueue(tracks, { startIndex: 300, autoplay: false })
    await settle()
    const saved = JSON.parse(plugin.snapshot ?? 'null') as { v: number; queue: QueueState }
    expect(saved.v).toBe(1)
    expect(saved.queue.items).toHaveLength(400)
    expect(currentQueueItem(saved.queue)?.track.title).toBe('t300')
  })
})
