/**
 * Lyrics from LRCLIB (https://lrclib.net), a free and open lyrics database that any origin may
 * call, so it works in every FXM app without FXM Connect.
 *
 * ```ts
 * import { createLrclibProvider } from '@fxm/sources/lrclib'
 *
 * const lyricsProvider = createLrclibProvider()
 * const lyrics = await lyricsProvider.getLyrics(track, ctx) // synced when LRCLIB has them
 * ```
 *
 * @module
 */

export { DEFAULT_LRCLIB_CLIENT, LRCLIB_ORIGIN } from './api'
export { createLrclibProvider, LRCLIB_PROVIDER_ID, type LrclibOptions } from './provider'
