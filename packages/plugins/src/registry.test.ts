import { formatId } from '@fxm/core'
import { memoryStorage } from '@fxm/platform'
import { createFakeClock } from '@fxm/platform/testing'
import { describe, expect, it } from 'vitest'
import { isPluginError } from './errors'
import { parseManifest } from './manifest'
import { createPluginFile, type DownloadFetch } from './package'
import {
  budgetKey,
  createPluginRegistry,
  type PluginStore,
  pluginReserves,
  type StoredPlugin,
} from './registry'
import {
  fakeCatalogFetch,
  inProcessSandboxes,
  memoryPluginStore,
  TEST_CATALOG_HOST,
  TEST_MEDIA_HOST,
  TEST_PLUGIN_CODE,
  testContext,
  testPluginFile,
  testPluginManifest,
} from './testing'

const T0 = Date.UTC(2026, 9, 26, 9)
const T1 = formatId('plugin.test-catalog', 'track', 't1')

function setup(
  initial: StoredPlugin[] = [],
  appVersion = '1.0.0',
  store: PluginStore = memoryPluginStore(initial),
) {
  const clock = createFakeClock(T0)
  const budgetStorage = memoryStorage()
  let documents = 0
  const sandboxes = inProcessSandboxes(() => {
    documents += 1
  })
  const registry = createPluginRegistry({ store, sandboxes, budgetStorage, clock, appVersion })
  let changes = 0
  registry.subscribe(() => {
    changes += 1
  })
  return {
    registry,
    store,
    clock,
    budgetStorage,
    documents: () => documents,
    changes: () => changes,
  }
}

function stored(
  overrides: Partial<StoredPlugin> = {},
  manifest = testPluginManifest(),
): StoredPlugin {
  return {
    id: 'test-catalog',
    manifest: parseManifest(manifest),
    code: TEST_PLUGIN_CODE,
    origin: { kind: 'file', name: 'test.json' },
    enabled: true,
    installedAt: T0 - 1000,
    updatedAt: T0 - 1000,
    ...overrides,
  }
}

/** A site serving one plugin file at `url`, which the test can change. */
function site(url: string, initial: string) {
  let body = initial
  const asked: string[] = []
  const fetch: DownloadFetch = async (requested) => {
    asked.push(requested)
    return requested === url ? new Response(body) : new Response('', { status: 404 })
  }
  return {
    fetch,
    asked,
    serve(next: string) {
      body = next
    },
  }
}

async function failure(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
  } catch (error) {
    return error
  }
  return undefined
}

const ADDRESS = 'https://plugins.example.org/test-catalog.fxmplugin.json'

