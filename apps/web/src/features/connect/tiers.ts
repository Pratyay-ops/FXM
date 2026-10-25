/**
 * FXM's three tiers, as the user sees them: what each one plays and what the current one is
 * missing (docs/ARCHITECTURE.md §8).
 *
 * - **Free only:** free music in any browser, with nothing to install.
 * - **Lite (experimental):** YouTube Music without an install, where the browser passes the Lite
 *   self-test and the remote kill switch is off.
 * - **Full:** FXM Connect, the desktop app or the Android app: everything.
 *
 * The tier follows from the platform's `NetworkCapabilities` alone (`tierOf`), so the panels
 * always agree with what the providers can reach.
 *
 * @module
 */

import type { NetworkCapabilities } from '@fxm/core'
import { RELEASED } from './config'

/** The tier FXM runs in. */
export type Tier = 'free' | 'lite' | 'full'

/** The tiers, from the least to the most. */
export const TIERS: readonly Tier[] = ['free', 'lite', 'full']

/** The tier the capabilities give: YouTube `full` is Full, `simple` is Lite, `none` Free only. */
export function tierOf(capabilities: Pick<NetworkCapabilities, 'youtube'>): Tier {
  if (capabilities.youtube === 'full') return 'full'
  return capabilities.youtube === 'simple' ? 'lite' : 'free'
}

/** Whether tier `a` has everything tier `b` has. */
export function includesTier(a: Tier, b: Tier): boolean {
  return TIERS.indexOf(a) >= TIERS.indexOf(b)
}

/** How a tier presents itself. */
export interface TierInfo {
  /** Its name: Free only, Lite or Full. */
  readonly name: string
  /** Whether it is marked experimental (Lite). */
  readonly experimental: boolean
  /** What it plays, in one sentence. */
  readonly summary: string
  /** How a browser or app gets it. */
  readonly how: string
}

/** The three tiers. */
export const TIER_INFO: Readonly<Record<Tier, TierInfo>> = {
  free: {
    name: 'Free only',
    experimental: false,
    summary: 'Free music from Internet Archive and Jamendo.',
    how: 'Any browser, with nothing to install.',
  },
  lite: {
    name: 'Lite',
    experimental: true,
    summary: 'YouTube Music and free music, without installing anything.',
    how: 'Turns on by itself in browsers that pass its check.',
  },
  full: {
    name: 'Full',
    experimental: false,
    summary: 'Everything FXM offers, Spotify included.',
    how: 'FXM Connect, the desktop app or the Android app.',
  },
}

/** "Lite (experimental)": a tier's name with its marker. */
export function tierLabel(tier: Tier): string {
  const info = TIER_INFO[tier]
  return info.experimental ? `${info.name} (experimental)` : info.name
}

/**
 * Why Lite is experimental. YouTube answers CORS-simple requests from an opaque origin, which
 * Google doesn't document (measured 2026-10-25), so FXM checks it in each browser first.
 */
export const LITE_CAVEAT =
  "Lite relies on a way of reaching YouTube Music that YouTube doesn't document. FXM checks it in your browser before using it, and it may stop working at any time."

/** Something a tier gives the user. */
export interface TierFeature {
  /** A stable ID, for keys and tests. */
  readonly id: string
  /** What the user gets. */
  readonly label: string
  /** The lowest tier that has it. */
  readonly from: Tier
  /** Whether it is released; the panels mark the others "Coming soon". */
  readonly released: boolean
}

/** What the tiers give, in the order the panels list it. */
export const TIER_FEATURES: readonly TierFeature[] = [
  {
    id: 'free-sources',
    label: 'Free music from Internet Archive and Jamendo, in lossless FLAC where they have it',
    from: 'free',
    released: true,
  },
  {
    id: 'library',
    label: 'Your library, playlists and history, kept on this device',
    from: 'free',
    released: true,
  },
  { id: 'lyrics', label: 'Synced lyrics', from: 'free', released: true },
  { id: 'local-files', label: 'Your own music files', from: 'free', released: RELEASED.localFiles },
  {
    id: 'youtube-music',
    label: 'YouTube Music: search, albums, artists and playlists',
    from: 'lite',
    released: true,
  },
  { id: 'youtube-audio', label: 'Ad-free YouTube Music audio', from: 'lite', released: true },
  {
    id: 'spotify',
    label: 'Spotify search and related artists, built in (you can switch it off)',
    from: 'full',
    released: true,
  },
  {
    id: 'spotify-account',
    label: 'Your Spotify recommendations, liked songs and playlists, read-only',
    from: 'full',
    released: RELEASED.spotifyAccount,
  },
  {
    id: 'downloads',
    label: 'Downloads of YouTube Music songs, in the format you want',
    from: 'full',
    released: RELEASED.downloads,
  },
]

/** Whether `tier` gives `feature`. */
export function hasFeature(tier: Tier, feature: TierFeature): boolean {
  return includesTier(tier, feature.from)
}

/** The features `tier` adds to the tier below it. */
export function featuresAddedBy(tier: Tier): TierFeature[] {
  return TIER_FEATURES.filter((feature) => feature.from === tier)
}

/** What the user would gain above `tier`, grouped by the tier that adds it, lowest first. */
export function missingFeatures(tier: Tier): { tier: Tier; features: TierFeature[] }[] {
  return TIERS.filter((other) => !includesTier(tier, other)).map((other) => ({
    tier: other,
    features: featuresAddedBy(other),
  }))
}
