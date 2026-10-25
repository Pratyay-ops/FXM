/**
 * One entry point that picks the environment FXM runs in and wires its pieces together: the
 * transport, the shared request budget, FXM Connect and the Lite tier (browser only) and the
 * capability monitor.
 *
 * @module
 */

import { type CatalogMode, FxmError, type Platform, type ProviderContext } from '@fxm/core'
import { androidHttpIfAvailable } from './android-http'
import { createRequestBudget, type RequestBudget, type RequestPriority } from './budget'
import { type CapabilityMonitor, createCapabilityMonitor } from './capabilities'
import { createCapacitorTransport } from './capacitor'
import type { Clock } from './clock'
import { type ConnectClient, type ConnectWindow, createConnectClient } from './connect'
import { createLiteTier, type KillSwitches, type LiteTier, type SandboxTransport } from './lite'
import type { NativeHttp } from './native'
import { createNodeTransport } from './node'
import { browserStorage, type KeyValueStorage, memoryStorage } from './storage'
import { createTauriTransport } from './tauri'
import type { Transport } from './transport'
import { createWebTransport } from './web'

/**
 * Where FXM runs: a browser page (the web app and PWA), the Tauri desktop app, the Capacitor
 * Android app, or Node (tests, scripts and live smoke tests).
 */
export type Environment = 'browser' | 'tauri' | 'capacitor' | 'node'

/**
 * The `ProviderContext.platform` of each environment. Node reaches every host directly, like
 * the desktop app, so it counts as `desktop`.
 */
export const ENVIRONMENT_PLATFORMS: Readonly<Record<Environment, Platform>> = {
  browser: 'web',
  tauri: 'desktop',
  capacitor: 'android',
  node: 'desktop',
}

/** The globals {@link detectEnvironment} looks at. */
interface EnvironmentGlobals {
  __TAURI_INTERNALS__?: unknown
  Capacitor?: { isNativePlatform?: () => boolean }
  window?: unknown
  document?: unknown
  process?: { versions?: { node?: unknown } }
}

/**
 * Works out the environment from the globals: Tauri's `__TAURI_INTERNALS__`, a native Capacitor
 * platform, a page (`window` and `document`), then Node. Rejects anything else, such as a web
 * worker, with an `Unsupported` `FxmError`.
 */
export function detectEnvironment(global: object = globalThis): Environment {
  const globals = global as EnvironmentGlobals
  if (typeof globals.__TAURI_INTERNALS__ === 'object' && globals.__TAURI_INTERNALS__ !== null) {
    return 'tauri'
  }
  const capacitor = globals.Capacitor
  if (typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform()) {
    return 'capacitor'
  }
  if (typeof globals.window === 'object' && typeof globals.document === 'object') return 'browser'
  if (typeof globals.process?.versions?.node === 'string') return 'node'
  throw new FxmError(
    'Unsupported',
    'FXM runs in a browser page, the desktop app, the Android app or Node',
  )
}

/** Options for {@link createPlatform}. Everything is optional; the defaults suit the app. */
export interface PlatformOptions {
  /** The environment, when detection should be skipped (e.g. in tests). */
  environment?: Environment
  /** Browser: the page. Default: the global `window`. */
  window?: ConnectWindow & { readonly localStorage?: KeyValueStorage }
  /** The `fetch` to send with: the page's, the webview's or Node's. Default: the global one. */
  fetch?: typeof fetch
  /**
   * Where the budget and FXM Connect keep their state. Default: `localStorage` in a browser or
   * webview, memory in Node.
   */
  storage?: KeyValueStorage
  /** Browser: the Lite tier's sandbox documents (stage 1.10). Without them there is no Lite tier. */
  sandbox?: SandboxTransport
  /** The remote kill switches, read whenever they matter. */
  killSwitches?: () => KillSwitches
  /**
   * Desktop and Android: the native HTTP of stage 7.2 or 6.2. Without it, the stub transport,
   * except on Android when the app has its FxmHttp plugin ({@link androidHttpIfAvailable}).
   */
  nativeHttp?: NativeHttp
  /** Desktop and Android: whether a logged-in Spotify token source exists (7.4 and 6.5). */
  nativeSpotifyLogin?: boolean
  /** Hosts the user added in Settings. */
  userHosts?: () => Iterable<string>
  /** Desktop, Android and Node: a browser `User-Agent` for YouTube and Spotify. */
  userAgent?: string
  /** The clock, for tests. */
  clock?: Clock
}

/** Options for {@link FxmPlatform.context}. */
export interface ContextOptions {
  /** The catalog mode. */
  mode: CatalogMode
  /** What the provider's InnerTube calls are for. Default `interactive`. */
  priority?: RequestPriority
  /** Preferred language as a BCP 47 tag. */
  locale?: string
  /** Content region as an ISO 3166-1 alpha-2 code. */
  region?: string
  /** Cancels the provider call. */
  signal?: AbortSignal
}

