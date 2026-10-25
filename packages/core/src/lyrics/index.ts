/**
 * Lyrics: read and write LRC ({@link parseLrc}, {@link serializeLrc}) and find the line or word
 * sung at a moment ({@link lineAt}, {@link wordAt}). The types (`Lyrics`, `LyricLine`,
 * `LyricWord`, `LyricsMetadata`) live with the `LyricsProvider` interface in `providers.ts`.
 *
 * @module
 */

export * from './lrc'
export * from './timing'
