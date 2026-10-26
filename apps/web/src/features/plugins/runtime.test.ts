import {
  currentQueueItem,
  DEFAULT_QUALITY_PREFS,
  formatId,
  playbackProblemOf,
  type QualityPrefs,
  type Track,
} from '@fxm/core'
import { classifyFailure, Player, StreamLifecycle, type StreamSource } from '@fxm/player'
import { FakeEngine } from '@fxm/player/testing'
import { parseManifest, type StoredPlugin } from '@fxm/plugins'
import {
  fakeCatalogFetch,
  TEST_CATALOG_HOST,
  TEST_MEDIA_HOST,
  TEST_PLUGIN_CODE,
  testContext,
  testPluginFile,
  testPluginManifest,
} from '@fxm/plugins/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStaticPlatform, TIER_CAPABILITIES } from '../search/sources'
import { distributionOf } from './distribution'
import { usePluginsSettingsStore } from './plugins-store'
import {
  announcePluginChange,
  connectPluginAudio,
  getPluginRegistry,
  pluginAudioSources,
  pluginRecommendations,
  pluginSupport,
  pluginsAllowed,
  startPlugins,
  stopPlugins,
} from './runtime'
import { resetPluginTestRuntime, setupPluginTestRuntime } from './testing'
import { pluginUserHosts } from './user-hosts'

const T0 = Date.UTC(2026, 9, 26, 9)

