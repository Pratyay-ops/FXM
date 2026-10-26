import {
  type AudioEffectsSettings,
  currentQueueItem,
  DEFAULT_AUDIO_EFFECTS,
  equalizerPreset,
} from '@fxm/core'
import { type DisposableNetworkMonitor, type Engine, NativeEngine, Player } from '@fxm/player'
import {
  createFakeFxmPlayer,
  FakeEngine,
  type FakeFxmPlayer,
  FakeResolver,
  testStream,
  testTrack,
  testTracks,
} from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AndroidEngine } from './android-engine'

/** Lets pending promises and zero-delay timers run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

/** What the Android plugin answers while Media3's service can't be bound. */
function unavailable(): Error {
  return Object.assign(new Error('The player service is not available'), { code: 'UNAVAILABLE' })
}

/**
 * A plugin whose service can't be bound, as `FxmPlayerPlugin` answers then: every call is
 * refused, `load` only once the test calls `release` (an answer still on its way).
 */
function unboundPlugin(): { plugin: FakeFxmPlayer; release: () => void } {
  const plugin = createFakeFxmPlayer()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  plugin.attach = async () => {
    throw unavailable()
  }
  plugin.load = async () => {
    await gate
    throw unavailable()
  }
  plugin.play = async () => {
    throw unavailable()
  }
  return { plugin, release }
}

/** A network monitor whose changes the test makes. */
function fakeNetwork(): DisposableNetworkMonitor & { change(): void; destroyed: boolean } {
  const listeners = new Set<() => void>()
  let id = 0
  return {
    get id() {
      return `web-${id}`
    },
    cellular: false,
    destroyed: false,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    change() {
      id += 1
      for (const listener of [...listeners]) listener()
    },
    destroy() {
      this.destroyed = true
      listeners.clear()
    },
  }
}

/** An {@link AndroidEngine} over `plugin`, falling back to a `FakeEngine`. */
function androidEngine(plugin: FakeFxmPlayer) {
  const fallback = new FakeEngine()
  const createFallback = vi.fn((): Engine => fallback)
  const network = fakeNetwork()
  const native = new NativeEngine({ plugin, origin: 'https://localhost' })
  const engine = new AndroidEngine(native, { createFallback, createNetwork: () => network })
  return { native, engine, fallback, createFallback, network }
}

/** The real player facade on an {@link AndroidEngine}, wired as the app does it. */
function androidPlayer(plugin: FakeFxmPlayer) {
  const setup = androidEngine(plugin)
  const resolver = new FakeResolver()
  const player = new Player({
    engine: setup.engine,
    resolver: setup.engine.wrapResolver(resolver),
    retryDelaysMs: [0],
    stallTimeoutMs: 0,
  })
  return { ...setup, resolver, player }
}

/** A source for the engine: track `title`'s test stream, as queue item `uid`. */
function source(title: string, uid: number) {
  return { stream: testStream(title), item: { uid, track: testTrack(title) } }
}

const titleOf = (player: Player) => currentQueueItem(player.getState().queue)?.track.title

const ROCK = equalizerPreset('rock').gainsDb

