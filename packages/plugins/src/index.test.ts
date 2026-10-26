import { describe, expect, it } from 'vitest'
import * as plugins from './index'
import * as testing from './testing'

describe('@fxm/plugins', () => {
  it('exports what the app needs, and nothing that runs a plugin around the registry', () => {
    expect(Object.keys(plugins).sort()).toEqual(
      [
        'DEVELOPMENT_VERSION',
        'MANIFEST_LIMITS',
        'PACKAGE_LIMITS',
        'PLUGINS_CONSENT',
        'PLUGIN_API_VERSION',
        'PLUGIN_ERROR_CODES',
        'PLUGIN_FAIL_CODES',
        'PLUGIN_FILE_FORMAT',
        'PLUGIN_OPERATIONS',
        'PluginError',
        'cleanText',
        'compareVersions',
        'createPluginFile',
        'createPluginRegistry',
        'isPluginError',
        'isolatedSandboxes',
        'parseManifest',
        'parseVersion',
        'pluginPolicy',
        'pluginSourceId',
        'probePluginWorkers',
        'readPluginFile',
      ].sort(),
    )
  })

  it('keeps the in-process sandboxes for tests, in @fxm/plugins/testing', () => {
    expect(Object.keys(testing).sort()).toEqual(
      [
        'TEST_CATALOG',
        'TEST_CATALOG_HOST',
        'TEST_MEDIA_HOST',
        'TEST_PLUGIN_CODE',
        'TestWorker',
        'fakeCatalogFetch',
        'inProcessSandboxes',
        'installTestWorker',
        'memoryPluginStore',
        'testContext',
        'testPluginFile',
        'testPluginManifest',
      ].sort(),
    )
  })
})
