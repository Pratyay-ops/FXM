/**
 * The app's composition root (stage 2.9): see `README.md` in this folder and
 * `app-services.ts`. `main.tsx` loads this module beside the first render and calls
 * {@link startAppServices}.
 *
 * @module
 */

import { getLibrary } from '../../db/repo'
import { withLocalFilesFirst } from '../../features/local-files/player'
import { getPlayer } from '../../features/now-playing/playback'
import {
  connectAppPolicy,
  createPendingPolicy,
  type PlaybackPolicy,
} from '../../features/now-playing/playback-policy'
import { appSources } from '../../features/search/sources-context'
import { type AppServices, createAppServices } from './app-services'
import { lazyLibrary } from './library'

export {
  type AppContextOptions,
  type AppServices,
  type AppServicesOptions,
  createAppServices,
} from './app-services'
export type { AppPlaybackPolicy } from './policy'

let services: AppServices | undefined

/**
 * The app's services, created on first use, with the library of stage 2.6 ("Add to playlist" and
 * the match cache), whose database opens on first use.
 */
export function getAppServices(): AppServices {
  services ??= createAppServices({ library: lazyLibrary(getLibrary) })
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

async function start(): Promise<void> {
  let connected = false
  /** Makes the app's player play through `policy`, with local files in front (stage 4.4). */
  const play = (policy: PlaybackPolicy) => {
    disconnects.push(connectAppPolicy(withLocalFilesFirst(policy)))
    connected = true
  }
  try {
    if (await devFakesOn()) {
      // The fake catalog sets a tier of its own: nothing is detected. Its play buttons play
      // nothing, so the app's player plays local files only.
      appSources.setDetecting(false)
      play(createPendingPolicy())
      return
    }
    const app = getAppServices()
    // The app's player (stage 2.5, created with the first render) plays through the services'
    // policy, whose resolver waits for the platform itself: the play buttons work while FXM
    // Connect answers.
    play(app.policy)
    disconnects.push(app.connectPlayer(getPlayer()))
    await app.start()
  } catch (error) {
    console.error('FXM: could not start the music services', error)
    appSources.setDetecting(false)
    // Nothing else will connect a policy: plays stop with a reason rather than wait.
    if (!connected) play(createPendingPolicy())
  }
}

/**
 * Wires the real platform, providers and player into the app, once however often it is called.
 * Resolves once the platform is ready, which takes as long as FXM Connect's answer (a few
 * milliseconds, at most 800). Never rejects.
 */
export function startAppServices(): Promise<void> {
  starting ??= start()
  return starting
}

/**
 * Takes the app's services down again (the player's policy and connection, the platform's
 * watchers, the registrations), so that the next {@link startAppServices} starts afresh. For
 * tests: the app keeps its services for the page's life.
 */
export function stopAppServices(): void {
  for (const disconnect of disconnects.splice(0)) disconnect()
  services?.dispose()
  services = undefined
  starting = undefined
}
