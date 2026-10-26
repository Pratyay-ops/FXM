/**
 * The app's Spotify account: the user's choice (the opt-in), the runtime, built on first use,
 * and Home's view of the account. `main.tsx` calls {@link startSpotifyAccount} once; it loads and
 * contacts nothing unless the account is connected.
 *
 * Where the composition root (stage 2.9) builds the app's Spotify provider, it passes
 * {@link spotifyAccountOptedIn} as the provider's `isAccountEnabled` and hands the provider in
 * with `setAppSpotifyAccountServices` (`services.ts`).
 *
 * @module
 */

import type { ProviderContext, Shelf } from '@fxm/core'
import { appHomeServices } from '../home/services'
import { createAccountChoice, syncAccountChoiceAcrossTabs } from './account-store'
import type { AccountForHome, AccountRuntime } from './runtime'

/** The app's choice (the opt-in), persisted and followed across tabs. */
export const appAccountChoice = createAccountChoice()
syncAccountChoiceAcrossTabs(appAccountChoice)

/**
 * Whether the user connected their Spotify account in FXM: the Spotify provider's
 * `isAccountEnabled`.
 */
export function spotifyAccountOptedIn(): boolean {
  return appAccountChoice.getState().optedIn
}

let runtime: Promise<AccountRuntime> | undefined
let loaded: AccountRuntime | undefined

/** The app's runtime, built (and started) on first use. */
export function getAppAccountRuntime(): Promise<AccountRuntime> {
  runtime ??= (async () => {
    const [{ loadAppSpotifyAccountServices }, { createAccountRuntime }] = await Promise.all([
      import('./services'),
      import('./runtime'),
    ])
    const services = await loadAppSpotifyAccountServices(spotifyAccountOptedIn)
    const created = createAccountRuntime({ services, choice: appAccountChoice })
    created.start()
    loaded = created
    return created
  })().catch((error: unknown) => {
    runtime = undefined
    throw error
  })
  return runtime
}

/** The app's runtime once it is built, else `undefined`. */
export function currentAppAccountRuntime(): AccountRuntime | undefined {
  return loaded
}

/**
 * Home's view of the account (stage 3.3's `HomeSpotifyAccount`): not connected, and no
 * sections, without loading anything, until the user connects the account.
 */
export const spotifyAccountForHome: AccountForHome = {
  async status(ctx: ProviderContext) {
    if (!spotifyAccountOptedIn()) return { connected: false }
    return (await getAppAccountRuntime()).forHome.status(ctx)
  },
  async sections(ctx: ProviderContext): Promise<readonly Shelf[]> {
    if (!spotifyAccountOptedIn()) return []
    return (await getAppAccountRuntime()).forHome.sections(ctx)
  },
}

/**
 * Starts the feature, once, from `main.tsx`: Home gets its view of the account, and the runtime
 * starts when the account is connected (in this tab or, later, another).
 */
export function startSpotifyAccount(): void {
  appHomeServices.set({ ...appHomeServices.get(), spotifyAccount: spotifyAccountForHome })
  const run = () => {
    getAppAccountRuntime().catch((error: unknown) => {
      console.error('FXM: the Spotify account could not start', error)
    })
  }
  if (spotifyAccountOptedIn()) run()
  appAccountChoice.subscribe((state, previous) => {
    if (state.optedIn && !previous.optedIn) run()
  })
}
