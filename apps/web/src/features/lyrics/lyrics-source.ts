/**
 * Where lyrics come from: LRCLIB, through the provider of stage 1.8 (`@fxm/sources/lrclib`).
 * LRCLIB answers every origin, so lyrics work on every tier, with or without FXM Connect.
 *
 * @module
 */

import {
  type CatalogMode,
  isPlayable,
  type LyricsProvider,
  type ProviderContext,
  type QueueItem,
  type Track,
} from '@fxm/core'
import { createLrclibProvider } from '@fxm/sources/lrclib'
import { appContext } from '../../lib/app-context'
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
 * The provider context for lyrics requests: the app platform's (`appContext`, which the
 * composition root connects), so the desktop and Android apps send them through their native
 * HTTP; the page's own `fetch` without cookies until then. LRCLIB is CORS-friendly, so either
 * reaches it on every tier.
 */
export function lyricsContext(mode: CatalogMode, signal: AbortSignal): ProviderContext {
  return appContext(mode, signal)
}

/**
 * How far apart two lengths may be and still find the same lyrics: LRCLIB matches the whole
 * seconds it gets within ±2 s.
 */
const SAME_LENGTH_MS = 2000

/**
 * The track to look lyrics up for, so that synced lyrics keep time with what plays:
 *
 * - the track itself, when it plays its own audio;
 * - a track matched to audio from another catalog (a Spotify track's YouTube Music song) keeps
 *   its own title, artists and album, which are cleaner. It takes the duration of the audio
 *   only when that is clearly another length: a match a second longer finds the same lyrics,
 *   so the lookup made before the match was known stays good;
 * - an official video that plays its song in Music mode looks up the song: its title, artists
 *   and duration (the video's own carry "(Official Video)", a channel name and an intro).
 */
export function lyricsTrackFor(item: QueueItem): Track {
  const { track, candidate } = item
  if (candidate === undefined || !isMatched(track, candidate)) return track
  if (track.kind === 'music-video' && candidate.kind === 'song') {
    const { durationMs: _videoDuration, ...rest } = track
    return {
      ...rest,
      title: candidate.title,
      artists: candidate.artists.map((name) => ({ name })),
      ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
    }
  }
  const own = track.durationMs
  const audio = candidate.durationMs
  if (audio === undefined || (own !== undefined && Math.abs(audio - own) <= SAME_LENGTH_MS)) {
    return track
  }
  return { ...track, durationMs: audio }
}

/**
 * Whether the player has yet to find what `item` plays, which decides what to look up: a
 * Spotify track (metadata only, so it plays through a match) or an official video in Music
 * mode (which plays its song), before a candidate is recorded.
 */
export function awaitsMatch(item: QueueItem, mode: CatalogMode): boolean {
  if (item.candidate !== undefined) return false
  return item.track.source === 'spotify' || !isPlayable(item.track, mode)
}
