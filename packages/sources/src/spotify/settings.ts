/**
 * When FXM uses Spotify: only when the user's switch is on (it is on by default, owner's
 * decision of 2026-10-25) and the platform can reach Spotify (`capabilities.spotify` is
 * `anonymous` or `account`: FXM Connect on the web, the desktop app, the Android app).
 *
 * The switch itself is an app setting, stored by the app; these helpers give its default and
 * read a stored value safely.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'

/** The user's Spotify settings. */
export interface SpotifySettings {
  /** The on/off switch in Settings → Spotify. */
  enabled: boolean
}

/** A fresh install: Spotify on, wherever the platform can reach it. */
export const DEFAULT_SPOTIFY_SETTINGS: Readonly<SpotifySettings> = Object.freeze({ enabled: true })

/**
 * Whether the platform can reach Spotify, whatever the switch says. It fails closed: any value
 * other than `anonymous` or `account`, e.g. stale data, counts as unreachable.
 */
export function isSpotifyReachable(ctx: Pick<ProviderContext, 'capabilities'>): boolean {
  const access: unknown = ctx.capabilities.spotify
  return access === 'anonymous' || access === 'account'
}

/**
 * Whether a logged-in token source exists on this platform (`capabilities.spotify` is
 * `account`).
 */
export function canUseSpotifyAccount(ctx: Pick<ProviderContext, 'capabilities'>): boolean {
  return ctx.capabilities.spotify === 'account'
}

/**
 * Whether FXM should use Spotify now: the switch is on (the default) and the platform can reach
 * it. Use it to decide whether to show Spotify results, radio and the source switch.
 */
export function isSpotifyAvailable(
  ctx: Pick<ProviderContext, 'capabilities'>,
  settings: Pick<SpotifySettings, 'enabled'> = DEFAULT_SPOTIFY_SETTINGS,
): boolean {
  return settings.enabled !== false && isSpotifyReachable(ctx)
}

/**
 * Reads stored Spotify settings: the switch is off only when it was explicitly stored as
 * `false`, so missing or damaged data keeps the default (on).
 */
export function sanitizeSpotifySettings(value: unknown): SpotifySettings {
  const enabled =
    typeof value === 'object' && value !== null
      ? (value as { enabled?: unknown }).enabled
      : undefined
  return { enabled: enabled !== false }
}
