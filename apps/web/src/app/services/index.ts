/**
 * The app's composition root (stage 2.9): see `README.md` in this folder and
 * `app-services.ts`. `main.tsx` calls {@link startAppServices} once, before the first render.
 *
 * @module
 */

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

let interim: InterimPlayer | undefined

/**
 * Wires the real platform, providers and player into the app. Resolves once the platform is
 * ready, which takes as long as FXM Connect's answer (a few milliseconds, at most 800), so the
 * first render already shows the right tier. Never rejects.
 */
export async function startAppServices(): Promise<void> {
  try {
    if (await devFakesOn()) return
    const app = getAppServices()
    await app.start()
    // The app's player until stage 2.5's lands (see player.ts).
    if (interim === undefined) {
      interim = createInterimPlayer({ resolver: app.resolver })
      app.connectPlayer(interim.player)
    }
  } catch (error) {
    console.error('FXM: could not start the music services', error)
  }
}
