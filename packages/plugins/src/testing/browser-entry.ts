/**
 * What `browser.test.ts` bundles into its test page: the plugin registry, the web's evaluator of
 * `@fxm/platform` and the test plugin. Only that test uses it.
 *
 * @module
 */

export { createSandboxEvaluator } from '@fxm/platform'
export { createPluginRegistry, isolatedSandboxes } from '../index'
export { fakeCatalogFetch, memoryPluginStore, testContext, testPluginFile } from './index'
