import type { NetworkCapabilities } from '@fxm/core'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCapabilityMonitor,
  detectCapabilities,
  resolveCapabilities,
  sameCapabilities,
} from './capabilities'
import {
  type ConnectClient,
  type ConnectStatus,
  type ConnectWindow,
  createConnectClient,
} from './connect'
import { createLiteTier, type KillSwitches } from './lite'
import { memoryStorage } from './storage'
import { FAKE_CONNECT_FEATURES, installFakeConnect } from './testing/fake-connect'
import { createFakeSandbox } from './testing/fake-sandbox'

const ALL = [...FAKE_CONNECT_FEATURES]
const present = (features: readonly string[] = ALL): ConnectStatus => ({
  state: 'present',
  version: '0.1.0',
  features,
})

const NONE: NetworkCapabilities = {
  youtube: 'none',
  mediaBytes: false,
  spotify: 'unreachable',
  fileSystem: false,
}

describe('resolveCapabilities', () => {
  it.each<[string, Parameters<typeof resolveCapabilities>[0], NetworkCapabilities]>([
    ['a plain page', { platform: 'web' }, NONE],
    ['a page in the Lite tier', { platform: 'web', lite: true }, { ...NONE, youtube: 'simple' }],
    [
      'a page with FXM Connect',
      { platform: 'web', connect: present() },
      { youtube: 'full', mediaBytes: true, spotify: 'anonymous', fileSystem: false },
    ],
    [
      'FXM Connect with the Spotify login on',
      { platform: 'web', connect: present([...ALL, 'spotify-login']) },
      { youtube: 'full', mediaBytes: true, spotify: 'account', fileSystem: false },
    ],
    [
      'FXM Connect without the googlevideo rules',
      { platform: 'web', connect: present(['youtube', 'spotify']) },
      { youtube: 'full', mediaBytes: false, spotify: 'anonymous', fileSystem: false },
    ],
    [
      'FXM Connect with Spotify only, in the Lite tier',
      { platform: 'web', connect: present(['spotify']), lite: true },
      { youtube: 'simple', mediaBytes: false, spotify: 'anonymous', fileSystem: false },
    ],
    [
      'an outdated FXM Connect',
      { platform: 'web', connect: { ...present(), state: 'outdated' } },
      NONE,
    ],
    [
      'a missing FXM Connect, in the Lite tier',
      { platform: 'web', connect: { state: 'missing', features: [] }, lite: true },
      { ...NONE, youtube: 'simple' },
    ],
    [
      'the desktop app',
      { platform: 'desktop', nativeTransport: true },
      { youtube: 'full', mediaBytes: true, spotify: 'anonymous', fileSystem: true },
    ],
    [
      'the Android app with a Spotify login source',
      { platform: 'android', nativeTransport: true, nativeSpotifyLogin: true },
      { youtube: 'full', mediaBytes: true, spotify: 'account', fileSystem: true },
    ],
    [
      'a native app before its native transport exists',
      { platform: 'desktop', lite: true, connect: present() },
      { ...NONE, fileSystem: true },
    ],
    [
      'a page that may write files',
      { platform: 'web', fileSystem: true },
      { ...NONE, fileSystem: true },
    ],
  ])('%s', (_case, inputs, expected) => {
    const capabilities = resolveCapabilities(inputs)
    expect(capabilities).toEqual(expected)
    if (capabilities.youtube !== 'full') expect(capabilities.mediaBytes).toBe(false)
  })
})

describe('sameCapabilities', () => {
  it('compares every field', () => {
    expect(sameCapabilities(NONE, { ...NONE })).toBe(true)
    expect(sameCapabilities(NONE, { ...NONE, youtube: 'simple' })).toBe(false)
    expect(sameCapabilities(NONE, { ...NONE, spotify: 'anonymous' })).toBe(false)
    expect(sameCapabilities(NONE, { ...NONE, fileSystem: true })).toBe(false)
  })
})

