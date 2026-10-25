/**
 * When FXM uses Spotify: only when the user's switch is on (it is on by default, owner's
 * decision of 2026-10-25) and the platform can reach Spotify (`capabilities.spotify` is
 * `anonymous` or `account`: FXM Connect on the web, the desktop app, the Android app). The
 * user's own Spotify account is used only after a second, explicit opt-in.
 *
 * The settings are stored by the app; these helpers give their defaults and read a stored value
 * safely. Wire the same stored values into the provider's `isEnabled` and `isAccountEnabled`
 * options, and ask `SpotifyProvider.isAvailable` (or {@link isSpotifyAvailable} with the stored
 * settings) before showing Spotify, so the UI and the provider never disagree.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'

/** The user's Spotify settings. */
export interface SpotifySettings {
  /** The on/off switch in Settings → Spotify. On by default. */
  enabled: boolean
  /**
   * Settings → Spotify → Connect your account: whether FXM may use the user's own Spotify login
   * (personal home, liked songs, playlists; read-only). Off by default; the opt-in shows the
   * account-risk notice.
   */
  account: boolean
}

/** A fresh install: Spotify on wherever the platform can reach it, the account not connected. */
export const DEFAULT_SPOTIFY_SETTINGS: Readonly<SpotifySettings> = Object.freeze({
  enabled: true,
  account: false,
})

/**
 * Whether the platform can reach Spotify, whatever the switch says. It fails closed: any value
 * other than `anonymous` or `account`, e.g. stale data, counts as unreachable.
 */
export function isSpotifyReachable(ctx: Pick<ProviderContext, 'capabilities'>): boolean {
  const access: unknown = ctx.capabilities.spotify
  return access === 'anonymous' || access === 'account'
}

/**
 * Whether the platform has a source of logged-in Spotify tokens (`capabilities.spotify` is
 * `account`): FXM Connect's session bridge, or a login window on desktop and Android. Offer
 * "Connect your account" only when this is true and Spotify is available.
 */
export function hasSpotifyLoginSource(ctx: Pick<ProviderContext, 'capabilities'>): boolean {
  return ctx.capabilities.spotify === 'account'
}

/**
 * Whether FXM should use Spotify now: the stored switch is on and the platform can reach
 * Spotify. Use it, or `SpotifyProvider.isAvailable`, to decide whether to show Spotify results,
 * radio and the source switch.
 *
 * @param settings The stored settings, read with {@link sanitizeSpotifySettings}.
 */
export function isSpotifyAvailable(
  ctx: Pick<ProviderContext, 'capabilities'>,
  settings: Pick<SpotifySettings, 'enabled'>,
): boolean {
  return settings.enabled !== false && isSpotifyReachable(ctx)
}

/**
 * Reads stored Spotify settings. The switch is off only when `false` was stored explicitly, so
 * missing or damaged data keeps the default (on). The account is connected only when `true` was
 * stored explicitly.
 */
export function sanitizeSpotifySettings(value: unknown): SpotifySettings {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return { enabled: stored.enabled !== false, account: stored.account === true }
}