describe('the plugin registry', () => {
  it('starts empty, then offers a plugin file and installs it, switched on, once approved', async () => {
    const { registry, store, changes } = setup()
    await registry.load()
    expect(registry.entries()).toEqual([])
    const offer = await registry.offerFromFile(testPluginFile(), 'test-catalog.fxmplugin.json')
    expect(offer).toMatchObject({
      addedHosts: [TEST_CATALOG_HOST, TEST_MEDIA_HOST],
      removedHosts: [],
      removedOperations: [],
    })
    expect(offer.current).toBeUndefined()
    // Nothing is stored or run before the user approves.
    expect(await store.list()).toEqual([])
    expect(registry.providers()).toEqual([])
    const entry = await registry.install(offer)
    expect(entry).toMatchObject({
      id: 'test-catalog',
      name: 'Test Catalog',
      version: '1.0.0',
      enabled: true,
      installedAt: T0,
      updatedAt: T0,
      origin: { kind: 'file', name: 'test-catalog.fxmplugin.json' },
    })
    expect(entry.problem).toBeUndefined()
    expect(await store.list()).toHaveLength(1)
    expect(registry.providers().map((providers) => providers.source)).toEqual([
      'plugin.test-catalog',
    ])
    expect(registry.hosts()).toEqual([TEST_CATALOG_HOST, TEST_MEDIA_HOST])
    expect(changes()).toBeGreaterThan(0)
  })

  it('runs the installed plugin’s providers in their own document', async () => {
    const { registry, documents } = setup()
    await registry.load()
    await registry.install(await registry.offerFromFile(testPluginFile(), 'x.json'))
    const providers = registry.providers()[0]
    expect(documents()).toBe(0)
    const track = await providers?.metadata?.getTrack(T1, testContext(fakeCatalogFetch()))
    expect(track?.title).toBe('Lantern Weather')
    expect(documents()).toBe(1)
  })

  it('offers only higher versions, and shows what an update changes', async () => {
    const { registry } = setup([stored()])
    await registry.load()
    const same = await failure(() => registry.offerFromFile(testPluginFile(), 'x.json'))
    expect(isPluginError(same, 'not-newer')).toBe(true)
    expect((same as Error).message).toBe('Test Catalog 1.0.0 is already installed')
    for (const older of [{ version: '0.9.0' }, { version: '1.0.0', description: 'changed' }]) {
      const code = `${TEST_PLUGIN_CODE}\n// ${JSON.stringify(older)}`
      await expect(registry.offerFromFile(testPluginFile(older, code), 'x.json')).rejects.toThrow(
        /FXM installs only a higher version/u,
      )
    }
    const update = await registry.offerFromFile(
      testPluginFile({
        version: '1.1.0',
        hosts: [TEST_CATALOG_HOST, 'images.example.org'],
        provides: ['search', 'track', 'resolve'],
      }),
      'x.json',
    )
    expect(update.current?.version).toBe('1.0.0')
    expect(update.addedHosts).toEqual(['images.example.org'])
    expect(update.removedHosts).toEqual([TEST_MEDIA_HOST])
    expect(update.addedOperations).toEqual([])
    expect(update.removedOperations).toEqual([
      'suggest',
      'album',
      'artist',
      'playlist',
      'radio',
      'match',
    ])
  })

  it('compares a file with the stored copies even before anything loaded them', async () => {
    const { registry } = setup([stored()])
    const update = await registry.offerFromFile(
      testPluginFile({ version: '1.1.0' }, `${TEST_PLUGIN_CODE}// 1.1.0`),
      'x.json',
    )
    expect(update.current?.version).toBe('1.0.0')
    await expect(registry.offerFromFile(testPluginFile(), 'x.json')).rejects.toMatchObject({
      pluginCode: 'not-newer',
    })
  })

  it('replaces the installed version with an approved update, in a new document', async () => {
    const { registry, documents } = setup([stored()])
    await registry.load()
    const ctx = testContext(fakeCatalogFetch())
    const before = registry.providers()[0]
    await before?.metadata?.getTrack(T1, ctx)
    expect(documents()).toBe(1)
    const code = `${TEST_PLUGIN_CODE}\n// 1.1.0`
    const entry = await registry.install(
      await registry.offerFromFile(testPluginFile({ version: '1.1.0' }, code), 'new.json'),
    )
    expect(entry).toMatchObject({ installedAt: T0 - 1000, updatedAt: T0, version: '1.1.0' })
    await expect(before?.metadata?.getTrack(T1, ctx)).rejects.toMatchObject({
      pluginCode: 'disabled',
    })
    await registry.providers()[0]?.metadata?.getTrack(T1, ctx)
    expect(documents()).toBe(2)
  })

  it('checks again at install time, so a stale offer can’t downgrade', async () => {
    const { registry } = setup([stored()])
    await registry.load()
    const stale = await registry.offerFromFile(
      testPluginFile({ version: '1.1.0' }, `${TEST_PLUGIN_CODE}//a`),
      'a.json',
    )
    await registry.install(
      await registry.offerFromFile(
        testPluginFile({ version: '1.2.0' }, `${TEST_PLUGIN_CODE}//b`),
        'b.json',
      ),
    )
    await expect(registry.install(stale)).rejects.toMatchObject({ pluginCode: 'not-newer' })
    expect(registry.entries()[0]?.version).toBe('1.2.0')
  })

  it('checks the package itself again at install time, so a hand-built offer gets nowhere', async () => {
    const { registry, store } = setup()
    await registry.load()
    const offer = await registry.offerFromFile(testPluginFile(), 'x.json')
    for (const [forged, code] of [
      [
        { ...offer, package: { ...offer.package, code: `${TEST_PLUGIN_CODE}// more` } },
        'checksum-mismatch',
      ],
      [
        {
          ...offer,
          package: {
            ...offer.package,
            manifest: { ...offer.package.manifest, hosts: ['open.spotify.com'] },
          },
        },
        'invalid-manifest',
      ],
      [
        { ...offer, package: { ...offer.package, origin: { kind: 'url', url: 'javascript:1' } } },
        'invalid-file',
      ],
    ] as const) {
      const error = await failure(() => registry.install(forged))
      expect(isPluginError(error, code), String(error)).toBe(true)
    }
    expect(await store.list()).toEqual([])
    expect(registry.entries()).toEqual([])
  })

  it('switches a plugin off and on: off, it has no providers, no hosts and no document', async () => {
    const { registry, store } = setup([stored()])
    await registry.load()
    const providers = registry.providers()[0]
    await registry.setEnabled('test-catalog', false)
    expect(registry.providers()).toEqual([])
    expect(registry.hosts()).toEqual([])
    expect((await store.list())[0]?.enabled).toBe(false)
    expect(registry.entries()[0]?.enabled).toBe(false)
    await expect(
      providers?.metadata?.search('x', { types: ['track'] }, testContext(fakeCatalogFetch())),
    ).rejects.toMatchObject({ pluginCode: 'disabled' })
    await registry.setEnabled('test-catalog', true)
    expect(registry.providers()).toHaveLength(1)
    await registry.setEnabled('missing', true)
  })

  it('removes a plugin with its request budget', async () => {
    const { registry, store, budgetStorage } = setup([stored()])
    await registry.load()
    await registry.providers()[0]?.metadata?.getTrack(T1, testContext(fakeCatalogFetch()))
    expect(budgetStorage.getItem(budgetKey('test-catalog'))).not.toBeNull()
    await registry.remove('test-catalog')
    expect(await store.list()).toEqual([])
    expect(registry.entries()).toEqual([])
    expect(registry.providers()).toEqual([])
    expect(budgetStorage.getItem(budgetKey('test-catalog'))).toBeNull()
  })

  it('lists stored copies that can’t run with their problem, as data, and never runs them', async () => {
    const tampered = stored({ code: `${TEST_PLUGIN_CODE}\nfetch('https://evil.example')` })
    const newer = stored(
      { id: 'future' },
      testPluginManifest({ id: 'future', name: 'Future', minFxmVersion: '9.0.0' }),
    )
    const broken = {
      ...stored({ id: 'broken' }),
      manifest: { name: 'Broken\nOne', version: '01.0.0' },
    } as unknown as StoredPlugin
    const { registry } = setup([tampered, newer, broken])
    await registry.load()
    expect(registry.entries()).toEqual([
      expect.objectContaining({
        id: 'broken',
        name: 'Broken One',
        problem: { code: 'damaged', message: expect.any(String) },
      }),
      expect.objectContaining({
        id: 'future',
        name: 'Future',
        version: '1.0.0',
        problem: {
          code: 'needs-newer-fxm',
          message: 'Future needs FXM 9.0.0 or later; this is FXM 1.0.0',
          minFxmVersion: '9.0.0',
          appVersion: '1.0.0',
        },
      }),
      expect.objectContaining({
        id: 'test-catalog',
        problem: expect.objectContaining({ code: 'damaged' }),
      }),
    ])
    // Neither the manifest nor a version that isn't one is passed off as real.
    expect(registry.entries()[0]).not.toHaveProperty('manifest')
    expect(registry.entries()[0]).not.toHaveProperty('version')
    expect(registry.providers()).toEqual([])
    expect(registry.hosts()).toEqual([])
  })

  it('checks a stored copy whose code changed again, even with the same length and dates', async () => {
    const store = memoryPluginStore([stored()])
    const { registry } = setup([], '1.0.0', store)
    await registry.load()
    expect(registry.providers()).toHaveLength(1)
    // One character changed, nothing else: a damaged or altered copy.
    const altered = TEST_PLUGIN_CODE.replace('Not in the test catalog', 'Not in the test katalog')
    expect(altered).toHaveLength(TEST_PLUGIN_CODE.length)
    await store.put(stored({ code: altered }))
    await registry.reload()
    expect(registry.entries()[0]?.problem?.code).toBe('damaged')
    expect(registry.providers()).toEqual([])
  })

  it('lets any version replace a plugin that can’t run, which repairs it', async () => {
    const newer = stored({}, testPluginManifest({ version: '2.0.0', minFxmVersion: '9.0.0' }))
    const { registry } = setup([newer])
    await registry.load()
    expect(registry.entries()[0]?.problem?.code).toBe('needs-newer-fxm')
    // An older version that runs on this FXM.
    const older = await registry.offerFromFile(testPluginFile({ version: '1.0.0' }), 'old.json')
    expect(older.current?.problem?.code).toBe('needs-newer-fxm')
    expect(older.addedHosts).toEqual([TEST_CATALOG_HOST, TEST_MEDIA_HOST])
    const entry = await registry.install(older)
    expect(entry).toMatchObject({ version: '1.0.0' })
    expect(entry.problem).toBeUndefined()
    expect(registry.providers()).toHaveLength(1)
  })

  it('downloads from an address with its host allowed for the download only', async () => {
    const { registry } = setup()
    await registry.load()
    const seen: (readonly string[])[] = []
    const { fetch } = site(ADDRESS, testPluginFile())
    const offer = await registry.offerFromAddress(ADDRESS, async (url, init) => {
      seen.push(registry.hosts())
      return fetch(url, init)
    })
    expect(seen).toEqual([['plugins.example.org']])
    expect(registry.hosts()).toEqual([])
    expect(offer.package.origin).toEqual({ kind: 'url', url: ADDRESS })
    await registry.install(offer)
    expect(registry.hosts()).toEqual([TEST_CATALOG_HOST, TEST_MEDIA_HOST])
  })

  it('checks for an update only when asked, from the address it came from', async () => {
    const { registry } = setup()
    await registry.load()
    const plugins = site(ADDRESS, testPluginFile())
    await registry.install(await registry.offerFromAddress(ADDRESS, plugins.fetch))
    expect(plugins.asked).toEqual([ADDRESS])
    expect(await registry.checkForUpdate('test-catalog', plugins.fetch)).toBeUndefined()
    const code = `${TEST_PLUGIN_CODE}\n// 2.0.0`
    plugins.serve(testPluginFile({ version: '2.0.0', hosts: [TEST_CATALOG_HOST] }, code))
    const update = await registry.checkForUpdate('test-catalog', plugins.fetch)
    expect(update).toMatchObject({ removedHosts: [TEST_MEDIA_HOST], addedHosts: [] })
    // Still the installed version until the user approves.
    expect(registry.entries()[0]?.version).toBe('1.0.0')
    plugins.serve(
      createPluginFile(testPluginManifest({ id: 'other', version: '3.0.0' }), TEST_PLUGIN_CODE),
    )
    await expect(registry.checkForUpdate('test-catalog', plugins.fetch)).rejects.toMatchObject({
      pluginCode: 'id-mismatch',
    })
  })

  it('offers whatever its address serves for a plugin that can’t run', async () => {
    const damaged = stored({
      code: `${TEST_PLUGIN_CODE} `,
      origin: { kind: 'url', url: ADDRESS },
    })
    const { registry } = setup([damaged])
    const plugins = site(ADDRESS, testPluginFile())
    const repair = await registry.checkForUpdate('test-catalog', plugins.fetch)
    expect(repair?.current?.problem?.code).toBe('damaged')
    expect(repair?.package.manifest.version).toBe('1.0.0')
  })

  it('updates a plugin added from a file only from a newer file', async () => {
    const { registry } = setup([stored()])
    await registry.load()
    await expect(registry.checkForUpdate('test-catalog', site(ADDRESS, '').fetch)).rejects.toThrow(
      /added from a file/u,
    )
    await expect(registry.checkForUpdate('missing', site(ADDRESS, '').fetch)).rejects.toMatchObject(
      { pluginCode: 'disabled' },
    )
  })

  it('reads changes another tab made to the store', async () => {
    const { registry, store } = setup()
    await registry.load()
    await store.put(stored())
    expect(registry.entries()).toEqual([])
    await registry.reload()
    expect(registry.entries().map((entry) => entry.id)).toEqual(['test-catalog'])
    expect(registry.providers()).toHaveLength(1)
  })

  it('tries the store again after it failed, so a busy moment at start disables nothing', async () => {
    const inner = memoryPluginStore([stored()])
    let busy = true
    const store: PluginStore = {
      ...inner,
      list: () => (busy ? Promise.reject(new Error('IndexedDB is busy')) : inner.list()),
    }
    const { registry } = setup([], '1.0.0', store)
    await expect(registry.load()).rejects.toThrow('IndexedDB is busy')
    busy = false
    await registry.load()
    expect(registry.entries()).toHaveLength(1)
    // A reload that worked takes the place of a load that didn't.
    busy = true
    const again = setup([], '1.0.0', store).registry
    await expect(again.load()).rejects.toThrow('IndexedDB is busy')
    busy = false
    await again.reload()
    const plugins = site(ADDRESS, testPluginFile({ version: '1.1.0' }, `${TEST_PLUGIN_CODE}//1.1`))
    const update = await again.offerFromAddress(ADDRESS, plugins.fetch)
    expect(update.current?.version).toBe('1.0.0')
  })

  it('keeps a plugin running across reads that change nothing', async () => {
    const { registry, documents } = setup([
      stored(),
      stored({ id: 'second' }, testPluginManifest({ id: 'second', name: 'Second' })),
    ])
    await registry.load()
    const ctx = testContext(fakeCatalogFetch())
    await registry.providers()[1]?.metadata?.getTrack(T1, ctx)
    await registry.setEnabled('second', false)
    await registry.reload()
    await registry.providers()[0]?.metadata?.getTrack(T1, ctx)
    expect(documents()).toBe(1)
  })

  it('keeps part of each plugin’s hour for the song that is playing', () => {
    expect(pluginReserves(120)).toEqual({
      'current-track': 0,
      prefetch: 12,
      interactive: 30,
      bulk: 60,
    })
    // A budget of one request still lets every kind of request use it.
    expect(pluginReserves(1)).toEqual({ 'current-track': 0, prefetch: 0, interactive: 0, bulk: 0 })
  })

  it('stops everything when disposed', async () => {
    const { registry } = setup([stored()])
    await registry.load()
    registry.dispose()
    expect(registry.providers()).toEqual([])
    expect(registry.hosts()).toEqual([])
    // Changes reject, rather than throw, so a caller's .then() sees them.
    const disabled = { pluginCode: 'disabled' }
    await expect(registry.offerFromFile(testPluginFile(), 'x.json')).rejects.toMatchObject(disabled)
    await expect(registry.setEnabled('test-catalog', false)).rejects.toMatchObject(disabled)
    await expect(registry.remove('test-catalog')).rejects.toMatchObject(disabled)
    await expect(registry.reload()).rejects.toMatchObject(disabled)
  })
})
