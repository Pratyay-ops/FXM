/**
 * Test helpers for search and the album, artist and playlist pages: the real app, with the fake
 * catalog and fake actions plugged into its sources at a chosen tier. Never import this from
 * app code.
 *
 * @module
 */

import { Outlet, type RouteObject } from 'react-router'
import { routes } from '../../app/routes'
import { renderApp } from '../../test/render'
import { type MediaActions, MediaActionsProvider } from './actions'
import { useAddToPlaylistStore } from './catalog/add-to-playlist'
import { createFakeMediaActions } from './fake-actions'
import { createFakeCatalog } from './fake-catalog'
import { useFeedbackStore } from './feedback'
import { searchTiming, useSearchView } from './search-view'
import {
  createMemorySpotifySwitch,
  createSources,
  createStaticPlatform,
  TIER_CAPABILITIES,
  type Tier,
} from './sources'
import { SourcesProvider } from './sources-context'

/** How {@link renderCatalog} sets the app up. */
export interface CatalogSetup {
  /** The tier: what the platform reaches. Default `full`. */
  tier?: Tier
  /** The user's Spotify switch. Default on. */
  spotifyEnabled?: boolean
  /** Actions to use instead of the fake ones, e.g. `{}` for none. */
  actions?: MediaActions
}

/**
 * Renders the whole app at `path`, with fake YouTube Music and Spotify catalogs and fake
 * actions. Returns the fakes, so a test can change the tier (`platform.setCapabilities`),
 * inspect calls and make them fail.
 */
export function renderCatalog(path: string, setup: CatalogSetup = {}) {
  const platform = createStaticPlatform(TIER_CAPABILITIES[setup.tier ?? 'full'])
  const ytm = createFakeCatalog('ytm')
  const spotify = createFakeCatalog('spotify')
  const sources = createSources({
    platform,
    providers: [ytm, spotify],
    spotifySwitch: createMemorySpotifySwitch(setup.spotifyEnabled ?? true),
  })
  const actions = createFakeMediaActions()
  const wrapped: RouteObject[] = [
    {
      element: (
        <SourcesProvider sources={sources}>
          <MediaActionsProvider actions={setup.actions ?? actions}>
            <Outlet />
          </MediaActionsProvider>
        </SourcesProvider>
      ),
      children: routes,
    },
  ]
  return { ...renderApp(path, wrapped), sources, platform, ytm, spotify, actions }
}

const DEFAULT_TIMING = { ...searchTiming }

/** Resets the module-level state of the catalog pages; call it after each test. */
export function resetCatalogState(): void {
  useSearchView.setState(useSearchView.getInitialState(), true)
  useFeedbackStore.setState(useFeedbackStore.getInitialState(), true)
  useAddToPlaylistStore.setState(useAddToPlaylistStore.getInitialState(), true)
  Object.assign(searchTiming, DEFAULT_TIMING)
}