function stored(overrides: Partial<StoredPlugin> = {}): StoredPlugin {
  return {
    id: 'test-catalog',
    manifest: parseManifest(testPluginManifest()),
    code: TEST_PLUGIN_CODE,
    origin: { kind: 'file', name: 'test.json' },
    enabled: true,
    installedAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

afterEach(() => {
  resetPluginTestRuntime()
})

describe('the plugin runtime', () => {
  it('registers the catalogs of the plugins that are on with the app’s sources', async () => {
    const { sources } = setupPluginTestRuntime({ initial: [stored()] })
    await startPlugins()
    const provider = sources.getSnapshot().providers.get('plugin.test-catalog')
    expect(provider?.requestPolicy).toBe('explicit')
    expect(pluginUserHosts()).toEqual([TEST_CATALOG_HOST, TEST_MEDIA_HOST])
    expect(pluginAudioSources().map((source) => source.id)).toEqual(['plugin.test-catalog'])
    expect(pluginRecommendations().map((source) => source.id)).toEqual(['plugin.test-catalog'])

    // A plugin catalog works through the sources' context, like any provider.
    sources.setPlatform(createStaticPlatform(TIER_CAPABILITIES.free, fakeCatalogFetch()))
    const results = await provider?.search(
      'moths',
      { types: ['track'] },
      sources.context({ mode: 'music' }),
    )
    expect(results?.tracks?.items.map((track) => track.id)).toEqual([
      formatId('plugin.test-catalog', 'track', 't1'),
      formatId('plugin.test-catalog', 'track', 't2'),
    ])
  })

  it('follows the registry: switched off, removed, added', async () => {
    const { sources } = setupPluginTestRuntime({ initial: [stored()] })
    await startPlugins()
    const registry = getPluginRegistry()
    await registry.setEnabled('test-catalog', false)
    expect(sources.getSnapshot().providers.has('plugin.test-catalog')).toBe(false)
    expect(pluginUserHosts()).toEqual([])
    await registry.setEnabled('test-catalog', true)
    expect(sources.getSnapshot().providers.has('plugin.test-catalog')).toBe(true)
    await registry.remove('test-catalog')
    expect(sources.getSnapshot().providers.size).toBe(0)
    await registry.install(await registry.offerFromFile(testPluginFile(), 'again.json'))
    expect(sources.getSnapshot().providers.has('plugin.test-catalog')).toBe(true)
  })

  it('adds the resolvers of the plugins that are on to the lifecycle, and takes them out again', async () => {
    setupPluginTestRuntime({ initial: [stored()] })
    const added: StreamSource[] = []
    const removed: string[] = []
    const disconnect = connectPluginAudio({
      addSource(source) {
        added.push(source)
        return () => removed.push(source.id)
      },
    })
    await startPlugins()
    expect(added.map((source) => source.id)).toEqual(['plugin.test-catalog'])
    const registry = getPluginRegistry()
    await registry.setEnabled('test-catalog', false)
    expect(removed).toEqual(['plugin.test-catalog'])
    await registry.setEnabled('test-catalog', true)
    expect(added).toHaveLength(2)
    stopPlugins()
    expect(removed).toHaveLength(2)
    await startPlugins()
    expect(added).toHaveLength(3)
    disconnect()
    expect(removed).toHaveLength(3)
  })

  it('follows the lifecycle the composition root connects after the plugins started', async () => {
    setupPluginTestRuntime({ initial: [stored()] })
    await startPlugins()
    const added: string[] = []
    const removed: string[] = []
    const disconnect = connectPluginAudio({
      addSource(source) {
        added.push(source.id)
        return () => removed.push(source.id)
      },
    })
    expect(added).toEqual(['plugin.test-catalog'])
    disconnect()
    expect(removed).toEqual(['plugin.test-catalog'])
    // The next lifecycle, such as the services' after they started again, gets them afresh.
    const next: string[] = []
    connectPluginAudio({
      addSource(source) {
        next.push(source.id)
        return () => {}
      },
    })
    expect(next).toEqual(['plugin.test-catalog'])
    expect(added).toHaveLength(1)
  })

  it('plays a plugin’s own song through its resolver in a stream lifecycle', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setupPluginTestRuntime({ initial: [stored()] })
    const ctx = testContext(fakeCatalogFetch())
    const lifecycle = new StreamLifecycle({
      sources: [],
      context: () => ctx,
      qualityPrefs: () => DEFAULT_QUALITY_PREFS as QualityPrefs,
    })
    connectPluginAudio(lifecycle)
    await startPlugins()
    const track = await getPluginRegistry()
      .providers()[0]
      ?.metadata?.getTrack(formatId('plugin.test-catalog', 'track', 't1'), ctx)
    if (track === undefined) throw new Error('no track')
    const resolved = await lifecycle.resolve(
      { uid: 1, track },
      {
        reason: 'play',
        attempt: 0,
        signal: new AbortController().signal,
        canPlay: () => 'probably',
      },
    )
    // The default ceiling on Wi-Fi is High: the 320 kbps MP3, not the FLAC.
    expect(resolved.stream.url).toBe(`https://${TEST_MEDIA_HOST}/audio/t1.mp3`)
    lifecycle.destroy()
  })

  it('skips a plugin song whose resolve breaks the plugin’s rules, and the player plays on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const code = `fxm.register({
      async search() { return {} },
      async track({ id }) { return { id, title: id } },
      async resolve({ candidate }, ctx) {
        // An address the manifest doesn't declare: the host refuses it, and the plugin fails.
        if (candidate.id === 'bad') await ctx.fetch('https://tracker.example.com/beacon')
        return [{ url: 'https://${TEST_MEDIA_HOST}/audio/' + candidate.id + '.mp3', codec: 'mp3', container: 'mp3', bitrateKbps: 192 }]
      },
    })`
    const manifest = parseManifest(
      testPluginManifest({ provides: ['search', 'track', 'resolve'] }, code),
    )
    setupPluginTestRuntime({ initial: [stored({ manifest, code })] })
    const ctx = testContext(fakeCatalogFetch())
    const lifecycle = new StreamLifecycle({
      sources: [],
      context: () => ctx,
      qualityPrefs: () => DEFAULT_QUALITY_PREFS as QualityPrefs,
    })
    connectPluginAudio(lifecycle)
    await startPlugins()
    const engine = new FakeEngine()
    const player = new Player({ engine, resolver: lifecycle })
    lifecycle.attach(player)
    const failed: Error[] = []
    player.on('trackfailed', ({ error }) => failed.push(error))
    const song = (id: string): Track => ({
      id: formatId('plugin.test-catalog', 'track', id),
      source: 'plugin.test-catalog',
      title: id,
      artists: [],
      artwork: [],
      kind: 'song',
    })

    await player.setQueue([song('bad'), song('good')])

    await expect.poll(() => player.getState().status).toBe('playing')
    expect(currentQueueItem(player.getState().queue)?.track.title).toBe('good')
    expect(engine.source?.stream.url).toBe(`https://${TEST_MEDIA_HOST}/audio/good.mp3`)
    // The broken track was skipped: an unplayable item, never a reason to stop the player.
    expect(failed).toHaveLength(1)
    expect(classifyFailure(failed[0] as Error)).toBe('skip')
    expect(playbackProblemOf(failed[0])).toMatchObject({
      type: 'unavailable',
      reason: 'unplayable',
      code: 'Unavailable',
    })
    player.destroy()
    lifecycle.destroy()
  })

  it('stops everything when asked, and starts again', async () => {
    const { sources } = setupPluginTestRuntime({ initial: [stored()] })
    await startPlugins()
    stopPlugins()
    expect(sources.getSnapshot().providers.size).toBe(0)
    expect(pluginUserHosts()).toEqual([])
    expect(pluginAudioSources()).toEqual([])
    await startPlugins()
    expect(sources.getSnapshot().providers.size).toBe(1)
  })

  it('runs no plugin in the desktop and Android apps yet', async () => {
    for (const environment of ['tauri', 'capacitor'] as const) {
      const { sources } = setupPluginTestRuntime({ initial: [stored()], environment })
      expect(pluginSupport(environment)).toBe('pending')
      expect(pluginsAllowed()).toBe(false)
      await startPlugins()
      expect(sources.getSnapshot().providers.size).toBe(0)
      resetPluginTestRuntime()
    }
    expect(pluginSupport('browser')).toBe('supported')
  })

  it('waits for the opt-in in an F-Droid build', async () => {
    const { sources } = setupPluginTestRuntime({ initial: [stored()], distribution: 'fdroid' })
    expect(pluginsAllowed()).toBe(false)
    await startPlugins()
    expect(sources.getSnapshot().providers.size).toBe(0)
    usePluginsSettingsStore.getState().setOptedIn(true)
    expect(pluginsAllowed()).toBe(true)
    await startPlugins()
    expect(sources.getSnapshot().providers.size).toBe(1)
  })

  it('reads the store again when another tab announces a change', async () => {
    const { store, sources } = setupPluginTestRuntime()
    await startPlugins()
    expect(sources.getSnapshot().providers.size).toBe(0)
    await store.put(stored())
    announcePluginChange()
    await expect.poll(() => sources.getSnapshot().providers.size).toBe(1)
  })
})

describe('the build’s distribution', () => {
  it('reads the build flag, and takes a mistyped one for F-Droid', () => {
    expect(distributionOf(undefined)).toBe('standard')
    expect(distributionOf('')).toBe('standard')
    expect(distributionOf('fdroid')).toBe('fdroid')
    expect(distributionOf('F-Droid')).toBe('fdroid')
    expect(distributionOf('fdorid')).toBe('fdroid')
  })
})
