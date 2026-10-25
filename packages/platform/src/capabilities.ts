/**
 * What the current platform can reach, as the `NetworkCapabilities` every `ProviderContext`
 * carries: how far YouTube and Spotify go, whether media bytes are readable and whether files
 * can be written outside browser storage. The UI reads them to show the right tier, and they
 * update when FXM Connect appears or goes away.
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
  /** Web: the Lite tier, whose self-test runs only when FXM Connect gives no full access. */
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

/** Capabilities from a known Connect status, running the Lite self-test only if it can help. */
async function capabilitiesWith(
  options: CapabilityOptions,
  connect: ConnectStatus | undefined,
): Promise<NetworkCapabilities> {
  const inputs = { ...staticInputs(options), connect }
  const withoutLite = resolveCapabilities(inputs)
  if (withoutLite.youtube !== 'none' || options.platform !== 'web' || options.lite === undefined) {
    return withoutLite
  }
  const lite = await options.lite.check().catch(() => false)
  return resolveCapabilities({ ...inputs, lite })
}

/**
 * Detects the capabilities once, in the order the architecture gives: FXM Connect first (marker
 * and ping), then, only when it gives no full YouTube access, the Lite tier's one-request
 * self-test, which honours the remote kill switch.
 */
export async function detectCapabilities(options: CapabilityOptions): Promise<NetworkCapabilities> {
  return capabilitiesWith(options, await detectConnect(options))
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

/** The current capabilities, kept up to date. */
export interface CapabilityMonitor {
  /**
   * The latest capabilities. Before the first detection finishes, those of a platform that has
   * found nothing yet (no FXM Connect, no Lite tier).
   */
  readonly current: NetworkCapabilities
  /**
   * Detects again, e.g. after the remote kill switches changed or the user re-ran the Lite
   * self-test, and resolves with the result. Concurrent calls share one detection.
   */
  refresh(): Promise<NetworkCapabilities>
  /**
   * Calls `listener` whenever the capabilities change: after a refresh, and by itself when FXM
   * Connect appears, changes or goes away. Returns a function that removes the listener.
   */
  subscribe(listener: (capabilities: NetworkCapabilities) => void): () => void
  /** Stops following FXM Connect. */
  dispose(): void
}

/**
 * Creates a monitor and starts following FXM Connect. Call `refresh()` once at start-up (as
 * `createPlatform` does) for the first detection.
 */
export function createCapabilityMonitor(options: CapabilityOptions): CapabilityMonitor {
  const listeners = new Set<(capabilities: NetworkCapabilities) => void>()
  let current = resolveCapabilities(staticInputs(options))
  let refreshing: Promise<NetworkCapabilities> | undefined
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
  ): Promise<NetworkCapabilities> {
    generation += 1
    const mine = generation
    // Start on a later tick: detection can notify synchronously, which starts a newer
    // evaluation, and `newest` must already point at this one by then.
    const result = Promise.resolve().then(async (): Promise<NetworkCapabilities> => {
      const next = await capabilitiesWith(options, await status())
      if (mine !== generation && newest !== undefined && newest !== result) return newest
      apply(next)
      return next
    })
    newest = result
    return result
  }

  const unsubscribe =
    options.platform === 'web'
      ? options.connect?.subscribe((status) => {
          void evaluate(async () => status)
        })
      : undefined

  return {
    get current() {
      return current
    },
    refresh() {
      refreshing ??= evaluate(() => detectConnect(options)).finally(() => {
        refreshing = undefined
      })
      return refreshing
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      unsubscribe?.()
      listeners.clear()
    },
  }
}
