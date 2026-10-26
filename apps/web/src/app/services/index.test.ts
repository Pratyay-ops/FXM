import type { QueueItem } from '@fxm/core'
import type { ResolveRequest } from '@fxm/player'
import { testTrack } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

// startAppServices wires the app's module-wide registry, actions, player and policy, so each
// test imports the modules afresh, and takes the services it started down again.
let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  vi.doUnmock('./app-services')
  vi.resetModules()
  window.history.replaceState(null, '', '/')
  sessionStorage.clear()
})

async function load() {
  const services = await import('./index')
  stop = services.stopAppServices
  const { appSources } = await import('../../features/search/sources-context')
  const { appActions } = await import('../../features/search/actions')
  const { createAppPolicy } = await import('../../features/now-playing/playback-policy')
  const { getPlayer } = await import('../../features/now-playing/playback')
  return { ...services, appSources, appActions, appPolicy: createAppPolicy(), getPlayer }
}

const ITEM: QueueItem = { uid: 0, track: testTrack('a') }

function request(): ResolveRequest {
  return {
    reason: 'play',
    attempt: 0,
    signal: AbortSignal.timeout(5000),
    canPlay: () => 'probably',
  }
}

describe('startAppServices', () => {
  it("wires the real providers, the app's player and the library into the app", async () => {
    const { startAppServices, getAppServices, appSources, appActions } = await load()

    await startAppServices()

    // This page has no FXM Connect and no Lite tier: the Free tier. Spotify isn't listed: a
    // browser reads it only through the sandbox documents of stage 1.10.
    expect(getAppServices().platform?.environment).toBe('browser')
    expect(appSources.getSnapshot().capabilities.youtube).toBe('none')
    expect([...appSources.getSnapshot().providers.keys()].sort()).toEqual(['archive', 'yt', 'ytm'])
    expect(appActions.get().playback).toBeDefined()
    // "Add to playlist" lists the library's playlists (stage 2.6): Liked songs, not Downloads.
    const playlists = await appActions.get().library?.playlists()
    expect(playlists?.map((playlist) => playlist.name)).toEqual(['Liked songs'])
  })

  it("makes the app's player play through the services' policy", async () => {
    const { startAppServices, getAppServices, appActions, appPolicy, getPlayer } = await load()
    const services = getAppServices()
    const stream = { url: 'https://media.test/a' }
    const resolve = vi
      .spyOn(services.policy.resolver, 'resolve')
      .mockResolvedValue({ stream } as never)
    const connect = vi.spyOn(services, 'connectPlayer')

    await startAppServices()

    // The one player of stage 2.5, which the player bars and Now playing show.
    expect(connect).toHaveBeenCalledWith(getPlayer())
    expect(appActions.get().playback).toBeDefined()
    await expect(appPolicy.resolver.resolve(ITEM, request())).resolves.toEqual({ stream })
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('does it once, however often it is called', async () => {
    const { startAppServices, getAppServices } = await load()
    const services = getAppServices()
    const connect = vi.spyOn(services, 'connectPlayer')
    const start = vi.spyOn(services, 'start')

    await Promise.all([startAppServices(), startAppServices()])
    await startAppServices()

    // One player, connected once: one lifecycle attach, one set of play buttons.
    expect(connect).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
  })

  it('offers the play buttons before the platform is ready', async () => {
    const { startAppServices, getAppServices, appActions } = await load()
    let release: () => void = () => {}
    vi.spyOn(getAppServices(), 'start').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined)
        }),
    )

    // FXM Connect is still answering, say: the player's resolver waits for the platform itself.
    const started = startAppServices()

    await vi.waitFor(() => expect(appActions.get().playback).toBeDefined())
    release()
    await started
  })

  it('takes everything down again', async () => {
    const { startAppServices, stopAppServices, getAppServices, appSources, appActions } =
      await load()
    await startAppServices()
    const services = getAppServices()

    stopAppServices()

    expect(appActions.get().playback).toBeUndefined()
    expect(appActions.get().library).toBeUndefined()
    expect(appSources.getSnapshot().providers.size).toBe(0)
    expect(getAppServices()).not.toBe(services)
  })

  it("lets the app's player stop with a reason when the services can't start", async () => {
    vi.doMock('./app-services', () => ({
      createAppServices: () => {
        throw new Error('A bug')
      },
    }))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { startAppServices, appSources, appPolicy } = await load()

    await startAppServices()

    expect(logged).toHaveBeenCalledWith(
      'FXM: could not start the music services',
      expect.any(Error),
    )
    expect(appSources.getSnapshot().detecting).not.toBe(true)
    // Rather than wait for a policy that never comes.
    await expect(appPolicy.resolver.resolve(ITEM, request())).rejects.toMatchObject({
      name: 'FxmError',
      code: 'Unsupported',
    })
  })

  it('leaves the app to the development fake catalog when a tab asks for it', async () => {
    window.history.replaceState(null, '', '/app/search?fake=full')
    const { startAppServices, getAppServices, appSources, appPolicy } = await load()
    const start = vi.spyOn(getAppServices(), 'start')

    await startAppServices()

    expect(start).not.toHaveBeenCalled()
    expect(getAppServices().platform).toBeUndefined()
    // Its play buttons play nothing: the app's player plays local files only.
    await expect(appPolicy.resolver.resolve(ITEM, request())).rejects.toMatchObject({
      code: 'Unsupported',
    })
    // The fake catalog plugs itself in: wait for it, so it isn't still loading after the test.
    await vi.waitFor(() => expect(appSources.getSnapshot().providers.size).toBeGreaterThan(0))
  })
})
