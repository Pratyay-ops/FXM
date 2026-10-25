/**
 * The development-only fake mode: plugs the fake catalog and fake actions into the app, at a
 * chosen tier, so the search and browse pages can be seen working before the real platform and
 * providers are wired in. Only `make dev` and screenshot builds (`VITE_FXM_FAKE_CATALOG=on`)
 * load this module; production builds leave it out.
 *
 * Open the app with `?fake=full` (FXM Connect: YouTube Music and Spotify), `?fake=lite` (the
 * experimental Lite tier) or `?fake=free` (no YouTube) to turn it on for the tab, and with
 * `?fake=off` to turn it off again.
 *
 * @module
 */

import type { MediaActionsStore } from './actions'
import { createStaticPlatform, type Sources, TIER_CAPABILITIES, type Tier } from './sources'

/** sessionStorage key that keeps the fake tier while the app navigates. */
export const FAKE_TIER_KEY = 'fxm.dev.fake-catalog'

const TIERS: readonly Tier[] = ['full', 'lite', 'free']

function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value)
}

/**
 * The fake tier for this tab: `?fake=<tier>` sets it, `?fake=off` clears it, and otherwise the
 * tier set earlier in this tab, if any.
 */
export function readFakeTier(
  search: string = window.location.search,
  storage: () => Storage | undefined = () => window.sessionStorage,
): Tier | undefined {
  const requested = new URLSearchParams(search).get('fake')
  try {
    const session = storage()
    if (requested === 'off') {
      session?.removeItem(FAKE_TIER_KEY)
      return undefined
    }
    if (isTier(requested)) {
      session?.setItem(FAKE_TIER_KEY, requested)
      return requested
    }
    const stored = session?.getItem(FAKE_TIER_KEY)
    return isTier(stored) ? stored : undefined
  } catch {
    // Storage blocked: the URL still decides for this page load.
    return isTier(requested) ? requested : undefined
  }
}

/** Turns the fake mode on when this tab asked for it (see the module documentation). */
export async function installDevFakes(sources: Sources, actions: MediaActionsStore): Promise<void> {
  const tier = readFakeTier()
  if (tier === undefined) return
  const [{ createFakeCatalog }, { createFakeMediaActions }, { showFeedback }] = await Promise.all([
    import('./fake-catalog'),
    import('./fake-actions'),
    import('./feedback'),
  ])
  // Providers first, then the tier, so the pages never see a tier without its providers.
  sources.register(createFakeCatalog('ytm', { latencyMs: 400 }))
  sources.register(createFakeCatalog('spotify', { latencyMs: 400 }))
  actions.set(createFakeMediaActions({ onAction: (what) => showFeedback(`Fake player: ${what}`) }))
  sources.setPlatform(createStaticPlatform(TIER_CAPABILITIES[tier]))
  console.info(`FXM: fake catalog on, ${tier} tier. Open the app with ?fake=off to leave it.`)
}
