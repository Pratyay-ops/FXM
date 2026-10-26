/**
 * Builders for the recommendation engine's tests: fictional tracks, listening histories turned
 * into taste profiles through stage 3.1's own affinity, and candidates in the format of
 * `@fxm/sources/recommend`. Not exported from the package.
 *
 * @module
 */

import { entityKey, formatId } from '../ids'
import type { ArtistRef, Track, TrackKind } from '../model'
import { AffinityIndex } from '../signals/affinity'
import type { ListeningSignal } from '../signals/signals'
import { recSeedOf } from './identity'
import { skippedEarly } from './radio'
import type { RecCandidate, RecentPlay, RecSeed, RecTrackCandidate, TasteProfile } from './types'

/** Monday 2026-10-26, 12:00 UTC: the "now" of the tests. */
export const NOW = Date.UTC(2026, 9, 26, 12)

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

/** A YouTube Music track (a song unless `kind` says otherwise) by one or more artists. */
export function ytm(
  videoId: string,
  title: string,
  artists: string | readonly string[],
  extra: Partial<Track> & { kind?: TrackKind } = {},
): Track {
  const names = typeof artists === 'string' ? [artists] : artists
  return {
    id: formatId('ytm', 'track', videoId),
    source: 'ytm',
    title,
    artists: names.map((name) => ({ name })),
    artwork: [{ url: `https://example.test/${videoId}.jpg`, width: 120, height: 120 }],
    kind: 'song',
    durationMs: 200_000,
    ...extra,
  }
}

/** A Spotify song, without artwork unless given. */
export function spotify(id: string, title: string, artist: string, extra: Partial<Track> = {}) {
  const track: Track = {
    id: formatId('spotify', 'track', id),
    source: 'spotify',
    title,
    artists: [{ name: artist }],
    artwork: [],
    kind: 'song',
    ...extra,
  }
  return track
}

/** An artist reference. */
export function artist(name: string, id?: string): ArtistRef {
  return id === undefined ? { name } : { name, id: formatId('ytm', 'artist', id) }
}

/** What the sources suggested for `seed`: `tracks` as one list, scored by rank. */
export function radio(
  seed: Track | ArtistRef,
  tracks: readonly Track[],
  options: { source?: string; part?: string } = {},
): RecTrackCandidate[] {
  const { source = 'ytm', part = 'radio' } = options
  const ref: RecSeed = recSeedOf(seed)
  return tracks.map((track, rank) => ({
    type: 'track',
    source,
    part,
    seed: ref,
    rank,
    score: (tracks.length - rank) / tracks.length,
    track,
  }))
}

/** Similar artists suggested for `seed`. */
export function similarArtists(
  seed: Track | ArtistRef,
  names: readonly string[],
  source = 'listenbrainz',
): RecCandidate[] {
  return names.map((name, rank) => ({
    type: 'artist',
    source,
    part: 'similar-artists',
    seed: recSeedOf(seed),
    rank,
    score: (names.length - rank) / names.length,
    artist: { name, artwork: [] },
  }))
}

/** A play of `track` that started `ago` before {@link NOW}. */
export function play(
  track: Track,
  ago: number,
  options: { completed?: boolean; skipped?: boolean; playedMs?: number } = {},
): ListeningSignal {
  const { completed = true, skipped = false, playedMs = 200_000 } = options
  return {
    type: 'play',
    at: NOW - ago,
    track,
    playedMs,
    durationMs: 200_000,
    completed,
    skipped,
  }
}

/** A like of `track`, `ago` before {@link NOW}. */
export function like(track: Track, ago: number): ListeningSignal {
  return { type: 'like', at: NOW - ago, track }
}

/**
 * The taste profile a history makes: the affinity stage 3.1 computes from `signals`, every
 * track's metadata, and the plays as recent plays, with whether the user skipped each.
 */
export function profileOf(
  signals: readonly ListeningSignal[],
  extra: Partial<TasteProfile> = {},
): TasteProfile {
  const index = new AffinityIndex({ now: () => NOW })
  index.add(signals)
  const tracks = new Map<string, Track>()
  for (const signal of signals) tracks.set(entityKey(signal.track.id), signal.track as Track)
  const recent: RecentPlay[] = signals.flatMap((signal) =>
    signal.type === 'play'
      ? [
          {
            trackId: signal.track.id,
            playedAt: signal.at,
            track: signal.track as Track,
            ...(skippedEarly(signal) ? { skipped: true } : {}),
          },
        ]
      : [],
  )
  return {
    tracks: index.entries('track').map((entry) => {
      const track = tracks.get(entry.key)
      return track === undefined ? { entry } : { entry, track }
    }),
    artists: index.entries('artist'),
    tags: index.entries('tag'),
    recent,
    ...extra,
  }
}

/** `items` in a fixed shuffled order (a permutation by stride), to test order independence. */
export function reorder<T>(items: readonly T[]): T[] {
  const result: T[] = []
  const stride = 7
  for (let start = 0; start < stride; start++) {
    for (let index = start; index < items.length; index += stride) result.push(items[index] as T)
  }
  return result.reverse()
}
