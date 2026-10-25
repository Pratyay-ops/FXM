// @vitest-environment happy-dom
import { Player, StreamLifecycle } from '@fxm/player'
import {
  FAKE_URL_LIFETIME_MS,
  FakeEngine,
  FakeResolver,
  FakeStreamSource,
  ladderStreams,
  testContext,
  testStream,
  testTracks,
} from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopPlayback,
  DESKTOP_PLAYER_OPTIONS,
  DESKTOP_URL_REFRESH_MARGIN_MS,
  type DesktopEnvironment,
  type DesktopShell,
  type LockManagerLike,
  type MediaAction,
  type NowPlaying,
} from './index'

const HOUR = 60 * 60_000
const START = Date.UTC(2026, 9, 26)

/** A shell that answers `environment`, records the tray and sends native events on request. */
function fakeShell(environment: Promise<DesktopEnvironment>) {
  const shown: NowPlaying[] = []
  const media = new Set<(action: MediaAction) => void>()
  const network = new Set<() => void>()
  const shell: DesktopShell = {
    environment: () => environment,
    setNowPlaying: async (now) => {
      shown.push(now)
    },
    onMediaAction(listener) {
      media.add(listener)
      return () => media.delete(listener)
    },
    onNetworkChange(listener) {
      network.add(listener)
      return () => network.delete(listener)
    },
  }
  return {
    shell,
    shown,
    click: (action: MediaAction) => {
      for (const listener of media) listener(action)
    },
    networkChanged: () => {
      for (const listener of network) listener()
    },
    listeners: () => media.size + network.size,
  }
}

function fakeLocks() {
  let held = 0
  const locks: LockManagerLike = {
    async request(_name, _options, callback) {
      held += 1
      try {
        await callback()
      } finally {
        held -= 1
      }
    },
  }
  return { locks, held: () => held }
}

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers({ now: START })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createDesktopPlayback', () => {
  it('learns where the app runs, and its engine plays AAC on macOS 14', async () => {
    const mac14: DesktopEnvironment = { os: 'macos', osVersion: '14.7.1', tray: true }
    const desktop = createDesktopPlayback({ shell: fakeShell(Promise.resolve(mac14)).shell })
    expect(desktop.environment()).toBeUndefined()
    await expect(desktop.ready).resolves.toEqual(mac14)
    expect(desktop.environment()).toEqual(mac14)
    const engine = desktop.createEngine({
      createAudio: () => {
        const audio = document.createElement('audio')
        audio.canPlayType = () => 'probably'
        return audio
      },
    })
    const [opus, aac] = ladderStreams('song', { rung: 'top', fullLength: 'verified', serial: 1 })
    expect(opus && engine.canPlay(opus)).toBe('maybe')
    expect(aac && engine.canPlay(aac)).toBe('probably')
    engine.destroy()
  })

  it('reports a shell that can’t say where the app runs, and carries on', async () => {
    const onError = vi.fn()
    const desktop = createDesktopPlayback({
      shell: fakeShell(Promise.reject(new Error('no command'))).shell,
      onError,
    })
    await expect(desktop.ready).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(new Error('no command'))
  })

  it('connects the tray and the Web Lock to the player, and disconnects both', async () => {
    const fake = fakeShell(Promise.resolve({ os: 'windows', tray: true }))
    const { locks, held } = fakeLocks()
    const desktop = createDesktopPlayback({ shell: fake.shell, locks })
    const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    const disconnect = desktop.connect(player)
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    expect(fake.shown.at(-1)).toEqual({ playing: true, title: 'a', artist: 'a artist' })
    expect(held()).toBe(1)
    fake.click('toggle')
    await settle()
    expect(player.getState().status).toBe('paused')
    expect(held()).toBe(0)
    disconnect()
    expect(fake.shown.at(-1)).toEqual({ playing: false })
  })

  it('moves the lifecycle to a new network when the shell says so, until disposed', () => {
    const fake = fakeShell(Promise.resolve({ os: 'linux', tray: false }))
    const desktop = createDesktopPlayback({ shell: fake.shell, target: new EventTarget() })
    const { network, refreshBeforeExpiryMs } = desktop.lifecycleOptions
    expect(refreshBeforeExpiryMs).toBe(DESKTOP_URL_REFRESH_MARGIN_MS)
    const before = network.id
    fake.networkChanged()
    expect(network.id).not.toBe(before)
    desktop.dispose()
    expect(fake.listeners()).toBe(0)
  })
})

describe('re-resolving after about 5 hours', () => {
  it('keeps a one-hour margin before the 6-hour expiry of YouTube’s URLs', () => {
    expect(DESKTOP_URL_REFRESH_MARGIN_MS).toBe(HOUR)
    expect(DESKTOP_PLAYER_OPTIONS).toEqual({ refreshBeforeExpiryMs: HOUR })
    expect(FAKE_URL_LIFETIME_MS - DESKTOP_URL_REFRESH_MARGIN_MS).toBe(5 * HOUR)
  })

  it('refreshes a paused stream once it is about 5 hours old, before it plays again', async () => {
    const engine = new FakeEngine()
    const resolver = new FakeResolver((item, request) => ({
      stream: testStream(`${item.track.title}-${request.reason}`, {
        expiresAt: Date.now() + FAKE_URL_LIFETIME_MS,
      }),
    }))
    const player = new Player({ ...DESKTOP_PLAYER_OPTIONS, engine, resolver })
    await player.setQueue(testTracks('a'))
    player.pause()
    await settle(4 * HOUR + 55 * 60_000)
    await player.play()
    player.pause()
    expect(resolver.log).toEqual(['a:play#0'])
    await settle(10 * 60_000)
    await player.play()
    await settle()
    expect(resolver.log).toEqual(['a:play#0', 'a:refresh#0'])
    expect(player.getState().status).toBe('playing')
  })

  it('hands out a cached URL for about 5 hours, then resolves the song again', async () => {
    const youtube = new FakeStreamSource({ now: () => Date.now() })
    const desktop = createDesktopPlayback({
      shell: fakeShell(Promise.resolve({ os: 'windows', tray: true })).shell,
      target: new EventTarget(),
    })
    const lifecycle = new StreamLifecycle({
      sources: [youtube],
      context: () => testContext('full'),
      now: () => Date.now(),
      ...desktop.lifecycleOptions,
    })
    const player = new Player({
      ...desktop.playerOptions,
      engine: new FakeEngine(),
      resolver: lifecycle,
    })
    lifecycle.attach(player)
    const playSong = async () => {
      await player.setQueue(testTracks('song'))
      await settle()
      player.stop()
    }
    await playSong()
    await settle(4 * HOUR + 50 * 60_000)
    await playSong()
    expect(youtube.callsFor('song')).toBe(1)
    await settle(20 * 60_000)
    await playSong()
    expect(youtube.callsFor('song')).toBe(2)
    desktop.dispose()
  })
})
