/**
 * The app's composition root (stage 2.9): see `README.md` in this folder and
 * `app-services.ts`. `main.tsx` loads this module beside the first render and calls
 * {@link startAppServices}.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { getLibrary } from '../../db/repo'
import {
  APP_PLATFORM_REACHES_USER_HOSTS,
  getAppPlatform,
  setAppUserHosts,
} from '../../features/connect/app-platform'
import { recheckConnection } from '../../features/connect/connection'
import { appKillSwitches, setKillSwitchSource } from '../../features/connect/kill-switches'
import {
  fromAudioSource,
  getSongResolver,
  setSongResolver,
  unavailableResolver,
} from '../../features/connect/resolver'
import { connectDownloadEnvironment } from '../../features/downloads/environment'
import { appHomeServices, staticSources } from '../../features/home/services'
import { connectAppImportServices } from '../../features/import/services'
import { withLocalFilesFirst } from '../../features/local-files/player'
import { getPlayer } from '../../features/now-playing/playback'
import {
  connectAppPolicy,
  createPendingPolicy,
  type PlaybackPolicy,
} from '../../features/now-playing/playback-policy'
import { appActions } from '../../features/search/actions'
import { appSources } from '../../features/search/sources-context'
import { connectAppContext } from '../../lib/app-context'
import { type AppServices, createAppServices } from './app-services'
import type { DesktopLifecycleOptions } from './desktop'
import { appDownloadActions, createAppDownloadEnvironment } from './downloads'
import { createAppHomeServices } from './home'
import { createAppImportServices } from './imports'
import { lazyLibrary } from './library'
import type { YouTube } from './youtube'

export {
  type AppContextOptions,
  type AppServices,
  type AppServicesOptions,
  createAppServices,
} from './app-services'
export type { AppPlaybackPolicy } from './policy'

/** What `main.tsx` hands to {@link startAppServices}. */
export interface AppSetup {
  /** In the desktop app: the stream lifecycle's URL margin and network monitor (stage 7.3). */
  readonly desktop?: DesktopLifecycleOptions | undefined
}

let services: AppServices | undefined
let setup: AppSetup = {}

/**
 * Shares what YouTube's code brings with stage 2.7's connection store: the kill switches of the
 * YouTube config in use (the bundled one, or a newer signed one from FXM's site, stage 1.13),
 * which the app's platform reads, and a changed Lite switch re-checks the tier, now and whenever
 * the config in use changes; and the stream ladder for the Diagnostics self-test, unless a
 * resolver is set already (the development fake mode's `?fake-song=`).
 */
function shareYouTube(youtube: YouTube): void {
  let lite = Boolean(youtube.killSwitches().lite)
  const liteChanged = Boolean(appKillSwitches().lite) !== lite
  setKillSwitchSource(() => youtube.killSwitches())
  if (liteChanged) void recheckConnection()
  youtube.subscribe(() => {
    const next = Boolean(youtube.killSwitches().lite)
    if (next === lite) return
    lite = next
    void recheckConnection()
  })
  if (getSongResolver() === unavailableResolver) setSongResolver(fromAudioSource(youtube.audio))
}

/**
 * The app's services, created on first use: on the app's one platform, which stage 2.7's
 * connection store follows too (`getAppPlatform()`: FXM Connect, the Lite tier's sandbox
 * documents in a browser, the kill switches, the Spotify secret's hosts), with the library of
 * stage 2.6 ("Add to playlist" and the match cache), whose database opens on first use.
 */
export function getAppServices(): AppServices {
  const desktop = setup.desktop
  services ??= createAppServices({
    createPlatform: (options) => {
      // The hosts the services may fetch from outside the platform's table: the Spotify secret's.
      setAppUserHosts(options.userHosts)
      return getAppPlatform()
    },
    reachesUserHosts: APP_PLATFORM_REACHES_USER_HOSTS,
    library: lazyLibrary(getLibrary),
    onYouTube: shareYouTube,
    ...(desktop === undefined
      ? {}
      : { network: desktop.network, refreshBeforeExpiryMs: desktop.refreshBeforeExpiryMs }),
  })
  return services
}

