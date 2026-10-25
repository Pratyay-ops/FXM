/**
 * The catalog-mode policy: which kinds of tracks each mode shows and plays. Search, radio,
 * recommendations, imports, audio candidates and the queue all go through {@link modePolicy} or
 * one of the helpers built on it, so no feature can bypass the mode.
 *
 * @module
 */

import { type EntityId, isEntityId, sameEntity } from './ids'
import type { Track, TrackKind } from './model'

/**
 * What the catalog-mode functions read from an item: its `kind` and, for an official music
 * video, its song link (`songId`) and its own `id`, which {@link songForVideo} needs to tell a
 * link to the video itself. A whole `Track` has all three; an `AudioCandidate` only a `kind`.
 */
export type ModeInput = Pick<Track, 'kind' | 'songId'> & Partial<Pick<Track, 'id'>>

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
 * - `plays-linked-song`: show it, but play the song it links to in its place (see
 *   {@link songForVideo}): an official music video in Music mode whose source links its song.
 *   That song is then a track like any other, which plays only once it passes
 *   {@link isPlayable}
 * - `needs-song-match`: show it, but play it only after the matching engine has mapped it to
 *   its song: an official music video in Music mode without a song link (YouTube Music links
 *   videos to songs on album pages, but not in anonymous search or `next` results)
 * - `hidden`: leave it out
 *
 * `playable` is about the mode only: a Spotify track still needs an audio source.
 */
export type ModeVerdict = 'playable' | 'plays-linked-song' | 'needs-song-match' | 'hidden'

/** The verdict for each kind, before a music video's song link is taken into account. */
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
 * | kind                           | `music`             | `all`      |
 * |--------------------------------|---------------------|------------|
 * | `song`                         | `playable`          | `playable` |
 * | `music-video` with a song link | `plays-linked-song` | `playable` |
 * | `music-video` without one      | `needs-song-match`  | `playable` |
 * | `video`                        | `hidden`            | `playable` |
 * | `episode`                      | `hidden`            | `hidden`   |
 *
 * A music video has a song link when {@link songForVideo} finds one in `songId`: a link to the
 * video itself counts as none. Music + Video mode plays a music video as it is, with or without
 * a link.
 *
 * It fails closed on bad data, for example a stale value read from storage: an unknown mode
 * gets the `music` rules, an unknown kind is `hidden`, and a song link that is not a valid track
 * ID counts as none. Only real kinds and modes count, never names inherited from
 * `Object.prototype` such as `toString`.
 */
export function modePolicy(track: ModeInput, mode: CatalogMode): ModeVerdict {
  const rules = isCatalogMode(mode) ? POLICY[mode] : POLICY.music
  if (!Object.hasOwn(rules, track.kind)) return 'hidden'
  const verdict = rules[track.kind]
  return verdict === 'needs-song-match' && songForVideo(track) !== undefined
    ? 'plays-linked-song'
    : verdict
}

/**
 * The song that a music video is the video of, when its source links the two
 * (`Track.songId`): what Music mode plays in the video's place (verdict `plays-linked-song`).
 * `undefined` for a music video without a link, which needs the matching engine instead, and
 * for every other kind of track.
 *
 * A link counts as none when it is not a valid track ID, e.g. from stale storage, and when it
 * names the video itself: its own `id`, or the same videoId under the other YouTube prefix (see
 * `sameEntity`). Following such a link, which a provider could copy from an album page that
 * lists the video itself, would play the video in Music mode. An `id` that is present but not a
 * valid track ID, which only bad data holds, voids the link too, since it cannot be compared.
 *
 * The song is then a track like any other: load it and check it with {@link isPlayable}, which
 * in Music mode only a `song` passes, and match it to audio first when its source has none of
 * its own, as for a Spotify song. If it does not pass, treat the video as `needs-song-match`, and
 * never follow a second link.
 */
export function songForVideo(track: ModeInput): EntityId<'track'> | undefined {
  const { kind, songId, id } = track
  if (kind !== 'music-video' || !isEntityId(songId, 'track')) return undefined
  if (id === undefined) return songId
  return isEntityId(id, 'track') && !sameEntity(id, songId) ? songId : undefined
}

/**
 * Drops the tracks that `mode` hides and keeps the rest in order: the filter for lists to show,
 * such as search results, radio, recommendations and imports. Items that play a linked song or
 * need a song match stay in the list, so check {@link isPlayable} before playing one. For audio
 * candidates, which must be playable as they are, use {@link filterPlayable} instead.
 */
export function applyModeFilter<T extends ModeInput>(tracks: readonly T[], mode: CatalogMode): T[] {
  return tracks.filter((track) => modePolicy(track, mode) !== 'hidden')
}

/**
 * Whether `mode` lets an item play as it is, i.e. its verdict is `playable`. An official music
 * video in Music mode is not: it plays only through its song, the linked one
 * ({@link songForVideo}) or the one the matching engine maps it to. Every audio candidate must
 * pass this check (see `AudioSource.match`).
 */
export function isPlayable(item: ModeInput, mode: CatalogMode): boolean {
  return modePolicy(item, mode) === 'playable'
}

/**
 * Keeps, in order, only the items that `mode` lets play as they are. Unlike
 * {@link applyModeFilter} it also drops items that play a linked song or need a song match, so
 * it suits audio candidates and anything else about to be played.
 */
export function filterPlayable<T extends ModeInput>(items: readonly T[], mode: CatalogMode): T[] {
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
