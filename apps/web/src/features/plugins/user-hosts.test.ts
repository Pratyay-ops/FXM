import type { createPlatform } from '@fxm/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'

type PlatformOptions = NonNullable<Parameters<typeof createPlatform>[0]>

afterEach(() => {
  vi.doUnmock('@fxm/platform')
  vi.resetModules()
})

/** The app's platform module, with `createPlatform` catching the options it is created with. */
async function load() {
  const created: PlatformOptions[] = []
  vi.doMock('@fxm/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@fxm/platform')>()),
    createPlatform: async (options: PlatformOptions = {}) => {
      created.push(options)
      return {}
    },
    // This page can't frame the Lite tier's sandbox documents.
    createSandboxTransport: () => ({}),
  }))
  const appPlatform = await import('../connect/app-platform')
  const userHosts = await import('./user-hosts')
  await appPlatform.getAppPlatform()
  const hosts = () => [...(created[0]?.userHosts?.() ?? [])]
  return { ...appPlatform, ...userHosts, created, hosts }
}

describe("the app platform's user hosts", () => {
  it("are the Spotify secret's and the plugins', read at each request", async () => {
    const { created, hosts, setAppUserHosts, setPluginHostsSource } = await load()
    expect(created).toHaveLength(1)
    expect(hosts()).toEqual([])

    // The composition root hands over the Spotify secret's hosts, and the plugin runtime the
    // hosts of the plugins that are on, after the platform was created.
    setAppUserHosts(() => ['secret.example.org'])
    setPluginHostsSource(() => ['catalog.fxm-plugin.test', 'media.fxm-plugin.test'])
    expect(hosts()).toEqual([
      'secret.example.org',
      'catalog.fxm-plugin.test',
      'media.fxm-plugin.test',
    ])

    // A plugin switched off takes its hosts along; the Spotify secret's stay.
    setPluginHostsSource(() => [])
    expect(hosts()).toEqual(['secret.example.org'])
    setAppUserHosts(undefined)
    setPluginHostsSource(() => ['catalog.fxm-plugin.test'])
    expect(hosts()).toEqual(['catalog.fxm-plugin.test'])
  })

  it('stay usable when the plugins’ list fails', async () => {
    const { hosts, setAppUserHosts, setPluginHostsSource } = await load()
    setAppUserHosts(() => ['secret.example.org'])
    setPluginHostsSource(() => {
      throw new Error('The registry is gone')
    })
    expect(hosts()).toEqual(['secret.example.org'])
  })
})
