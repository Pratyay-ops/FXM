import { afterEach, describe, expect, it, vi } from 'vitest'

// startAppServices wires the app's module-wide registry and actions, so each test imports the
// modules afresh, and takes the services it started down again.
let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  vi.resetModules()
  window.history.replaceState(null, '', '/')
  sessionStorage.clear()
})

async function load() {
  const services = await import('./index')
  stop = services.stopAppServices
  const { appSources } = await import('../../features/search/sources-context')
  const { appActions } = await import('../../features/search/actions')
  return { ...services, appSources, appActions }
}

describe('startAppServices', () => {
  it("wires the real providers and a player into the app's sources and actions", async () => {
    const { startAppServices, getAppServices, appSources, appActions } = await load()

    await startAppServices()

    // This page has no FXM Connect and no Lite tier: the Free tier. Spotify isn't listed: a
    // browser reads it only through the sandbox documents of stage 1.10.
    expect(getAppServices().platform?.environment).toBe('browser')
    expect(appSources.getSnapshot().capabilities.youtube).toBe('none')
    expect([...appSources.getSnapshot().providers.keys()].sort()).toEqual(['archive', 'yt', 'ytm'])
    expect(appActions.get().playback).toBeDefined()
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
    expect(appSources.getSnapshot().providers.size).toBe(0)
    expect(getAppServices()).not.toBe(services)
  })

  it('leaves the app to the development fake catalog when a tab asks for it', async () => {
    window.history.replaceState(null, '', '/app/search?fake=full')
    const { startAppServices, getAppServices, appSources } = await load()
    const start = vi.spyOn(getAppServices(), 'start')

    await startAppServices()

    expect(start).not.toHaveBeenCalled()
    expect(getAppServices().platform).toBeUndefined()
    // The fake catalog plugs itself in: wait for it, so it isn't still loading after the test.
    await vi.waitFor(() => expect(appSources.getSnapshot().providers.size).toBeGreaterThan(0))
  })
})