/** Audio effects the user chose (stage 8.1): the rock preset, a little faster. */
const ROCK_FASTER: AudioEffectsSettings = {
  ...DEFAULT_AUDIO_EFFECTS,
  equalizer: { enabled: true, gainsDb: ROCK, preset: 'rock' },
  playbackRate: 1.25,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AndroidEngine', () => {
  it('plays through Media3 while its service is there', async () => {
    const plugin = createFakeFxmPlayer()
    const { native, engine, fallback, createFallback, player, resolver } = androidPlayer(plugin)
    const connection = await engine.connect({ player, resolver })
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    plugin.ready()
    plugin.progress(1_000, 200_000)
    await settle()
    expect(plugin.calls.some((call) => call.startsWith('load:a'))).toBe(true)
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 1_000 })
    expect(createFallback).not.toHaveBeenCalled()
    expect(fallback.calls).toEqual([])
    expect(engine.native).toBe(native)
    // Android's own network callbacks, for the stream lifecycle.
    const changes: boolean[] = []
    engine.network.subscribe(() => changes.push(engine.network.cellular))
    plugin.changeNetwork(true)
    expect(changes).toEqual([true])
    connection.disconnect()
    player.destroy()
    expect(plugin.calls.at(-1)).toBe('release')
  })

  it('moves the same player to the direct audio engine when the service is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { plugin, release } = unboundPlugin()
    const { engine, fallback, network, player, resolver } = androidPlayer(plugin)
    player.setVolume(0.4)
    player.setMuted(true)
    const changes: string[] = []
    engine.network.subscribe(() => changes.push(engine.network.id))
    // The user pressed play before Media3's service answered.
    void player.setQueue(testTracks('a', 'b'))
    await expect(engine.connect({ player, resolver })).rejects.toMatchObject({
      code: 'Unavailable',
    })
    // The refused load arrives after the fall back: it no longer counts.
    release()
    await settle()

    // What the player waited for plays in the WebView now, with the same volume.
    expect(fallback.source?.item?.track.title).toBe('a')
    expect(fallback).toMatchObject({ volume: 0.4, muted: true, paused: false })
    expect(player.getState().status).toBe('playing')
    expect(engine.native).toBeUndefined()
    // The native engine let go of the plugin.
    expect(plugin.listeners).toBe(0)
    // The stream lifecycle follows the WebView's network events from now on.
    expect(changes).toEqual(['web-0'])
    network.change()
    expect(changes).toEqual(['web-0', 'web-1'])

    // The next track plays there too, resolved without the native engine's wrapper.
    fallback.end()
    await settle()
    expect(titleOf(player)).toBe('b')
    expect(fallback.source?.item?.track.title).toBe('b')
    expect(player.getState().status).toBe('playing')
    player.destroy()
    expect(fallback.destroyed).toBe(true)
    expect(network.destroyed).toBe(true)
  })

  it('hands the audio effects and the sleep timer to Media3 while its service is there', async () => {
    const plugin = createFakeFxmPlayer()
    const { engine, player, resolver } = androidPlayer(plugin)
    const connection = await engine.connect({ player, resolver })
    player.setAudioEffects(ROCK_FASTER)
    player.setSleepTimer({ endOfTrack: true })
    await settle()
    expect(plugin.calls.filter((call) => call.startsWith('setEffects')).at(-1)).toBe(
      `setEffects:eq=${ROCK.join(',')} loudness=-14 speed=1.25`,
    )
    // Media3 keeps the sleep timer's time, also while the page doesn't run.
    expect(plugin.calls).toContain('setSleepTimer:end')
    expect(player.getState().playbackRate).toBe(1.25)
    // No crossfade there: the player crosses tracks gapless.
    expect(player.effectsSupport()).toEqual({
      effects: true,
      playbackRate: true,
      crossfade: false,
      volume: true,
    })
    connection.disconnect()
    player.destroy()
  })

  it('carries the audio effects over to the direct audio engine, which crossfades', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { plugin } = unboundPlugin()
    const { engine, fallback, player, resolver } = androidPlayer(plugin)
    player.setAudioEffects(ROCK_FASTER)
    await expect(engine.connect({ player, resolver })).rejects.toMatchObject({
      code: 'Unavailable',
    })

    // The player set them on Media3, once: the WebView's engine has them too.
    expect(fallback.effects).toEqual({
      equalizer: ROCK_FASTER.equalizer,
      loudness: ROCK_FASTER.loudness,
    })
    expect(fallback.playbackRate).toBe(1.25)
    expect(player.getState().effects.equalizer).toBe('on')
    // It crossfades and fades, and leaves the sleep timer's time to the player.
    expect(player.effectsSupport()).toEqual({
      effects: true,
      playbackRate: true,
      crossfade: true,
      volume: true,
    })
    expect(engine.setSleepTimer).toBeUndefined()
    engine.fadeOutput?.(0.5, 0)
    expect(fallback.outputGain).toBe(0.5)
    player.destroy()
  })

  it('loads what the player waits for where it had got to, and plays it if it played', async () => {
    const plugin = createFakeFxmPlayer()
    const { engine, fallback } = androidEngine(plugin)
    engine.setVolume(0.7)
    await engine.load(source('a', 1))
    await engine.play()
    plugin.ready()
    plugin.progress(5_000, 200_000)
    await settle()
    engine.fallBack()
    await settle()
    expect(fallback.calls.map((call) => call.method)).toEqual([
      'setVolume',
      'setMuted',
      'load',
      'play',
    ])
    expect(fallback.calls[2]?.args).toEqual([source('a', 1), 5_000])
    expect(fallback.paused).toBe(false)
    engine.destroy()

    // Paused at 1 s: loaded again there, and not played.
    const paused = androidEngine(createFakeFxmPlayer())
    await paused.engine.load(source('b', 2))
    paused.engine.seek(1_000)
    paused.engine.fallBack()
    await settle()
    expect(
      paused.fallback.calls.filter((call) => call.method === 'load' || call.method === 'play'),
    ).toEqual([{ method: 'load', args: [source('b', 2), 1_000] }])
    paused.engine.destroy()
  })

  it('leaves a load that failed or ended to the player', async () => {
    const failing = createFakeFxmPlayer()
    const failed = androidEngine(failing)
    const failures: string[] = []
    failed.engine.on('error', (error) => failures.push(error.type))
    await failed.engine.load(source('a', 1))
    await failed.engine.play()
    failing.ready()
    failing.fail()
    await settle()
    expect(failures).toEqual(['network'])
    failed.engine.fallBack()
    await settle()
    // The player heard the failure and resolves the song again itself: nothing to load here.
    expect(failed.fallback.count('load')).toBe(0)
    failed.engine.destroy()

    const plugin = createFakeFxmPlayer()
    const ended = androidEngine(plugin)
    const ends: string[] = []
    ended.engine.on('ended', () => ends.push('ended'))
    await ended.engine.load(source('b', 2))
    await ended.engine.play()
    plugin.ready()
    plugin.end()
    await settle()
    expect(ends).toEqual(['ended'])
    ended.engine.fallBack()
    await settle()
    expect(ended.fallback.count('load')).toBe(0)
    expect(ended.fallback.count('play')).toBe(0)
    ended.engine.destroy()
  })

  it('carries over what was preloaded, and asks the engine it plays through', () => {
    const { engine, fallback } = androidEngine(createFakeFxmPlayer())
    const next = source('n', 2)
    engine.preload(next)
    fallback.canPlayStream = () => 'no'
    expect(engine.canPlay(next.stream)).toBe('probably')
    engine.fallBack()
    expect(fallback.preloaded).toBe(next)
    expect(engine.canPlay(next.stream)).toBe('no')
    engine.unlock()
    expect(fallback.calls.at(-1)?.method).toBe('unlock')
    engine.destroy()
  })

  it('falls back once, and not at all once destroyed', async () => {
    const once = androidEngine(createFakeFxmPlayer())
    once.engine.fallBack()
    once.engine.fallBack()
    expect(once.createFallback).toHaveBeenCalledTimes(1)
    // Nothing is left to connect.
    const player = new Player({ engine: once.engine, resolver: new FakeResolver() })
    await expect(
      once.engine.connect({ player, resolver: new FakeResolver() }),
    ).rejects.toMatchObject({ code: 'Unavailable' })
    player.destroy()
    expect(once.fallback.destroyed).toBe(true)

    const destroyed = androidEngine(createFakeFxmPlayer())
    destroyed.engine.destroy()
    destroyed.engine.fallBack()
    expect(destroyed.createFallback).not.toHaveBeenCalled()
  })
})