/** A ConnectClient stand-in whose status the test sets. */
function stubConnect(initial: ConnectStatus) {
  let status = initial
  const listeners = new Set<(status: ConnectStatus) => void>()
  const detect = vi.fn(async () => status)
  const client = {
    get status() {
      return status
    },
    detect,
    subscribe(listener: (status: ConnectStatus) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as ConnectClient
  return {
    client,
    detect,
    set(next: ConnectStatus) {
      status = next
      for (const listener of listeners) listener(next)
    },
    listeners,
  }
}

describe('detectCapabilities', () => {
  it('looks for FXM Connect first and skips the Lite self-test when it gives full access', async () => {
    const connect = stubConnect(present())
    const sandbox = createFakeSandbox()
    const capabilities = await detectCapabilities({
      platform: 'web',
      connect: connect.client,
      lite: createLiteTier({ sandbox }),
    })
    expect(capabilities.youtube).toBe('full')
    expect(connect.detect).toHaveBeenCalledOnce()
    expect(sandbox.selfTests).toBe(0)
  })

  it('reports the Lite tier once its self-test passes', async () => {
    const connect = stubConnect({ state: 'absent', features: [] })
    const capabilities = await detectCapabilities({
      platform: 'web',
      connect: connect.client,
      lite: createLiteTier({ sandbox: createFakeSandbox() }),
    })
    expect(capabilities).toEqual({ ...NONE, youtube: 'simple' })
  })

  it('reports no YouTube when the self-test fails or the kill switch is on', async () => {
    const failing = await detectCapabilities({
      platform: 'web',
      lite: createLiteTier({ sandbox: createFakeSandbox({ selfTest: false }) }),
    })
    expect(failing.youtube).toBe('none')
    const killed = await detectCapabilities({
      platform: 'web',
      lite: createLiteTier({ sandbox: createFakeSandbox(), killSwitches: () => ({ lite: true }) }),
    })
    expect(killed.youtube).toBe('none')
  })

  it('treats a failing detection as no FXM Connect', async () => {
    const broken = {
      detect: async () => {
        throw new Error('broken')
      },
      subscribe: () => () => {},
    } as unknown as ConnectClient
    expect(await detectCapabilities({ platform: 'web', connect: broken })).toEqual(NONE)
  })

  it('needs no detection on native platforms', async () => {
    const connect = stubConnect(present())
    expect(
      await detectCapabilities({
        platform: 'android',
        nativeTransport: true,
        connect: connect.client,
      }),
    ).toMatchObject({ youtube: 'full', spotify: 'anonymous' })
    expect(connect.detect).not.toHaveBeenCalled()
  })
})

describe('createCapabilityMonitor', () => {
  it('starts from nothing found, and refreshes', async () => {
    const connect = stubConnect(present())
    const monitor = createCapabilityMonitor({ platform: 'web', connect: connect.client })
    expect(monitor.current).toEqual(NONE)
    const seen: NetworkCapabilities[] = []
    monitor.subscribe((capabilities) => seen.push(capabilities))
    await expect(monitor.refresh()).resolves.toMatchObject({ youtube: 'full' })
    expect(monitor.current.youtube).toBe('full')
    await monitor.refresh()
    expect(seen).toHaveLength(1)
  })

  it('shares one refresh among concurrent callers', async () => {
    const connect = stubConnect(present())
    const monitor = createCapabilityMonitor({ platform: 'web', connect: connect.client })
    const first = monitor.refresh()
    expect(monitor.refresh()).toBe(first)
    await first
    expect(connect.detect).toHaveBeenCalledOnce()
  })

  it('follows FXM Connect when it appears or goes away', async () => {
    const connect = stubConnect({ state: 'absent', features: [] })
    const sandbox = createFakeSandbox()
    const monitor = createCapabilityMonitor({
      platform: 'web',
      connect: connect.client,
      lite: createLiteTier({ sandbox }),
    })
    await monitor.refresh()
    expect(monitor.current.youtube).toBe('simple')
    const seen: string[] = []
    monitor.subscribe((capabilities) => seen.push(capabilities.youtube))
    connect.set(present())
    await vi.waitFor(() => expect(monitor.current.youtube).toBe('full'))
    connect.set({ state: 'missing', features: [], lastSeenVersion: '0.1.0' })
    await vi.waitFor(() => expect(monitor.current.youtube).toBe('simple'))
    expect(seen).toEqual(['full', 'simple'])
    expect(sandbox.selfTests).toBe(1)
  })

  it('lets the newest evaluation win', async () => {
    const connect = stubConnect({ state: 'absent', features: [] })
    let releaseSelfTest: (pass: boolean) => void = () => {}
    const sandbox = createFakeSandbox({
      selfTest: () =>
        new Promise<boolean>((resolve) => {
          releaseSelfTest = resolve
        }),
    })
    const monitor = createCapabilityMonitor({
      platform: 'web',
      connect: connect.client,
      lite: createLiteTier({ sandbox }),
    })
    const refresh = monitor.refresh()
    await vi.waitFor(() => expect(sandbox.selfTests).toBe(1))
    connect.set(present())
    await vi.waitFor(() => expect(monitor.current.youtube).toBe('full'))
    releaseSelfTest(true)
    await expect(refresh).resolves.toMatchObject({ youtube: 'full' })
    expect(monitor.current.youtube).toBe('full')
  })

  it('picks up a changed kill switch on refresh', async () => {
    let switches: KillSwitches = {}
    const monitor = createCapabilityMonitor({
      platform: 'web',
      lite: createLiteTier({ sandbox: createFakeSandbox(), killSwitches: () => switches }),
    })
    expect((await monitor.refresh()).youtube).toBe('simple')
    switches = { lite: true }
    expect((await monitor.refresh()).youtube).toBe('none')
  })

  it('survives a failing listener and stops when disposed', async () => {
    const connect = stubConnect({ state: 'absent', features: [] })
    const monitor = createCapabilityMonitor({ platform: 'web', connect: connect.client })
    const seen: string[] = []
    monitor.subscribe(() => {
      throw new Error('broken listener')
    })
    const unsubscribe = monitor.subscribe((capabilities) => seen.push(capabilities.youtube))
    connect.set(present())
    await vi.waitFor(() => expect(seen).toEqual(['full']))
    unsubscribe()
    monitor.dispose()
    expect(connect.listeners.size).toBe(0)
    connect.set({ state: 'absent', features: [] })
    await monitor.refresh()
    expect(monitor.current.youtube).toBe('full')
  })

  it('reports native platforms without watching anything', async () => {
    const monitor = createCapabilityMonitor({ platform: 'desktop', nativeTransport: true })
    expect(monitor.current.youtube).toBe('full')
    await expect(monitor.refresh()).resolves.toMatchObject({ youtube: 'full', fileSystem: true })
  })
})

describe('on a page with a fake FXM Connect', () => {
  const pages: { happyDOM: { close(): Promise<void> } }[] = []
  afterEach(async () => {
    await Promise.all(pages.splice(0).map((page) => page.happyDOM.close()))
  })

  it('goes from the Lite tier to full access when FXM Connect is installed', async () => {
    const window = new Window({ url: 'https://fxm-music.pages.dev/app/' })
    pages.push(window)
    const page = window as unknown as ConnectWindow
    const connect = createConnectClient({ window: page, storage: memoryStorage() })
    const monitor = createCapabilityMonitor({
      platform: 'web',
      connect,
      lite: createLiteTier({ sandbox: createFakeSandbox() }),
    })
    expect(await monitor.refresh()).toEqual({ ...NONE, youtube: 'simple' })
    installFakeConnect(page, { features: [...ALL, 'spotify-login'] })
    await vi.waitFor(() =>
      expect(monitor.current).toEqual({
        youtube: 'full',
        mediaBytes: true,
        spotify: 'account',
        fileSystem: false,
      }),
    )
    monitor.dispose()
    connect.dispose()
  })
})
