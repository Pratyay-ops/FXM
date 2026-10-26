import { parseManifest, type StoredPlugin } from '@fxm/plugins'
import { TEST_PLUGIN_CODE, testPluginManifest } from '@fxm/plugins/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createDexiePluginStore, openPluginsDatabase, type PluginsDatabase } from './plugins-db'

let opened: PluginsDatabase[] = []

function testStore() {
  const db = openPluginsDatabase(`fxm-plugins-test-${opened.length}-${Math.random()}`)
  opened.push(db)
  return createDexiePluginStore(db)
}

afterEach(async () => {
  await Promise.all(opened.map((db) => db.delete()))
  opened = []
})

const plugin: StoredPlugin = {
  id: 'test-catalog',
  manifest: parseManifest(testPluginManifest()),
  code: TEST_PLUGIN_CODE,
  origin: { kind: 'url', url: 'https://plugins.example.org/fxm-plugin.json' },
  enabled: true,
  installedAt: 1,
  updatedAt: 2,
}

describe('the IndexedDB plugin store', () => {
  it('keeps plugins by ID: adds, replaces and deletes them', async () => {
    const store = testStore()
    expect(await store.list()).toEqual([])
    await store.put(plugin)
    expect(await store.list()).toEqual([plugin])
    await store.put({ ...plugin, enabled: false })
    expect(await store.list()).toEqual([{ ...plugin, enabled: false }])
    await store.delete('test-catalog')
    await store.delete('missing')
    expect(await store.list()).toEqual([])
  })
})
