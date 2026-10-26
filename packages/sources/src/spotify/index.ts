/**
 * Spotify metadata and recommendations, built into FXM and on by default wherever the platform
 * can reach Spotify (switchable in Settings). It reads Spotify's web-player APIs from the user's
 * own device through the injected `ctx.fetch`: FXM Connect on the web, native HTTP in the desktop
 * and Android apps, Node in tests. Spotify supplies metadata only, never audio.
 *
 * ```ts
 * import { createSpotifyProvider, sanitizeSpotifySettings } from '@fxm/sources/spotify'
 *
 * const spotify = createSpotifyProvider({
 *   isEnabled: () => sanitizeSpotifySettings(stored.spotify).enabled,
 *   isAccountEnabled: () => sanitizeSpotifySettings(stored.spotify).account,
 * })
 * if (spotify.isAvailable(ctx)) {
 *   const results = await spotify.search('radiohead creep', { types: ['track', 'artist'] }, ctx)
 *   const radio = await spotify.radio(results.tracks?.items[0] ?? artistRef, ctx)
 * }
 * ```
 *
 * See the README in this folder: how it works, privacy, the clean-room log of every
 * persisted-query hash, the runtime config sources and the risks.
 *
 * @module
 */

export {
  DEFAULT_SPOTIFY_CONFIG,
  loadSpotifyConfig,
  parseSpotifyConfig,
  SPOTIFY_OPERATIONS,
  SPOTIFY_SECRET_SOURCE_HOSTS,
  type SpotifyConfig,
  type SpotifyEndpoints,
  type SpotifyOperationConfig,
  type SpotifyOperationName,
} from './config'
export {
  isSpotifyError,
  SPOTIFY_ERROR_REASONS,
  SPOTIFY_REASON_CODES,
  SpotifyError,
  type SpotifyErrorReason,
} from './errors'
export {
  gidToSpotifyId,
  isSpotifyId,
  parseSpotifyLink,
  parseSpotifyUri,
  type SpotifyRef,
  spotifyEntityIdFromLink,
  spotifyEntityIdFromUri,
  spotifyIdToGid,
  spotifyUri,
} from './ids'
export type {
  SpotifyAccountProfile,
  SpotifyHomeSectionPage,
  SpotifyLibraryPlaylist,
  SpotifyLikedTrack,
  SpotifyPlaylistPage,
  SpotifyTrackDetails,
} from './mapping'
export {
  createSpotifyProvider,
  DEFAULT_SPOTIFY_CACHE_TTLS,
  type SpotifyCacheTtls,
  type SpotifyHealth,
  SpotifyProvider,
  type SpotifyProviderOptions,
} from './provider'
export {
  checkSpotifySecretSource,
  createSpotifySecretProvider,
  deriveSpotifyTotpKey,
  type ParsedSpotifySecret,
  parseSpotifySecretJson,
  parseSpotifySecretSource,
  type SpotifySecretLoadOptions,
  type SpotifySecretProvider,
  type SpotifySecretProviderOptions,
  type SpotifySecretSource,
  type SpotifyTotpSecret,
} from './secret'
export {
  DEFAULT_SPOTIFY_SETTINGS,
  hasSpotifyLoginSource,
  isSpotifyAvailable,
  isSpotifyReachable,
  type SpotifySettings,
  sanitizeSpotifySettings,
} from './settings'
export type {
  SessionTokenSource,
  SpotifySecretPause,
  SpotifyTokenParams,
  SpotifyTokenResponse,
} from './token'
