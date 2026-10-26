/**
 * What the Spotify account feature needs from the rest of the app, as one small seam: the
 * Spotify provider (stage 1.5) with this feature's opt-in as its `isAccountEnabled`, provider
 * contexts and capabilities from the platform (1.2), the Spotify switch (2.4) and the library
 * (2.6).
 *
 * The app has one Spotify provider: the composition root's (stage 2.9), created with this
 * feature's opt-in as its `isAccountEnabled` (`spotifyAccountOptedIn`). This module takes it
 * from there on first use; only where the root has none it builds one of its own over the app's
 * platform. Nothing is loaded or contacted until the user connects the account.
 *
 * @module
 */

import type { AccountStatus, NetworkCapabilities, ProviderContext } from '@fxm/core'
import type { FxmPlatform } from '@fxm/platform'
import type { SpotifyProvider } from '@fxm/sources/spotify'
import { getLibrary } from '../../db/repo'
import { appSources } from '../search/sources-context'
import { secretFetchFor } from './secret-fetch'
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

/** Wires in other services (another app shell, or a test), in place of the composition root's. */
export function setAppSpotifyAccountServices(services: SpotifyAccountServices): void {
  given = services
}

/**
 * The app's services: those wired in, else the composition root's (stage 2.9) Spotify provider
 * over the app's platform, so the app has one provider; only where the root has none (it could
 * not start, or Spotify can't be read there) a provider of this feature's own over the app's
 * platform. Built on first use.
 */
export function loadAppSpotifyAccountServices(
  isAccountEnabled: () => boolean,
): Promise<SpotifyAccountServices> {
  if (given !== undefined) return Promise.resolve(given)
  built ??= (async () => {
    const { getAppServices } = await import('../../app/services')
    const app = getAppServices()
    const platform = await app.start()
    // The root registers its provider only where Spotify can be read (`canReadSpotify`).
    if (platform !== undefined && app.sources.getSnapshot().providers.has('spotify')) {
      return servicesFrom(platform, await app.spotify.load())
    }
    const [{ getAppPlatform }, { createSpotifyProvider, SPOTIFY_SECRET_SOURCE_HOSTS }] =
      await Promise.all([import('../connect/app-platform'), import('@fxm/sources/spotify')])
    const own = await getAppPlatform()
    const session = own.spotifySession
    const secretFetch = secretFetchFor(own, SPOTIFY_SECRET_SOURCE_HOSTS)
    const spotify: SpotifyProvider = createSpotifyProvider({
      isEnabled: () => appSources.getSnapshot().spotifyEnabled,
      isAccountEnabled,
      ...(session === undefined ? {} : { session }),
      ...(secretFetch === undefined ? {} : { secretFetch }),
    })
    return servicesFrom(own, spotify)
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
