/**
 * The catalog-mode policy: which kinds of tracks each mode shows and plays. Search, radio,
 * recommendations, imports, audio candidates and the queue all go through {@link modePolicy} or
 * one of the helpers built on it, so no feature can bypass the mode.
 *
 * @module
 */

import type { Track, TrackKind } from './model'

/** Every catalog mode, in the order the settings show them. */
export const CATALOG_MODES = ['music', 'all'] as const

/**
 * The global catalog mode:
 *
 * - `music`: only catalog songs (YouTube Music songs, plus tracks from non-YouTube sources such
 *   as Spotify, Internet Archive, Jamendo and local files)
 * - `all`: songs plus official music videos and any YouTube video, all played as music
 *   (audio only)
 */
export type CatalogMode = (typeof CATALOG_MODES)[number]

/** The mode a fresh install starts in. */
export const DEFAULT_CATALOG_MODE: CatalogMode = 'music'

/** UI label of each mode. */
export const CATALOG_MODE_LABELS: Readonly<Record<CatalogMode, string>> = Object.freeze({
  music: 'Music',
  all: 'Music + Video',
})

/**
 * What a mode allows for one track:
 *
 * - `playable`: show it and play it
 * - `needs-song-match`: show it, but play it only after the matching engine has mapped it to
 *   its song (an official music video in Music mode; YouTube Music's song/video counterpart
 *   links are missing in anonymous sessions)
 * - `hidden`: leave it out
 *
 * `playable` is about the mode only: a Spotify track still needs an audio source.
 */
export type ModeVerdict = 'playable' | 'needs-song-match' | 'hidden'

const POLICY: Readonly<Record<CatalogMode, Readonly<Record<TrackKind, ModeVerdict>>>> = {
  music: {
    song: 'playable',
    'music-video': 'needs-song-match',
    video: 'hidden',
    episode: 'hidden',
  },
  all: {
    song: 'playable',
    'music-video': 'playable',
    video: 'playable',
    episode: 'hidden',
  },
}

/**
 * The verdict for one track in `mode`:
 *
 * | kind          | `music`            | `all`      |
 * |---------------|--------------------|------------|
 * | `song`        | `playable`         | `playable` |
 * | `music-video` | `needs-song-match` | `playable` |
 * | `video`       | `hidden`           | `playable` |
 * | `episode`     | `hidden`           | `hidden`   |
 *
 * It fails closed on bad data, for example a stale value read from storage: an unknown mode
 * gets the `music` rules and an unknown kind is `hidden`. Only real kinds and modes count, never
 * names inherited from `Object.prototype` such as `toString`.
 */
export function modePolicy(track: Pick<Track, 'kind'>, mode: CatalogMode): ModeVerdict {
  const rules = isCatalogMode(mode) ? POLICY[mode] : POLICY.music
  return Object.hasOwn(rules, track.kind) ? rules[track.kind] : 'hidden'
}

/**
 * Drops the tracks that `mode` hides and keeps the rest in order: the filter for lists to show,
 * such as search results, radio, recommendations and imports. Items that need a song match stay
 * in the list, so check {@link isPlayable} before playing one. For audio candidates, which must
 * be playable as they are, use {@link filterPlayable} instead.
 */
export function applyModeFilter<T extends Pick<Track, 'kind'>>(
  tracks: readonly T[],
  mode: CatalogMode,
): T[] {
  return tracks.filter((track) => modePolicy(track, mode) !== 'hidden')
}

/**
 * Whether `mode` lets an item play as it is, i.e. its verdict is `playable`. An official music
 * video in Music mode is not: it plays only through the song it was matched to. Every audio
 * candidate must pass this check (see `AudioSource.match`).
 */
export function isPlayable(item: Pick<Track, 'kind'>, mode: CatalogMode): boolean {
  return modePolicy(item, mode) === 'playable'
}

/**
 * Keeps, in order, only the items that `mode` lets play as they are. Unlike
 * {@link applyModeFilter} it also drops items that need a song match, so it suits audio
 * candidates and anything else about to be played.
 */
export function filterPlayable<T extends Pick<Track, 'kind'>>(
  items: readonly T[],
  mode: CatalogMode,
): T[] {
  return items.filter((item) => isPlayable(item, mode))
}

/** Whether a track kind is a video (an official music video or any other video). */
export function isVideoKind(kind: TrackKind): boolean {
  return kind === 'music-video' || kind === 'video'
}

/** Whether `value` is a {@link CatalogMode}, e.g. to validate a stored setting. */
export function isCatalogMode(value: unknown): value is CatalogMode {
  return typeof value === 'string' && (CATALOG_MODES as readonly string[]).includes(value)
}
