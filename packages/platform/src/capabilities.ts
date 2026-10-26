/**
 * What the current platform can reach, as the `NetworkCapabilities` every `ProviderContext`
 * carries: how far YouTube and Spotify go, whether media bytes are readable and whether files
 * can be written outside browser storage. The UI reads them to show the right tier, and they
 * update when FXM Connect appears, changes or goes away, and when the Lite tier's state or its
 * kill switch changes.
 *
 * @module
 */

import type { NetworkCapabilities, Platform } from '@fxm/core'
import { type ConnectClient, type ConnectStatus, hasConnectFeature } from './connect'
import type { LiteTier } from './lite'

/** The facts capabilities follow from (see {@link resolveCapabilities}). */
export interface CapabilityInputs {
  /** The app FXM runs in. */
  readonly platform: Platform
  /** Web: what FXM Connect detection found. */
  readonly connect?: ConnectStatus | undefined
  /** Web: whether the Lite tier is ready (self-test passed, kill switch off). */
  readonly lite?: boolean
  /** Desktop and Android: whether the native transport exists (stages 7.2 and 6.2). */
  readonly nativeTransport?: boolean
  /** Desktop and Android: whether a logged-in Spotify token source exists (7.4 and 6.5). */
  readonly nativeSpotifyLogin?: boolean
  /** Whether files can be written outside browser storage. Default: not on the web. */
  readonly fileSystem?: boolean
}

/**
 * The capabilities that follow from the inputs:
 *
 * - **Web with FXM Connect `present`:** YouTube `full` with feature `youtube`, media bytes with
 *   `googlevideo` as well. Spotify `anonymous` with `spotify`, `account` when `spotify-login` is
 *   announced too (the user turned the bridge's login on).
 * - **Web otherwise** (Connect `absent`, `missing` or `outdated`): YouTube `simple` while the
 *   Lite tier is ready, else `none`; Spotify `unreachable`; no media bytes.
 * - **Desktop and Android:** with their native transport, YouTube `full`, media bytes, and
 *   Spotify `anonymous`, or `account` with a login token source. Without it (the stubs before
 *   7.2 and 6.2), nothing beyond what a web page reaches without FXM Connect.
 *
 * The user's Spotify switch is a setting, not a capability: FXM uses Spotify when the switch is
 * on and `spotify` is not `unreachable`.
 */
export function resolveCapabilities(inputs: CapabilityInputs): NetworkCapabilities {
  const fileSystem = inputs.fileSystem ?? inputs.platform !== 'web'
  if (inputs.platform !== 'web') {
    return inputs.nativeTransport === true
      ? {
          youtube: 'full',
          mediaBytes: true,
          spotify: inputs.nativeSpotifyLogin === true ? 'account' : 'anonymous',
          fileSystem,
        }
      : { youtube: 'none', mediaBytes: false, spotify: 'unreachable', fileSystem }
  }
  const has = (feature: Parameters<typeof hasConnectFeature>[1]) =>
    hasConnectFeature(inputs.connect, feature)
  const spotify = has('spotify') ? (has('spotify-login') ? 'account' : 'anonymous') : 'unreachable'
  if (has('youtube'))
    return { youtube: 'full', mediaBytes: has('googlevideo'), spotify, fileSystem }
  return {
    youtube: inputs.lite === true ? 'simple' : 'none',
    mediaBytes: false,
    spotify,
    fileSystem,
  }
}

/** Options for {@link detectCapabilities} and {@link createCapabilityMonitor}. */
export interface CapabilityOptions {
  /** The app FXM runs in. */
  readonly platform: Platform
  /** Web: the FXM Connect client. */
  readonly connect?: ConnectClient
  /**
   * Web: the Lite tier, whose self-test runs only when FXM Connect gives no full access. Its
   * changes (a self-test that ended, a kill switch set) update the capabilities by themselves.
   */
  readonly lite?: LiteTier
  /** Desktop and Android: whether the native transport exists. */
  readonly nativeTransport?: boolean
  /** Desktop and Android: whether a logged-in Spotify token source exists. */
  readonly nativeSpotifyLogin?: boolean
  /** Whether files can be written outside browser storage. */
  readonly fileSystem?: boolean
}

function staticInputs(options: CapabilityOptions): CapabilityInputs {
  return {
    platform: options.platform,
    ...(options.nativeTransport === undefined ? {} : { nativeTransport: options.nativeTransport }),
    ...(options.nativeSpotifyLogin === undefined
      ? {}
      : { nativeSpotifyLogin: options.nativeSpotifyLogin }),
    ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
  }
}

/**
 * Capabilities from a known Connect status, starting the Lite self-test only if it can help.
 * Without `waitForLite`, the Lite tier counts as it stands and the self-test goes on alone.
 */
async function capabilitiesWith(
  options: CapabilityOptions,
  connect: ConnectStatus | undefined,
  waitForLite: boolean,
): Promise<NetworkCapabilities> {
  const inputs = { ...staticInputs(options), connect }
  const withoutLite = resolveCapabilities(inputs)
  if (withoutLite.youtube !== 'none' || options.platform !== 'web' || options.lite === undefined) {
    return withoutLite
  }
  const check = options.lite.check().catch(() => false)
  const lite = waitForLite ? await check : options.lite.ready
  return resolveCapabilities({ ...inputs, lite })
}

