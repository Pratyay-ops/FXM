/**
 * Spotify metadata and recommendations, built into FXM and on by default wherever the platform
 * can reach Spotify (switchable in Settings). It reads Spotify's web-player APIs from the user's
 * own device through the injected `ctx.fetch`: FXM Connect on the web, native HTTP in the desktop
 * and Android apps, Node in tests. Spotify supplies metadata only, never audio.
 *
 * ```ts
 * import { createSpotifyProvider, isSpotifyAvailable } from '@fxm/sources/spotify'
 *
 * const spotify = createSpotifyProvider({ isEnabled: () => settings.spotify.enabled })
 * if (isSpotifyAvailable(ctx, settings.spotify)) {
 *   const results = await spotify.search('radiohead creep', { types: ['track', 'artist'] }, ctx)
 *   const radio = await spotify.radio(results.tracks?.items[0] ?? artistRef, ctx)
 * }
 * ```
 *
 * See the README in this folder: how it works, the clean-room log of every persisted-query hash,
 * the runtime config sources and the risks.
 *
 * @module
 */

export {
  DEFAULT_SPOTIFY_CONFIG,
  loadSpotifyConfig,
  parseSpotifyConfig,
  SPOTIFY_OPERATIONS,
  type SpotifyConfig,
  type SpotifyEndpoints,
  type SpotifyOperationConfig,
  type SpotifyOperationName,
} from './config'
export {
  isSpotifyError,
  SPOTIFY_ERROR_REASONS,
  SpotifyError,
  type SpotifyErrorReason,
} from './errors'
export {
  base62ToHex,
  entityIdFromUri,
  hexToBase62,
  isSpotifyId,
  parseSpotifyLink,
  parseSpotifyUri,
  type SpotifyRef,
  spotifyUri,
} from './ids'
export type { HomeSectionPage, SpotifyTrackDetails } from './mapping'
export {
  createSpotifyProvider,
  DEFAULT_SPOTIFY_CACHE_TTLS,
  type SpotifyCacheTtls,
  type SpotifyHealth,
  SpotifyProvider,
  type SpotifyProviderOptions,
} from './provider'
export {
  createSecretProvider,
  deriveTotpKey,
  type ParsedSecret,
  parseSecretJson,
  type SecretProvider,
  type SecretProviderOptions,
  type SecretSource,
  type TotpSecret,
} from './secret'
export {
  canUseSpotifyAccount,
  DEFAULT_SPOTIFY_SETTINGS,
  isSpotifyAvailable,
  isSpotifyReachable,
  type SpotifySettings,
  sanitizeSpotifySettings,
} from './settings'
export type {
  SessionTokenSource,
  SpotifyAccessToken,
  SpotifyTokenParams,
  TokenEndpointResponse,
  TokenKind,
} from './token'
