/**
 * `@fxm/plugins`: runtime-loadable sources and resolvers. A plugin is a manifest and a script,
 * installed only from an address or a file the user picks, checked against the SHA-256 its
 * manifest declares, run only in a worker of the isolated evaluator of stage 1.11 (never in FXM's
 * page), and allowed onto the network only through a `ctx.fetch` limited to the hosts it declares
 * and to its request budget. Updates install only when the user approves them. See the package
 * README.
 *
 * Only what the app needs is exported: the registry, reading manifests and plugin files, the
 * errors, the F-Droid consent and the sandboxes. The runner, the fetch broker, the providers and
 * the runtime stay inside, so nothing can run a plugin around the registry's checks.
 *
 * @module
 */

export { PLUGINS_CONSENT, type PluginPolicy, pluginPolicy } from './consent'
export {
  cleanText,
  isPluginError,
  PLUGIN_ERROR_CODES,
  PLUGIN_FAIL_CODES,
  PluginError,
  type PluginErrorCode,
  type PluginErrorOptions,
} from './errors'
export {
  compareVersions,
  DEVELOPMENT_VERSION,
  MANIFEST_LIMITS,
  type ManifestOptions,
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
  type DownloadFetch,
  PACKAGE_LIMITS,
  type PackageOptions,
  PLUGIN_FILE_FORMAT,
  type PluginOrigin,
  type PluginPackage,
  readPluginFile,
} from './package'
export type { PluginProviders } from './provider'
export {
  type BrokenPluginEntry,
  createPluginRegistry,
  type PluginEntry,
  type PluginOffer,
  type PluginProblem,
  type PluginRegistry,
  type PluginRegistryOptions,
  type PluginStore,
  type RunnablePluginEntry,
  type StoredPlugin,
} from './registry'
export {
  isolatedSandboxes,
  type PluginEvaluator,
  type PluginSandboxes,
  probePluginWorkers,
  type SandboxLease,
  type SandboxOptions,
  type WorkerProbeOptions,
} from './sandboxes'
