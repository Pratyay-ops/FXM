/**
 * The app's composition root (stage 2.9): see `README.md` in this folder and
 * `app-services.ts`. `main.tsx` loads this module beside the first render and calls
 * {@link startAppServices}.
 *
 * @module
 */

import { appSources } from '../../features/search/sources-context'
import { type AppServices, createAppServices } from './app-services'
import { createInterimPlayer, type InterimPlayer } from './player'

export {
  type AppContextOptions,
  type AppServices,
  type AppServicesOptions,
  createAppServices,
} from './app-services'
export type { AppPlaybackPolicy } from './policy'

let services: AppServices | undefined

/** The app's services, created on first use. */
export function getAppServices(): AppServices {
  services ??= createAppServices()
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
let interim: InterimPlayer | undefined
let disconnect: (() => void) | undefined

async function start(): Promise<void> {
  try {
    if (await devFakesOn()) {
      // The fake catalog sets a tier of its own: nothing is detected.
      appSources.setDetecting(false)
      return
    }
    const app = getAppServices()
    // The player first: its resolver waits for the platform itself, so the play buttons work
    // while FXM Connect answers. It is the app's player until stage 2.5's lands (player.ts).
    interim = createInterimPlayer({ resolver: app.resolver })
    disconnect = app.connectPlayer(interim.player)
    await app.start()
  } catch (error) {
    console.error('FXM: could not start the music services', error)
    appSources.setDetecting(false)
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
 * Takes the app's services down again (the player, the platform's watchers, the registrations),
 * so that the next {@link startAppServices} starts afresh. For tests: the app keeps its services
 * for the page's life.
 */
export function stopAppServices(): void {
  disconnect?.()
  interim?.dispose()
  services?.dispose()
  disconnect = undefined
  interim = undefined
  services = undefined
  starting = undefined
}
