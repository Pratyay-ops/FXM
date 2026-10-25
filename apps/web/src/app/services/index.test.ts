import { afterEach, describe, expect, it, vi } from 'vitest'

// startAppServices wires the app's module-wide registry and actions, so each test imports the
// modules afresh.
afterEach(() => {
  vi.resetModules()
  window.history.replaceState(null, '', '/')
  sessionStorage.clear()
})

async function load() {
  const services = await import('./index')
  const { appSources } = await import('../../features/search/sources-context')
  const { appActions } = await import('../../features/search/actions')
  return { ...services, appSources, appActions }
}

describe('startAppServices', () => {
  it("wires the real providers and a player into the app's sources and actions", async () => {
    const { startAppServices, getAppServices, appSources, appActions } = await load()

    await startAppServices()

    // This page has no FXM Connect and no Lite tier: the Free tier, with every source listed.
    expect(getAppServices().platform?.environment).toBe('browser')
    expect(appSources.getSnapshot().capabilities.youtube).toBe('none')
    expect([...appSources.getSnapshot().providers.keys()].sort()).toEqual([
      'archive',
      'spotify',
      'yt',
      'ytm',
    ])
    expect(appActions.get().playback).toBeDefined()
    getAppServices().dispose()
  })

  it('does it once, however often it is called', async () => {
    const { startAppServices, getAppServices } = await load()
    const services = getAppServices()
    const start = vi.spyOn(services, 'start')

    await Promise.all([startAppServices(), startAppServices()])

    expect(getAppServices()).toBe(services)
    const [first, second] = start.mock.results.map((result) => result.value)
    expect(second).toBe(first)
    services.dispose()
  })

  it('leaves the app to the development fake catalog when a tab asks for it', async () => {
    window.history.replaceState(null, '', '/app/search?fake=full')
    const { startAppServices, getAppServices } = await load()
    const start = vi.spyOn(getAppServices(), 'start')

    await startAppServices()

    expect(start).not.toHaveBeenCalled()
    expect(getAppServices().platform).toBeUndefined()
  })
})
