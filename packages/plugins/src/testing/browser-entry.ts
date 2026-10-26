/**
 * What `browser.test.ts` bundles into its test page: the plugin registry, the web's evaluator of
 * `@fxm/platform` and the test plugin. Only that test uses it. It imports the test helpers from
 * their own modules, so nothing meant for Node (the in-process sandboxes) enters the bundle.
 *
 * @module
 */

export { createRequestBudget, createSandboxEvaluator, createWebTransport } from '@fxm/platform'
export { createPluginRegistry, isolatedSandboxes, probePluginWorkers } from '../index'
export { memoryPluginStore } from '../registry'
export { testContext } from './context'
export { fakeCatalogFetch, testPluginFile } from './test-plugin'
