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
import {
  createPlatform,
  type FxmPlatform,
  memoryStorage,
  type PlatformOptions,
  type PlatformWindow,
} from '@fxm/platform'
import {
  createFakeSandbox,
  type FakeConnect,
  type FakeConnectOptions,
  type FakeSandbox,
  installFakeConnect,
} from '@fxm/platform/testing'
import { createStaticNetworkMonitor } from '@fxm/player'
import { Window } from 'happy-dom'
import { createMediaActionsStore, type MediaActionsStore } from '../../../features/search/actions'
import {
  createMemorySpotifySwitch,
  createSources,
  type Sources,
  type SourcesSnapshot,
  type Tier,
} from '../../../features/search/sources'
import { type AppServices, type AppServicesOptions, createAppServices } from '../app-services'
import { markConnecting } from '../connecting'
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
  /** How the Full tier's fake FXM Connect behaves, e.g. `answerPings: false` to answer late. */
  readonly connect?: FakeConnectOptions
  /** Imports `@fxm/sources/youtube`, e.g. to hold it back. Default: `import()`. */
  readonly importYouTube?: AppServicesOptions['importYouTube']
  /**
   * Gives the page the sandbox documents of stage 1.10 on any tier, whose user-host document
   * answers with this: what the web app fetches from hosts outside its table, such as the
   * Spotify secret's. The Lite tier always has the sandbox; this adds its user-host document.
   */
  readonly userHost?: (url: string) => Response
}

/** The services on one tier, with what a test looks at. */
export interface TierServices {
  readonly services: AppServices
  readonly network: FakeNetwork
  readonly sources: Sources
  readonly actions: MediaActionsStore
  /** Where the services keep the visitorData and the rung health. */
  readonly store: DeviceStore
  /** The fake sandbox, on the Lite tier or with `userHost`. */
  readonly sandbox: FakeSandbox | undefined
  /** The Full tier's fake FXM Connect. */
  readonly connect: FakeConnect | undefined
  /** The options the services created the platform with, once they did. */
  readonly platformOptions: () => PlatformOptions | undefined
  /**
   * Waits for the platform and, on the Lite tier, for its self-test to pass, which waits for the
   * YouTube config's kill switch.
   */
  ready(): Promise<FxmPlatform | undefined>
  /** Takes everything down. */
  dispose(): void
}

/**
 * Resolves once the registry's snapshot passes `check`, and rejects after `timeoutMs`: the
 * capabilities follow a change of FXM Connect or of the Lite tier a few microtasks later.
 */
export function untilSources(
  sources: Sources,
  check: (snapshot: SourcesSnapshot) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  if (check(sources.getSnapshot())) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error('Timed out waiting for the sources'))
    }, timeoutMs)
    const stop = sources.subscribe(() => {
      if (!check(sources.getSnapshot())) return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })
}

/** Creates the app's services on `tier`: see the module documentation. */
export function servicesOnTier(tier: Tier, setup: TierSetup = {}): TierServices {
  const network = createFakeNetwork({ fixtures: FIXTURES })
  // Its own page at the FXM origin: in Vitest's global happy-dom page, a message's `source`
  // is not the page's window, so FXM Connect's messages would not count.
  const window = new Window({ url: APP_URL })
  const page = window as unknown as PlatformWindow
  const connect = tier === 'full' ? installFakeConnect(page, setup.connect) : undefined
  const { userHost } = setup
  const sandbox =
    tier === 'lite' || userHost !== undefined
      ? createFakeSandbox({
          respond: (request) =>
            network.respond({
              method: request.init.method,
              url: request.url,
              headers: request.init.headers,
              body: request.init.body,
            }),
          ...(userHost === undefined ? {} : { userHost: (url: string) => userHost(url) }),
        })
      : undefined
  const sources = createSources({
    spotifySwitch: createMemorySpotifySwitch(setup.spotifyEnabled ?? true),
  })
  // As main.tsx does before the first render: detecting while FXM Connect's marker is there.
  const stopConnecting = markConnecting(sources, page.document)
  const actions = createMediaActionsStore()
  const store = createMemoryStore()
  const mode = setup.mode ?? 'music'
  let platformOptions: PlatformOptions | undefined
  const services = createAppServices({
    createPlatform: (options) => {
      platformOptions = options
      return createPlatform({
        ...options,
        environment: 'browser',
        window: page,
        fetch: network.fetch,
        storage: memoryStorage(),
      })
    },
    sources,
    actions,
    deviceStore: store,
    network: createStaticNetworkMonitor(),
    jamendoClientId: undefined,
    catalogMode: () => mode,
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(setup.library === undefined ? {} : { library: setup.library }),
    ...(setup.importYouTube === undefined ? {} : { importYouTube: setup.importYouTube }),
  })
  return {
    services,
    network,
    sources,
    actions,
    store,
    sandbox,
    connect,
    platformOptions: () => platformOptions,
    async ready() {
      const platform = await services.start()
      if (tier === 'lite') {
        await services.youtube.load()
        await platform?.lite?.check()
        await untilSources(sources, (snapshot) => snapshot.capabilities.youtube === 'simple')
      }
      return platform
    },
    dispose() {
      stopConnecting()
      services.dispose()
      connect?.uninstall()
      void window.happyDOM.close()
    },
  }
}