/** Everything the app needs from the platform. */
export interface FxmPlatform {
  /** Where FXM runs. */
  readonly environment: Environment
  /** The app, as providers see it. */
  readonly platform: Platform
  /** The transport: the `fetch` for providers. */
  readonly transport: Transport
  /** The shared request budget. */
  readonly budget: RequestBudget
  /** What the platform can reach, kept up to date. */
  readonly capabilities: CapabilityMonitor
  /** Browser: FXM Connect. */
  readonly connect: ConnectClient | undefined
  /** Browser: the Lite tier, when sandbox documents were given. */
  readonly lite: LiteTier | undefined
  /**
   * A `ProviderContext` for one provider call, with the `fetch` for its priority and the current
   * capabilities. Build a new one per call: capabilities change over time.
   */
  context(options: ContextOptions): ProviderContext
  /** Stops watching FXM Connect. */
  dispose(): void
}

/** The pieces one environment provides. */
interface Pieces {
  transport: Transport
  budget: RequestBudget
  capabilities: CapabilityMonitor
  connect?: ConnectClient
  lite?: LiteTier
}

function browserPieces(options: PlatformOptions): Pieces {
  const window = options.window ?? (globalThis as { window?: PlatformOptions['window'] }).window
  if (window === undefined) throw new FxmError('Unsupported', 'No browser window to run in')
  const clock = options.clock === undefined ? {} : { clock: options.clock }
  const storage = options.storage ?? browserStorage(window) ?? memoryStorage()
  const budget = createRequestBudget({ storage, ...clock })
  const connect = createConnectClient({ window, storage, ...clock })
  const lite =
    options.sandbox === undefined
      ? undefined
      : createLiteTier({
          sandbox: options.sandbox,
          budget,
          ...(options.killSwitches === undefined ? {} : { killSwitches: options.killSwitches }),
        })
  const transport = createWebTransport({
    connect,
    budget,
    ...(lite === undefined ? {} : { lite }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
  })
  const capabilities = createCapabilityMonitor({
    platform: 'web',
    connect,
    ...(lite === undefined ? {} : { lite }),
  })
  return { transport, budget, capabilities, connect, ...(lite === undefined ? {} : { lite }) }
}

function nativePieces(environment: 'tauri' | 'capacitor', options: PlatformOptions): Pieces {
  // On Android, the app's FxmHttp plugin (stage 6.2) when the caller passes no native HTTP.
  const nativeHttp =
    options.nativeHttp ?? (environment === 'capacitor' ? androidHttpIfAvailable() : undefined)
  const storage = options.storage ?? browserStorage() ?? memoryStorage()
  const budget = createRequestBudget({
    storage,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  const transportOptions = {
    budget,
    ...(nativeHttp === undefined ? {} : { http: nativeHttp }),
    ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    ...(options.fetch === undefined ? {} : { webFetch: options.fetch }),
  }
  const transport =
    environment === 'tauri'
      ? createTauriTransport(transportOptions)
      : createCapacitorTransport(transportOptions)
  const capabilities = createCapabilityMonitor({
    platform: ENVIRONMENT_PLATFORMS[environment],
    nativeTransport: nativeHttp !== undefined,
    nativeSpotifyLogin: options.nativeSpotifyLogin === true,
  })
  return { transport, budget, capabilities }
}

function nodePieces(options: PlatformOptions): Pieces {
  const budget = createRequestBudget({
    storage: options.storage ?? memoryStorage(),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  const transport = createNodeTransport({
    budget,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  })
  const capabilities = createCapabilityMonitor({
    platform: 'desktop',
    nativeTransport: true,
    nativeSpotifyLogin: options.nativeSpotifyLogin === true,
  })
  return { transport, budget, capabilities }
}

/**
 * Creates the platform for the environment FXM runs in (or `options.environment`) and resolves
 * once the first capability detection is done, so `capabilities.current` is meaningful:
 *
 * - **browser:** the web transport with FXM Connect and, given `sandbox`, the Lite tier;
 * - **tauri** and **capacitor:** the native transport given `nativeHttp` (on Android, by default
 *   the app's FxmHttp plugin), else the stub that reaches only CORS-friendly hosts;
 * - **node:** the Node transport, with full access.
 *
 * Every environment has one request budget, which every InnerTube call draws from.
 */
export async function createPlatform(options: PlatformOptions = {}): Promise<FxmPlatform> {
  const environment = options.environment ?? detectEnvironment()
  const platform = ENVIRONMENT_PLATFORMS[environment]
  const pieces =
    environment === 'browser'
      ? browserPieces(options)
      : environment === 'node'
        ? nodePieces(options)
        : nativePieces(environment, options)
  const { transport, budget, capabilities, connect, lite } = pieces
  await capabilities.refresh()

  return {
    environment,
    platform,
    transport,
    budget,
    capabilities,
    connect,
    lite,
    context(contextOptions) {
      const { mode, priority = 'interactive', locale, region, signal } = contextOptions
      return {
        fetch: transport.withPriority(priority),
        platform,
        capabilities: capabilities.current,
        mode,
        ...(locale === undefined ? {} : { locale }),
        ...(region === undefined ? {} : { region }),
        ...(signal === undefined ? {} : { signal }),
      }
    },
    dispose() {
      capabilities.dispose()
      connect?.dispose()
    },
  }
}
