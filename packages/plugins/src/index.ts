/**
 * `@fxm/plugins`: runtime-loadable sources and resolvers. A plugin is a manifest and a script,
 * installed only from an address or a file the user picks, checked against the SHA-256 its
 * manifest declares, run only in the isolated evaluator of stage 1.11 (never in FXM's page), and
 * allowed onto the network only through a `ctx.fetch` limited to the hosts it declares and to
 * its request budget. Updates install only when the user approves them. See the package README.
 *
 * @module
 */

export {
  BROKER_LIMITS,
  type BrokerLimits,
  createFetchBroker,
  type FetchBroker,
  type FetchBrokerOptions,
  PLUGIN_METHODS,
  PLUGIN_REQUEST_HEADERS,
} from './broker'
export { codeText, sha256Hex, verifyChecksum } from './checksum'
export { PLUGINS_CONSENT, type PluginPolicy, pluginPolicy } from './consent'
export {
  cleanText,
  isPluginError,
  PLUGIN_ERROR_CODES,
  PluginError,
  type PluginErrorCode,
  type PluginErrorOptions,
} from './errors'
export {
  createPluginRunner,
  type PluginRunner,
  type PluginRunnerOptions,
  pluginKey,
  RUNNER_LIMITS,
  type RunnerLimits,
} from './host'
export {
  checkCompatible,
  compareVersions,
  hostOfUrl,
  isDeclaredUrl,
  isPluginId,
  MANIFEST_LIMITS,
  METADATA_OPERATIONS,
  normalizeHost,
  PLUGIN_API_VERSION,
  PLUGIN_OPERATIONS,
  type PluginManifest,
  type PluginOperation,
  parseManifest,
  parseVersion,
  pluginSourceId,
} from './manifest'
export {
  createPluginFile,
  DOWNLOAD_TIMEOUT_MS,
  type DownloadFetch,
  downloadHosts,
  downloadPlugin,
  PACKAGE_LIMITS,
  type PackageOptions,
  PLUGIN_FILE_FORMAT,
  type PluginOrigin,
  type PluginPackage,
  pluginAddress,
  readPluginFile,
} from './package'
export { createPluginProviders, type PluginProviders } from './provider'
export {
  budgetKey,
  createPluginRegistry,
  memoryPluginStore,
  type PluginEntry,
  type PluginOffer,
  type PluginRegistry,
  type PluginRegistryOptions,
  type PluginStore,
  type StoredPlugin,
} from './registry'
export { RESULT_LIMITS, type ResultContext } from './results'
export {
  exclusiveSandbox,
  isolatedSandboxes,
  type PluginEvaluator,
  type PluginSandboxes,
  type SandboxLease,
} from './sandboxes'
