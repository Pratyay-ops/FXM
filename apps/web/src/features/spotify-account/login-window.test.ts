import { FxmError } from '@fxm/core'
import { createAndroidSpotifyLogin, type SpotifyLoginWindow } from '@fxm/platform'
import {
  createFakeFxmSpotifyLogin,
  type FakeFxmSpotifyLoginOptions,
  fxmSpotifyLoginError,
} from '@fxm/platform/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { testRepo } from '../../test/library-fixtures'
import { createAccountChoice } from './account-store'
import { type AccountRuntime, createAccountRuntime } from './runtime'
import { fakeLocks, fakeServices } from './testing'

// The Android app's own login window (stage 6.5): the account feature over a fake FxmSpotifyLogin
// plugin, where the app keeps the login itself. The web's flows are in runtime.test.ts.

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function setup(
  options: {
    optedIn?: boolean
    plugin?: FakeFxmSpotifyLoginOptions
    window?: SpotifyLoginWindow
  } = {},
) {
  const repo = testRepo()
  const fake = fakeServices(repo)
  fake.setCapabilities('account', 'android')
  const plugin = createFakeFxmSpotifyLogin(options.plugin)
  const loginWindow = options.window ?? createAndroidSpotifyLogin({ plugin })
  const choice = createAccountChoice({ storage: () => undefined })
  if (options.optedIn) choice.getState().setOptedIn(true)
  const runtime = createAccountRuntime({
    services: { ...fake.services, loginWindow },
    choice,
    locks: fakeLocks(),
    pace: async () => {},
    every: () => () => {},
  })
  return { repo, fake, plugin, choice, runtime }
}

function start(runtime: AccountRuntime) {
  stops.push(runtime.start())
}

async function settled(runtime: AccountRuntime) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await runtime.whenIdle()
}

describe('the Android login window', () => {
  it('asks the window first, so no login kept means no request to Spotify', async () => {
    const { fake, plugin, runtime } = setup({ optedIn: true })
    start(runtime)
    await settled(runtime)
    expect(runtime.store.getState().phase).toBe('logged-out')
    expect(plugin.calls).toEqual(['status'])
    expect(fake.account.calls).toEqual([])
  })

  it('opens on Connect when no login is kept, then checks the login and syncs', async () => {
    const { fake, plugin, choice, runtime } = setup()
    start(runtime)
    await expect(runtime.connect()).resolves.toBe('done')
    expect(choice.getState().optedIn).toBe(true)
    expect(plugin.calls.slice(0, 3)).toEqual(['status', 'login', 'status'])
    expect(runtime.store.getState()).toMatchObject({
      phase: 'connected',
      displayName: 'Fixture User',
    })
    await settled(runtime)
    expect(fake.account.calls).toContain('liked 0')
    // The provider forgot a remembered logged-out answer before asking again.
    expect(fake.switches).toEqual(['connect', 'connect'])
  })

  it('connects without the window when a login is kept already', async () => {
    const { plugin, runtime } = setup({ plugin: { loggedIn: true } })
    start(runtime)
    await expect(runtime.connect()).resolves.toBeUndefined()
    expect(runtime.store.getState().phase).toBe('connected')
    expect(plugin.calls).not.toContain('login')
  })

  it('stays logged out when the user closes it, and Log in opens it again', async () => {
    let answer = false
    const { runtime } = setup({ plugin: { window: () => answer } })
    start(runtime)
    await expect(runtime.connect()).resolves.toBe('done')
    expect(runtime.store.getState().phase).toBe('logged-out')
    answer = true
    await expect(runtime.login()).resolves.toBe('done')
    expect(runtime.store.getState().phase).toBe('connected')
  })

  it('shares one window between two taps', async () => {
    let release: (value: boolean) => void = () => {}
    const { plugin, runtime } = setup({
      optedIn: true,
      plugin: { window: () => new Promise<boolean>((resolve) => (release = resolve)) },
    })
    start(runtime)
    await settled(runtime)
    const first = runtime.login()
    const second = runtime.login()
    expect(second).toBe(first)
    release(true)
    await expect(first).resolves.toBe('done')
    expect(plugin.calls.filter((call) => call === 'login')).toHaveLength(1)
  })

  it('says when it could not open, or could not keep the login', async () => {
    const { runtime } = setup({
      optedIn: true,
      plugin: {
        window: () => {
          throw fxmSpotifyLoginError('STORAGE', 'The keystore failed')
        },
      },
    })
    start(runtime)
    await settled(runtime)
    await expect(runtime.login()).resolves.toBe('failed')
    expect(runtime.store.getState().phase).toBe('logged-out')
  })

  it('never opens on a WebView without profiles, and says so', async () => {
    const { plugin, runtime } = setup({ plugin: { available: false } })
    start(runtime)
    await expect(runtime.connect()).resolves.toBeUndefined()
    expect(runtime.store.getState().phase).toBe('unsupported')
    await expect(runtime.login()).resolves.toBe('unavailable')
    expect(plugin.loggedIn).toBe(false)
  })

  it('treats a kept login Spotify no longer accepts as logged out', async () => {
    const { fake, runtime } = setup({ optedIn: true, plugin: { loggedIn: true } })
    fake.loggedIn = false
    start(runtime)
    await settled(runtime)
    expect(runtime.store.getState().phase).toBe('logged-out')
    expect(fake.account.calls).toEqual(['status'])
  })

  it('counts a window that would not answer as a failed check', async () => {
    const { plugin } = setup()
    const broken: SpotifyLoginWindow = {
      ...createAndroidSpotifyLogin({ plugin }),
      loginState: () => Promise.reject(new FxmError('Network', 'The bridge broke')),
    }
    const { runtime } = setup({ optedIn: true, window: broken })
    start(runtime)
    await settled(runtime)
    expect(runtime.store.getState()).toMatchObject({
      phase: 'unverified',
      failure: { kind: 'network' },
    })
  })

  it('logs out of the window on Disconnect, and forgets the account as on the web', async () => {
    const { fake, plugin, choice, runtime } = setup({ plugin: { loggedIn: true } })
    start(runtime)
    await runtime.connect()
    await settled(runtime)
    await runtime.disconnect()
    expect(choice.getState().optedIn).toBe(false)
    expect(plugin.calls).toContain('logout')
    expect(plugin.loggedIn).toBe(false)
    expect(fake.switches).toContain('disconnect')
    expect(runtime.store.getState().phase).toBe('off')
  })

  it('disconnects even when logging out fails', async () => {
    const { plugin } = setup()
    const stubborn: SpotifyLoginWindow = {
      ...createAndroidSpotifyLogin({ plugin }),
      logout: () => Promise.reject(new FxmError('Unavailable', 'The keystore failed')),
    }
    const { choice, runtime } = setup({ optedIn: true, window: stubborn })
    start(runtime)
    await settled(runtime)
    await expect(runtime.disconnect()).resolves.toMatchObject({ removed: 0 })
    expect(choice.getState().optedIn).toBe(false)
  })
})
