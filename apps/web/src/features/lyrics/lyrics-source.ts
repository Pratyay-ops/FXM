/**
 * Where lyrics come from: LRCLIB, through the provider of stage 1.8 (`@fxm/sources/lrclib`).
 * LRCLIB answers every origin, so lyrics work on every tier, with or without FXM Connect.
 *
 * @module
 */

import type { CatalogMode, LyricsProvider, ProviderContext, QueueItem, Track } from '@fxm/core'
import { createLrclibProvider } from '@fxm/sources/lrclib'
import { isMatched } from '../now-playing/stream-label'

let provider: LyricsProvider | undefined

/**
 * The app's lyrics provider. One instance for the app, because it sends LRCLIB one request at a
 * time, as LRCLIB asks.
 */
export function getLyricsProvider(): LyricsProvider {
  provider ??= createLrclibProvider()
  return provider
}

/** Replaces the lyrics provider, e.g. with a fake in tests; `undefined` goes back to LRCLIB. */
export function setLyricsProvider(next: LyricsProvider | undefined): void {
  provider = next
}

/**
 * The provider context for lyrics requests: the page's own `fetch`, without cookies. LRCLIB is
 * CORS-friendly, so this reaches it on every tier, and it is the only service lyrics contact,
 * so the capabilities stay at their most limited.
 *
 * Integration with stage 1.2 (platform transports): use the platform's context instead, so the
 * desktop and Android apps send lyrics requests through their native HTTP clients.
 */
export function lyricsContext(mode: CatalogMode, signal: AbortSignal): ProviderContext {
  return {
    fetch: (input, init) => fetch(input, { ...init, credentials: 'omit' }),
    platform: 'web',
    capabilities: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
    mode,
    signal,
  }
}

/**
 * The track to look lyrics up for, so that synced lyrics keep time with what plays:
 *
 * - the track itself, when it plays its own audio;
 * - a track matched to audio from another catalog (a Spotify track's YouTube Music song) keeps
 *   its own title, artists and album, which are cleaner, but takes the duration of the audio;
 * - an official video that plays its song in Music mode looks up the song: its title, artists
 *   and duration (the video's own carry "(Official Video)", a channel name and an intro).
 */
export function lyricsTrackFor(item: QueueItem): Track {
  const { track, candidate } = item
  if (candidate === undefined || !isMatched(track, candidate)) return track
  const duration = candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }
  if (track.kind === 'music-video' && candidate.kind === 'song') {
    const { durationMs: _videoDuration, ...rest } = track
    return {
      ...rest,
      title: candidate.title,
      artists: candidate.artists.map((name) => ({ name })),
      ...duration,
    }
  }
  return { ...track, ...duration }
}
