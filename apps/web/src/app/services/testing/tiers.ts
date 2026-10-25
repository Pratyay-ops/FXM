/**
 * The app's services on each tier, for tests: the real composition root, platform, providers,
 * lifecycle and player, with the network faked at `fetch` (see `fake-network.ts`):
 *
 * - **Full:** a page with a fake FXM Connect, whose page `fetch` reaches every host;
 * - **Lite:** a page without FXM Connect, whose InnerTube calls go through a fake sandbox
 *   (the documents of stage 1.10) to the same network;
 * - **Free:** a page with neither, which reaches the CORS-friendly hosts only.
 *
 * Never import this from app code.
 *
 * @module
 */

import type { CatalogMode } from '@fxm/core'
import { createPlatform, type FxmPlatform, memoryStorage, type PlatformWindow } from '@fxm/platform'
import { createFakeSandbox, type FakeSandbox, installFakeConnect } from '@fxm/platform/testing'
import { createStaticNetworkMonitor } from '@fxm/player'
import { Window } from 'happy-dom'
import { createMediaActionsStore, type MediaActionsStore } from '../../../features/search/actions'
import {
  createMemorySpotifySwitch,
  createSources,
  type Sources,
  type Tier,
} from '../../../features/search/sources'
import { type AppServices, createAppServices } from '../app-services'
import { createMemoryStore, type DeviceStore } from '../device-store'
import type { LibraryRepository } from '../library'
import { createFakeNetwork, type FakeNetwork } from './fake-network'
import { FIXTURES } from './fixtures'

/** The FXM origin's app page, as the tests' page. */
export const APP_URL = 'https://fxmusic.pages.dev/app/'

/** Options for {@link servicesOnTier}. */
export interface TierSetup {
  /** The catalog mode. Default `music`. */
  readonly mode?: CatalogMode
  /** The user's Spotify switch. Default on. */
  readonly spotifyEnabled?: boolean
  /** The library (stage 2.6). Default: none. */
  readonly library?: LibraryRepository
  /** The network, to share one between setups. Default: a new one over the fixtures. */
  readonly network?: FakeNetwork
}

/** The services on one tier, with what a test looks at. */
export interface TierServices {
  readonly services: AppServices
  readonly network: FakeNetwork
  readonly sources: Sources
  readonly actions: MediaActionsStore
  /** Where the services keep the visitorData and the rung health. */
  readonly store: DeviceStore
  /** The fake sandbox, on the Lite tier. */
  readonly sandbox: FakeSandbox | undefined
  /** Waits for the platform and, on the Lite tier, for its self-test to pass. */
  ready(): Promise<FxmPlatform | undefined>
  /** Takes everything down. */
  dispose(): void
}

/** Creates the app's services on `tier`: see the module documentation. */
export function servicesOnTier(tier: Tier, setup: TierSetup = {}): TierServices {
  const network = setup.network ?? createFakeNetwork({ fixtures: FIXTURES })
  // Its own page at the FXM origin: in Vitest's global happy-dom page, a message's `source`
  // is not the page's window, so FXM Connect's messages would not count.
  const window = new Window({ url: APP_URL })
  const page = window as unknown as PlatformWindow
  const connect = tier === 'full' ? installFakeConnect(page) : undefined
  const sandbox =
    tier === 'lite'
      ? createFakeSandbox({
          respond: (request) =>
            network.respond({
              method: request.init.method,
              url: request.url,
              headers: request.init.headers,
              body: request.init.body,
            }),
        })
      : undefined
  const sources = createSources({
    spotifySwitch: createMemorySpotifySwitch(setup.spotifyEnabled ?? true),
  })
  const actions = createMediaActionsStore()
  const store = createMemoryStore()
  const mode = setup.mode ?? 'music'
  const services = createAppServices({
    createPlatform: (options) =>
      createPlatform({
        ...options,
        environment: 'browser',
        window: page,
        fetch: network.fetch,
        storage: memoryStorage(),
      }),
    sources,
    actions,
    deviceStore: store,
    network: createStaticNetworkMonitor(),
    jamendoClientId: undefined,
    catalogMode: () => mode,
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(setup.library === undefined ? {} : { library: setup.library }),
  })
  return {
    services,
    network,
    sources,
    actions,
    store,
    sandbox,
    async ready() {
      const platform = await services.start()
      if (tier === 'lite') await platform?.lite?.check()
      return platform
    },
    dispose() {
      services.dispose()
      connect?.uninstall()
      void window.happyDOM.close()
    },
  }
}
