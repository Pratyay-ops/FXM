/**
 * `@fxm/platform`: gives every provider the right `fetch` for the platform FXM runs on, tells
 * the app which tier it is in, and makes every YouTube call draw from one request budget.
 * See the package README.
 *
 * Only what the app and the providers need is exported; the routing core, the request forms and
 * the storage helpers stay inside the package, so later stages can change them freely.
 *
 * @module
 */

export {
  type AndroidHttp,
  type AndroidHttpOptions,
  androidHttpIfAvailable,
  createAndroidHttp,
  FXM_HTTP_ERROR_CODES,
  FXM_HTTP_MAX_READ_BYTES,
  FXM_HTTP_PLUGIN,
  FXM_HTTP_READ_BYTES,
  type FxmHttpChunk,
  type FxmHttpErrorCode,
  type FxmHttpPlugin,
  type FxmHttpRequest,
  type FxmHttpResponseHead,
  fxmHttpErrorCode,
} from './android-http'
export type {
  AcquireOptions,
  BotCheckCause,
  BudgetLimit,
  BudgetSettings,
  BudgetSnapshot,
  RequestBudget,
  RequestBudgetOptions,
  RequestPriority,
  WaitOptions,
} from './budget'
export {
  BOT_CHECK_CAUSES,
  BUDGET_DEFAULTS,
  BUDGET_LIMITS,
  BudgetError,
  createRequestBudget,
  isBudgetError,
  REQUEST_PRIORITIES,
} from './budget'
export type {
  CapabilityInputs,
  CapabilityMonitor,
  CapabilityOptions,
  RefreshOptions,
} from './capabilities'
export {
  createCapabilityMonitor,
  detectCapabilities,
  resolveCapabilities,
} from './capabilities'
export type { CapacitorTransportOptions } from './capacitor'
export { createCapacitorTransport, unpatchedFetch } from './capacitor'
export type { Clock } from './clock'
export { systemClock } from './clock'
export type {
  BridgeRequestOptions,
  BridgeResponse,
  ConnectClient,
  ConnectClientOptions,
  ConnectErrorCode,
  ConnectFeature,
  ConnectState,
  ConnectStatus,
  ConnectWindow,
  SpotifyTokenParams,
} from './connect'
export {
  CONNECT_BRIDGE_TIMEOUT_MS,
  CONNECT_ERROR_CODES,
  CONNECT_MARKER_ATTRIBUTE,
  CONNECT_PING_TIMEOUT_MS,
  ConnectBridgeError,
  createConnectClient,
  hasConnectFeature,
  MIN_CONNECT_VERSION,
} from './connect'
export { corsUnsafeRequestHeaderNames, isCorsSimpleRequest } from './cors'
export type {
  DesktopFetchOptions,
  DesktopUserHosts,
  DesktopUserHostsOptions,
  PluginFetch,
  PluginFetchInit,
  TauriBindings,
  TauriBindingsSource,
  TauriInvoke,
} from './desktop'
export {
  createDesktopFetch,
  createDesktopUserHosts,
  desktopBrowserUserAgent,
  fxmUserAgent,
  isTauriRuntime,
  loadTauriBindings,
  siteOrigin,
} from './desktop'
export type { RouteNeed, TransportErrorReason } from './errors'
export {
  isRouteUnavailable,
  isTransportError,
  ROUTE_NEEDS,
  RouteUnavailableError,
  TRANSPORT_ERROR_REASONS,
  TransportError,
} from './errors'
export type { HostClass, HostRule } from './hosts'
export {
  classifyUrl,
  HOST_CLASSES,
  HOST_RULES,
  INNERTUBE_API_PREFIX,
  isInnerTubeApiUrl,
} from './hosts'
export type { SimpleInnerTubeInit, SimpleInnerTubeRequest } from './innertube'
export { SIMPLE_CONTENT_TYPE, toSimpleInnerTubeRequest } from './innertube'
export type {
  KillSwitches,
  KillSwitchSource,
  KillSwitchStore,
  LiteCheckOptions,
  LiteState,
  LiteTier,
  LiteTierOptions,
  OnlineEvents,
  SandboxTransport,
  SelfTestResult,
  UserHostInit,
} from './lite'
export {
  createKillSwitchStore,
  createLiteTier,
  LITE_DEFAULTS,
  SELF_TEST_RESULTS,
} from './lite'
export type { NativeHttp, NativeRequestInit, NativeTransportOptions } from './native'
export { createNativeTransport, NATIVE_ORIGINS } from './native'
export type { NodeTransportOptions } from './node'
export { createNodeTransport } from './node'
export type {
  ContextOptions,
  Environment,
  FxmPlatform,
  PlatformOptions,
  PlatformWindow,
} from './platform'
export { createPlatform, detectEnvironment, ENVIRONMENT_PLATFORMS } from './platform'
export type {
  BrowserSandboxTransport,
  SandboxDocumentOptions,
  SandboxError,
  SandboxErrorCode,
  SandboxHostWindow,
  SandboxTransportOptions,
} from './sandbox'
export {
  createSandboxTransport,
  isSandboxError,
  SandboxFailedError,
  SandboxRefusedError,
  sandboxDocumentHeader,
  sandboxDocumentPolicy,
} from './sandbox'
export type {
  SessionTokenOptions,
  SessionTokenSource,
  TokenEndpointResponse,
} from './spotify-session'
export { connectSessionSource } from './spotify-session'
export type { KeyValueStorage } from './storage'
export { browserStorage, memoryStorage } from './storage'
export type { TauriTransportOptions } from './tauri'
export { createTauriTransport } from './tauri'
export type { RouteKind, Transport, TransportOptions } from './transport'
export * from './updates'
export type { WebTransportOptions } from './web'
export { createWebTransport } from './web'
