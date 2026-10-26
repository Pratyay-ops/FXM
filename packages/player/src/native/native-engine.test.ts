import { FxmError, httpStatusOf, isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { EngineError } from '../engine'
import { Player } from '../player'
import { FakeEngine } from '../testing/fake-engine'
import { createFakeFxmPlayer } from '../testing/fake-fxm-player'
import { FakeResolver } from '../testing/fake-resolver'
import { testStream, testTrack, testTracks } from '../testing/fixtures'
import { NativeEngine } from './native-engine'
import { nativeSetup, settle } from './test-harness'

describe('NativeEngine', () => {
  it('attaches and listens before it sends anything, then keeps the order of the calls', async () => {
    const plugin = createFakeFxmPlayer()
    const engine = new NativeEngine({ plugin })
    engine.setVolume(0.5)
    engine.setMuted(true)
    engine.setMuted(false)
    await settle()
    expect(plugin.calls).toEqual(['attach', 'setVolume:0.5', 'setVolume:0', 'setVolume:0.5'])
    expect(plugin.listeners).toBe(6)
    engine.destroy()
  })

  it('also works with listeners the bridge registers at once', async () => {
    const plugin = createFakeFxmPlayer({ syncListeners: true })
    const engine = new NativeEngine({ plugin })
    await settle()
    expect(plugin.listeners).toBe(6)
    engine.destroy()
    expect(plugin.listeners).toBe(0)
  })

  it('needs the Android app’s plugin', () => {
    expect(NativeEngine.ifAvailable({})).toBeUndefined()
    try {
      new NativeEngine()
      expect.unreachable()
    } catch (error) {
      expect(isFxmError(error, 'Unsupported')).toBe(true)
    }
  })

  it('plays the player’s items on Media3 and reports what Media3 does', async () => {
    const { plugin, player, current } = nativeSetup()
    const changes: string[] = []
    player.subscribe((state) =>
      changes.push(`${state.status}${state.buffering ? '+buffering' : ''}`),
    )
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    expect(plugin.calls.filter((call) => call.startsWith('load') || call === 'play')).toEqual([
      'load:a@0+[]',
      'play',
    ])
    expect(current()).toBe('a')
    expect(player.getState().status).toBe('loading')
    plugin.ready()
    plugin.progress(12_000, 180_500)
    expect(player.getState()).toMatchObject({
      status: 'playing',
      positionMs: 12_000,
      durationMs: 180_500,
    })
    // The notification's pause button, then its play button.
    plugin.systemPlay(false)
    expect(player.getState().status).toBe('paused')
    plugin.systemPlay(true)
    expect(player.getState().status).toBe('playing')
    expect(changes).toContain('loading+buffering')
  })

  it('sends the facade’s pause, seek and volume', async () => {
    const { plugin, player } = nativeSetup()
    await player.setQueue(testTracks('a'))
    plugin.ready()
    await settle()
    player.seek(90_000)
    player.pause()
    player.setVolume(0.25)
    await settle()
    expect(plugin.calls.slice(-3)).toEqual(['seek:90000', 'pause', 'setVolume:0.25'])
  })

  it('reports Media3’s failures with their HTTP status, so the facade resolves afresh', async () => {
    const { plugin, player, resolver } = nativeSetup()
    await player.setQueue(testTracks('a', 'b'))
    plugin.ready()
    plugin.progress(42_000, 180_000)
    plugin.fail({ status: 403 })
    await settle()
    const retry = resolver.requestsFor('a').at(-1)
    expect(retry?.reason).toBe('retry')
    expect(retry?.failure?.error).toBeInstanceOf(EngineError)
    expect(retry?.failure?.error).toMatchObject({ type: 'network' })
    expect(httpStatusOf(retry?.failure?.error)).toBe(403)
    expect(retry?.failure).toMatchObject({ positionMs: 42_000, started: true })
    expect(retry?.failure?.stream?.url).toBe(testStream('a').url)
    // The fresh stream plays from where the failed one stopped.
    expect(plugin.calls.at(-2)).toBe('load:a@42000+[]')
    expect(plugin.calls.at(-1)).toBe('play')
  })

  it('reports an expired URL as expired', async () => {
    const { plugin, player, resolver } = nativeSetup()
    await player.setQueue(testTracks('a'))
    plugin.ready()
    plugin.fail({ type: 'expired', status: 403 })
    await settle()
    expect(resolver.requestsFor('a').at(-1)?.failure?.error).toMatchObject({ type: 'expired' })
  })

  it('moves the facade on when Media3 runs out of entries', async () => {
    const { plugin, player, current } = nativeSetup()
    const causes: string[] = []
    player.on('trackchange', ({ cause }) => causes.push(cause))
    await player.setQueue(testTracks('a', 'b'))
    plugin.ready()
    plugin.end()
    await settle()
    expect(current()).toBe('b')
    expect(causes).toEqual(['queue', 'ended'])
    expect(plugin.calls).toContain('load:b@0+[]')
  })

  it('reports a stream the plugin refuses as unsupported', async () => {
    const plugin = createFakeFxmPlayer()
    plugin.load = vi.fn(async () => {
      throw Object.assign(new Error('A source needs an absolute HTTPS URL'), {
        code: 'BAD_REQUEST',
      })
    })
    const engine = new NativeEngine({ plugin })
    const errors: EngineError[] = []
    engine.on('error', (error) => errors.push(error))
    await engine.load({ stream: testStream('a'), item: { uid: 1, track: testTrack('a') } })
    await settle()
    expect(errors.map((error) => error.type)).toEqual(['unsupported'])
    expect(errors[0]?.message).toContain('refused the stream')
    engine.destroy()
  })

  it('blames the native player, not the stream, when it is unavailable', async () => {
    const plugin = createFakeFxmPlayer()
    const unavailable = Object.assign(new Error('The player service is not available'), {
      code: 'UNAVAILABLE',
    })
    plugin.load = vi.fn(async () => {
      throw unavailable
    })
    plugin.play = vi.fn(async () => {
      throw Object.assign(new Error('The player failed'), { code: 'INTERNAL' })
    })
    const engine = new NativeEngine({ plugin })
    const errors: EngineError[] = []
    engine.on('error', (error) => errors.push(error))
    await engine.load({ stream: testStream('a'), item: { uid: 1, track: testTrack('a') } })
    await settle()
    expect(errors[0]).toMatchObject({ type: 'network', cause: unavailable })
    expect(errors[0]?.message).toContain('native player is not available')
    // A refused play arrives as an error of the loaded entry, as the Engine contract says.
    plugin.load = createFakeFxmPlayer().load
    await engine.play()
    expect(errors.map((error) => error.type)).toEqual(['network', 'network'])
    expect(errors[1]?.message).toContain('could not play (INTERNAL)')
    engine.destroy()
  })

  it('logs the commands the plugin refuses that nothing waits for', async () => {
    const plugin = createFakeFxmPlayer()
    const failure = Object.assign(new Error('The player failed'), { code: 'INTERNAL' })
    plugin.pause = vi.fn(async () => {
      throw failure
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const engine = new NativeEngine({ plugin })
    engine.pause()
    await settle()
    expect(errors).toHaveBeenCalledWith('FxmPlayer.pause failed', failure)
    errors.mockRestore()
    engine.destroy()
  })

  it('is the only engine on the plugin while it lives', () => {
    const plugin = createFakeFxmPlayer()
    const engine = new NativeEngine({ plugin })
    expect(() => new NativeEngine({ plugin })).toThrow(/Another NativeEngine/)
    const android = { Capacitor: { isNativePlatform: () => true, Plugins: { FxmPlayer: plugin } } }
    expect(() => NativeEngine.ifAvailable(android)).toThrow(/Another NativeEngine/)
    engine.destroy()
    const next = new NativeEngine({ plugin })
    expect(next).toBeInstanceOf(NativeEngine)
    next.destroy()
  })

  it('create() waits for the native player and says when it is unavailable', async () => {
    const plugin = createFakeFxmPlayer()
    const engine = await NativeEngine.create({ plugin })
    expect(engine).toBeInstanceOf(NativeEngine)
    expect(plugin.attached).toBe(true)
    engine?.destroy()
    expect(await NativeEngine.create()).toBeUndefined()
    const broken = createFakeFxmPlayer()
    broken.attach = async () => {
      throw Object.assign(new Error('The player service is not available'), {
        code: 'UNAVAILABLE',
      })
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await NativeEngine.create({ plugin: broken })).toBeUndefined()
    // Without releasing anything, and leaving the plugin free for the app's next try.
    expect(broken.calls).not.toContain('release')
    expect(broken.listeners).toBe(0)
    expect(new NativeEngine({ plugin: broken })).toBeInstanceOf(NativeEngine)
    errors.mockRestore()
  })

  it('connect rejects when the native player is unavailable, and leaves the player alone', async () => {
    const plugin = createFakeFxmPlayer()
    const unavailable = Object.assign(new Error('The player service is not available'), {
      code: 'UNAVAILABLE',
    })
    plugin.attach = async () => {
      throw unavailable
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const engine = new NativeEngine({ plugin })
    const resolver = new FakeResolver()
    const player = new Player({ engine, resolver: engine.wrapResolver(resolver) })
    const connecting = engine.connect({ player, resolver })
    // Asking again while it waits gets the same answer.
    expect(engine.connect({ player, resolver })).toBe(connecting)
    const error: unknown = await connecting.catch((reason: unknown) => reason)
    expect(isFxmError(error, 'Unavailable')).toBe(true)
    expect((error as Error).cause).toBe(unavailable)
    // No native queue or snapshots for a player that Media3 can't play for.
    await player.setQueue(testTracks('a', 'b'), { autoplay: false })
    await settle()
    expect(plugin.calls.filter((call) => /^(setUpcoming|saveSnapshot|ack)/.test(call))).toEqual([])
    errors.mockRestore()
    player.destroy()
  })

  it('connects once per player', async () => {
    const { engine, player, connect } = nativeSetup()
    const first = connect()
    expect(connect()).toBe(first)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const other = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    const refused = await engine.connect({ player: other, resolver: new FakeResolver() })
    expect(refused.resumed).toBe(false)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
    const connection = await first
    connection.disconnect()
    const again = await engine.connect({ player, resolver: new FakeResolver() })
    expect(again).not.toBe(connection)
    again.disconnect()
  })

  it('plays what Media3 can: progressive HTTPS streams, with or without headers', () => {
    const engine = new NativeEngine({ plugin: createFakeFxmPlayer() })
    expect(engine.canPlay(testStream('a'))).toBe('probably')
    expect(
      engine.canPlay(testStream('a', { codec: 'aac', container: 'mp4', media: 'muxed-video' })),
    ).toBe('probably')
    expect(
      engine.canPlay(testStream('a', { requestHeaders: { Referer: 'https://x.test/' } })),
    ).toBe('probably')
    expect(engine.canPlay(testStream('a', { codec: 'alac', container: 'm4a' }))).toBe('maybe')
    expect(engine.canPlay(testStream('a', { protocol: 'hls' }))).toBe('no')
    expect(engine.canPlay(testStream('a', { fullLength: 'capped' }))).toBe('no')
    expect(engine.canPlay(testStream('a', { url: 'http://media.test/a' }))).toBe('no')
    engine.destroy()
  })

  it('plays offline copies and the device’s music from the device', async () => {
    const plugin = createFakeFxmPlayer()
    const engine = new NativeEngine({ plugin, origin: 'https://localhost' })
    const copy = testStream('a', {
      url: 'https://localhost/_capacitor_file_/data/data/app/files/downloads/2f1c',
      fullLength: 'verified',
    })
    expect(engine.canPlay(copy)).toBe('probably')
    // A blob: URL is nothing Media3 can read.
    expect(engine.canPlay({ ...copy, url: 'blob:https://localhost/2f1c' })).toBe('no')
    await engine.load({ stream: copy, item: { uid: 1, track: testTrack('a') } })
    await settle()
    expect(plugin.entries[0]?.source).toEqual({
      kind: 'file',
      url: 'file:///data/data/app/files/downloads/2f1c',
    })
    engine.destroy()
  })

  it('without a connected player, leaves the system’s next and previous to Media3', async () => {
    const { plugin, player } = nativeSetup()
    await player.setQueue(testTracks('a', 'b'))
    plugin.ready()
    plugin.command('next')
    await settle()
    expect(plugin.calls).not.toContain('ack')
  })

  it('stops Media3 and lets go of the plugin when destroyed', async () => {
    const { plugin, player } = nativeSetup()
    await player.setQueue(testTracks('a'))
    await settle()
    player.destroy()
    await settle()
    expect(plugin.calls.at(-1)).toBe('release')
    expect(plugin.listeners).toBe(0)
  })

  it('without the plugin’s attach, still plays', async () => {
    const plugin = createFakeFxmPlayer()
    plugin.attach = async () => {
      throw new FxmError('Network', 'no bridge')
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const engine = new NativeEngine({ plugin })
    await engine.load({ stream: testStream('a'), item: { uid: 3, track: testTrack('a') } })
    expect(plugin.calls).toEqual(['load:a@0+[]'])
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
    engine.destroy()
  })
})