/**
 * Detects the capabilities once, in the order the architecture gives: FXM Connect first (marker
 * and ping), then, only when it gives no full YouTube access, the Lite tier's one-request
 * self-test (at most its timeout, 10 s by default), which honours the remote kill switch.
 */
export async function detectCapabilities(options: CapabilityOptions): Promise<NetworkCapabilities> {
  return capabilitiesWith(options, await detectConnect(options), true)
}

/** FXM Connect's status on the web; `undefined` elsewhere or if detection fails. */
async function detectConnect(options: CapabilityOptions): Promise<ConnectStatus | undefined> {
  if (options.platform !== 'web' || options.connect === undefined) return undefined
  return options.connect.detect().catch(() => undefined)
}

/** Whether two capability sets are the same. */
export function sameCapabilities(a: NetworkCapabilities, b: NetworkCapabilities): boolean {
  return (
    a.youtube === b.youtube &&
    a.spotify === b.spotify &&
    a.mediaBytes === b.mediaBytes &&
    a.fileSystem === b.fileSystem
  )
}

/** Options for {@link CapabilityMonitor.refresh}. */
export interface RefreshOptions {
  /**
   * Whether to wait for the Lite self-test when it has to run (at most its timeout). Default
   * `true`. With `false` the result counts the Lite tier as it stands, the self-test goes on in
   * the background, and subscribers hear when it makes YouTube `simple`.
   */
  readonly waitForLite?: boolean
}

/** The current capabilities, kept up to date. */
export interface CapabilityMonitor {
  /**
   * The latest capabilities. Before the first detection finishes, those of a platform that has
   * found nothing yet (no FXM Connect, no Lite tier).
   */
  readonly current: NetworkCapabilities
  /**
   * Detects again (FXM Connect, then the Lite tier if it can help) and resolves with the
   * result, e.g. after the kill switches changed when they are read through a function.
   * Concurrent calls with the same options share one detection.
   */
  refresh(options?: RefreshOptions): Promise<NetworkCapabilities>
  /**
   * Calls `listener` whenever the capabilities change: after a refresh, and by itself when FXM
   * Connect appears, changes or goes away, and when the Lite tier's state changes. Returns a
   * function that removes the listener.
   */
  subscribe(listener: (capabilities: NetworkCapabilities) => void): () => void
  /** Stops following FXM Connect and the Lite tier. */
  dispose(): void
}

/**
 * Creates a monitor and starts following FXM Connect and the Lite tier. Call `refresh()` once at
 * start-up (as `createPlatform` does) for the first detection.
 */
export function createCapabilityMonitor(options: CapabilityOptions): CapabilityMonitor {
  const listeners = new Set<(capabilities: NetworkCapabilities) => void>()
  let current = resolveCapabilities(staticInputs(options))
  const refreshing = new Map<boolean, Promise<NetworkCapabilities>>()
  let newest: Promise<NetworkCapabilities> | undefined
  let generation = 0
  let disposed = false

  function apply(next: NetworkCapabilities): void {
    if (disposed) return
    const changed = !sameCapabilities(current, next)
    current = next
    if (!changed) return
    for (const listener of [...listeners]) {
      try {
        listener(next)
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }

  /**
   * Works the capabilities out from a Connect status. When a newer evaluation started in the
   * meantime, that one decides, and this one resolves with its result.
   */
  function evaluate(
    status: () => Promise<ConnectStatus | undefined>,
    waitForLite = true,
  ): Promise<NetworkCapabilities> {
    generation += 1
    const mine = generation
    // Start on a later tick: detection can notify synchronously, which starts a newer
    // evaluation, and `newest` must already point at this one by then.
    const result = Promise.resolve().then(async (): Promise<NetworkCapabilities> => {
      const next = await capabilitiesWith(options, await status(), waitForLite)
      if (mine !== generation && newest !== undefined && newest !== result) return newest
      apply(next)
      return next
    })
    newest = result
    return result
  }

  // Changes are worked out from the state as it is, without waiting for a Lite self-test: one
  // that starts or ends is a change of its own and comes back here.
  const web = options.platform === 'web'
  const unsubscribeConnect = web
    ? options.connect?.subscribe((status) => {
        void evaluate(async () => status, false)
      })
    : undefined
  const unsubscribeLite = web
    ? options.lite?.subscribe(() => {
        void evaluate(async () => options.connect?.status, false)
      })
    : undefined

  return {
    get current() {
      return current
    },
    refresh(refreshOptions = {}) {
      const waitForLite = refreshOptions.waitForLite ?? true
      let pending = refreshing.get(waitForLite)
      if (pending === undefined) {
        pending = evaluate(() => detectConnect(options), waitForLite).finally(() => {
          refreshing.delete(waitForLite)
        })
        refreshing.set(waitForLite, pending)
      }
      return pending
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      unsubscribeConnect?.()
      unsubscribeLite?.()
      listeners.clear()
    },
  }
}
