/**
 * What the Spotify account feature needs from the rest of the app, as one small seam: the
 * Spotify provider (stage 1.5) with this feature's opt-in as its `isAccountEnabled`, provider
 * contexts and capabilities from the platform (1.2), the Spotify switch (2.4) and the library
 * (2.6).
 *
 * The app's provider should be shared by every feature. Until the composition root (stage 2.9)
 * wires one in with {@link setAppSpotifyAccountServices}, this module builds its own on first
 * use, from the app's one platform (`getAppPlatform()`, stage 2.7), so the account works on
 * `develop` already. Nothing is loaded or contacted until the user connects the account.
 *
 * @module
 */

import {
  type AccountStatus,
  type Fetch,
  FxmError,
  type NetworkCapabilities,
  type ProviderContext,
} from '@fxm/core'
import type { FxmPlatform } from '@fxm/platform'
import type { SpotifyProvider } from '@fxm/sources/spotify'
import { getLibrary } from '../../db/repo'
import { appSources } from '../search/sources-context'
import type { SyncLibrary, SyncSpotify } from './sync'

/** What the feature uses of the Spotify provider: its logged-in calls and its account switches. */
export interface AccountSpotify extends SyncSpotify {
  /** Whether the account is logged in (`SpotifyProvider.status`). */
  status(ctx: ProviderContext): Promise<AccountStatus>
  /** Allows the account again, and asks the login source at once. */
  connect(): void
  /** Stops using the account at once and forgets its token. */
  disconnect(): void
}

/** What the feature needs from the app. */
export interface SpotifyAccountServices {
  /** The Spotify provider, with the feature's opt-in as its `isAccountEnabled`. */
  readonly spotify: AccountSpotify
  /** The library. */
  readonly library: SyncLibrary
  /** A provider context for one call, at a request priority. */
  context(priority: 'interactive' | 'bulk', signal?: AbortSignal): ProviderContext
  /** What the platform reaches now. */
  capabilities(): NetworkCapabilities
  /** Whether the user's Spotify switch is on. */
  spotifyEnabled(): boolean
  /** Calls `listener` when the capabilities or the switch change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /**
   * Detects FXM Connect again, e.g. after the user turned its Spotify login on in its options
   * (in another tab, which FXM Connect doesn't announce).
   */
  refresh(): Promise<void>
}

/**
 * The `fetch` for the TOTP secret's community sources (which the provider needs for every
 * token, the account's too). Their hosts aren't in the app's content security policy: in a
 * browser the secret goes through the Lite tier's sandboxed user-host document (stage 1.10),
 * GET only and size-capped. `make dev` doesn't serve that document and has no policy, so there
 * the page fetches it directly. Only the provider's secret hosts are allowed.
 */
export function createSecretFetch(options: {
  readonly hosts: readonly string[]
  readonly userHost?: (
    url: string,
    init: { method: 'GET'; signal?: AbortSignal },
  ) => Promise<Response>
  readonly direct?: Fetch
}): Fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    if (url.protocol !== 'https:' || !options.hosts.includes(url.hostname)) {
      throw new FxmError('Unsupported', `FXM doesn't read Spotify's secret from ${url.hostname}`)
    }
    const signal = init?.signal ?? undefined
    if (options.userHost) {
      return options.userHost(url.href, { method: 'GET', ...(signal ? { signal } : {}) })
    }
    if (options.direct) {
      return options.direct(url.href, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      })
    }
    throw new FxmError('Unsupported', "FXM can't read Spotify's secret here")
  }
}

/** The secret's `fetch` on `platform` (see {@link createSecretFetch}), or none outside a browser. */
function secretFetchFor(platform: FxmPlatform, hosts: readonly string[]): Fetch | undefined {
  if (platform.environment !== 'browser') return undefined
  if (import.meta.env.DEV)
    return createSecretFetch({ hosts, direct: globalThis.fetch.bind(globalThis) })
  const sandbox = platform.lite?.sandbox
  const userHost = sandbox?.userHost?.bind(sandbox)
  return userHost === undefined ? undefined : createSecretFetch({ hosts, userHost })
}

/** Builds the services over the app's platform, a provider and the library. */
export function servicesFrom(
  platform: Pick<FxmPlatform, 'context' | 'capabilities'>,
  spotify: AccountSpotify,
  library: SyncLibrary = getLibrary(),
): SpotifyAccountServices {
  return {
    spotify,
    library,
    // Every mode: the sync copies what Spotify holds, and Home filters what it shows.
    context: (priority, signal) =>
      platform.context({ mode: 'all', priority, ...(signal === undefined ? {} : { signal }) }),
    capabilities: () => platform.capabilities.current,
    async refresh() {
      await platform.capabilities.refresh({ waitForLite: false })
    },
    spotifyEnabled: () => appSources.getSnapshot().spotifyEnabled,
    subscribe(listener) {
      const stopCapabilities = platform.capabilities.subscribe(() => listener())
      let enabled = appSources.getSnapshot().spotifyEnabled
      const stopSources = appSources.subscribe(() => {
        const now = appSources.getSnapshot().spotifyEnabled
        if (now === enabled) return
        enabled = now
        listener()
      })
      return () => {
        stopCapabilities()
        stopSources()
      }
    },
  }
}

let given: SpotifyAccountServices | undefined
let built: Promise<SpotifyAccountServices> | undefined

/**
 * Wires in the app's own services: the composition root (stage 2.9) passes the app's shared
 * Spotify provider, created with `isAccountEnabled: spotifyAccountOptedIn` (`start.ts`).
 */
export function setAppSpotifyAccountServices(services: SpotifyAccountServices): void {
  given = services
}

/**
 * The app's services: those wired in, or a provider of this feature's own over the app's
 * platform, built on first use.
 */
export function loadAppSpotifyAccountServices(
  isAccountEnabled: () => boolean,
): Promise<SpotifyAccountServices> {
  if (given !== undefined) return Promise.resolve(given)
  built ??= (async () => {
    const [{ getAppPlatform }, { createSpotifyProvider, SPOTIFY_SECRET_SOURCE_HOSTS }] =
      await Promise.all([import('../connect/app-platform'), import('@fxm/sources/spotify')])
    const platform = await getAppPlatform()
    const session = platform.spotifySession
    const secretFetch = secretFetchFor(platform, SPOTIFY_SECRET_SOURCE_HOSTS)
    const spotify: SpotifyProvider = createSpotifyProvider({
      isEnabled: () => appSources.getSnapshot().spotifyEnabled,
      isAccountEnabled,
      ...(session === undefined ? {} : { session }),
      ...(secretFetch === undefined ? {} : { secretFetch }),
    })
    return servicesFrom(platform, spotify)
  })().catch((error: unknown) => {
    built = undefined
    throw error
  })
  return built
}

/** Tests: forgets the wired-in and built services. */
export function resetAppSpotifyAccountServices(): void {
  given = undefined
  built = undefined
}