/**
 * Whether the development-only fake catalog is on for this tab (`?fake=full` and the like,
 * see `features/search/dev-fakes.ts`): it plugs its own sources and actions in, so the real ones
 * stay out. Production builds drop this check with the fake catalog.
 */
async function devFakesOn(): Promise<boolean> {
  if (!(import.meta.env.DEV || import.meta.env.VITE_FXM_FAKE_CATALOG === 'on')) return false
  const { readFakeTier } = await import('../../features/search/dev-fakes')
  return readFakeTier() !== undefined
}

let starting: Promise<void> | undefined
const disconnects: (() => void)[] = []

/** `actions` without its downloads group. */
function withoutDownloads({ downloads: _downloads, ...rest }: ReturnType<typeof appActions.get>) {
  return rest
}

/**
 * Plugs the features that need the platform itself into it, once it is ready: lyrics,
 * SponsorBlock and scrobbling (their context), downloads (their environment and the catalog's
 * Download entries) and Home (its sources, recommendations, catalog and playback).
 */
function connectFeatures(app: AppServices): void {
  disconnects.push(
    connectAppContext(({ mode, signal }) =>
      app.context({ priority: 'interactive', mode, ...(signal === undefined ? {} : { signal }) }),
    ),
    connectDownloadEnvironment(createAppDownloadEnvironment(app)),
  )
  appActions.set({ ...appActions.get(), downloads: appDownloadActions })
  disconnects.push(() => {
    if (appActions.get().downloads === appDownloadActions) {
      appActions.set(withoutDownloads(appActions.get()))
    }
  })
  const home = createAppHomeServices(app, {
    playback: appActions.get().playback,
    spotify: app.sources.getSnapshot().providers.has('spotify'),
  })
  appHomeServices.set(home)
  disconnects.push(() => {
    if (appHomeServices.get() === home) appHomeServices.set({ sources: staticSources() })
  })
}

async function start(): Promise<void> {
  let connected = false
  /** Makes the app's player play through `policy`, with local files in front (stage 4.4). */
  const play = (policy: PlaybackPolicy) => {
    disconnects.push(connectAppPolicy(withLocalFilesFirst(policy)))
    connected = true
  }
  /** Imports can't run here: they say why rather than wait for services that never come. */
  const noImports = (error: unknown) => {
    disconnects.push(connectAppImportServices(() => Promise.reject(error)))
  }
  try {
    if (await devFakesOn()) {
      // The fake catalog sets a tier of its own: nothing is detected. Its play buttons play
      // nothing, so the app's player plays local files only.
      appSources.setDetecting(false)
      play(createPendingPolicy())
      noImports(new FxmError('Unsupported', 'The development fake catalog has no imports'))
      return
    }
    const app = getAppServices()
    // The app's player (stage 2.5, created with the first render) plays through the services'
    // policy, whose resolver waits for the platform itself: the play buttons work while FXM
    // Connect answers. Imports wait for the platform the same way.
    play(app.policy)
    disconnects.push(
      app.connectPlayer(getPlayer()),
      connectAppImportServices(() => createAppImportServices(app)),
    )
    const platform = await app.start()
    if (platform !== undefined) connectFeatures(app)
  } catch (error) {
    console.error('FXM: could not start the music services', error)
    appSources.setDetecting(false)
    // Nothing else will connect a policy: plays stop with a reason rather than wait.
    if (!connected) play(createPendingPolicy())
    noImports(error)
  }
}

/**
 * Wires the real platform, providers and player into the app, once however often it is called
 * (the setup of the first call counts). Resolves once the platform is ready, which takes as long
 * as FXM Connect's answer (a few milliseconds, at most 800). Never rejects.
 */
export function startAppServices(appSetup: AppSetup = {}): Promise<void> {
  if (starting === undefined) {
    setup = appSetup
    starting = start()
  }
  return starting
}

/**
 * Takes the app's services down again (the player's policy and connection, the platform's
 * watchers, the registrations, the features plugged into them), so that the next
 * {@link startAppServices} starts afresh. For tests: the app keeps its services for the page's
 * life.
 */
export function stopAppServices(): void {
  for (const disconnect of disconnects.splice(0)) disconnect()
  services?.dispose()
  services = undefined
  starting = undefined
  setup = {}
}
