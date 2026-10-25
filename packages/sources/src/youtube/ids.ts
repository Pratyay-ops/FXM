/**
 * YouTube's native IDs and their FXM entity IDs. `ytm` and `yt` share one ID space (see
 * `entityKey` in `@fxm/core`): the videoId for tracks, the browseId (`MPREb_…`) for albums, the
 * channelId (`UC…`) for artists, and the playlistId without the `VL` browse prefix for
 * playlists.
 *
 * @module
 */

import { type EntityId, type EntityKind, FxmError, formatId, parseId } from '@fxm/core'

/** The two YouTube sources: YouTube Music and plain YouTube. */
export type YouTubeSource = 'ytm' | 'yt'

/** A videoId: 11 characters of base64url. */
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u

/** A channelId: `UC` and 22 characters of base64url. */
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/u

/** An album's browseId. */
export const ALBUM_ID = /^MPREb_[A-Za-z0-9_-]{1,64}$/u

/** A playlistId, e.g. `PL…`, `OLAK5uy_…` (an album's audio playlist) or `RDCLAK5uy_…`. */
export const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,128}$/u

/** The prefix that turns a playlistId into its browseId. */
export const PLAYLIST_BROWSE_PREFIX = 'VL'

/** The prefix of a song credits page, `MPTC<videoId>`, which album pages link from each row. */
export const CREDITS_BROWSE_PREFIX = 'MPTC'

const PATTERNS: Readonly<Record<EntityKind, RegExp>> = {
  track: VIDEO_ID,
  album: ALBUM_ID,
  artist: CHANNEL_ID,
  playlist: PLAYLIST_ID,
}

/** Whether `value` is a YouTube native ID of `kind`. */
export function isYouTubeId(kind: EntityKind, value: unknown): value is string {
  return typeof value === 'string' && PATTERNS[kind].test(value)
}

/** A playlistId from a browseId or playlistId: the `VL` browse prefix dropped. */
export function playlistIdOf(id: string): string {
  return id.startsWith(PLAYLIST_BROWSE_PREFIX) ? id.slice(PLAYLIST_BROWSE_PREFIX.length) : id
}

/**
 * The YouTube native ID inside an entity ID of `kind`, from either YouTube source (they share
 * one ID space). A playlist ID may carry the `VL` browse prefix, which is dropped.
 *
 * @throws FxmError `NotFound` when the ID is not a YouTube ID of that kind, so it cannot exist.
 */
export function nativeYouTubeId(id: EntityId, kind: EntityKind): string {
  const parts = parseId(id as unknown)
  const native = kind === 'playlist' && parts ? playlistIdOf(parts.nativeId) : parts?.nativeId
  if (
    parts === null ||
    (parts.source !== 'ytm' && parts.source !== 'yt') ||
    parts.kind !== kind ||
    !isYouTubeId(kind, native)
  ) {
    throw new FxmError('NotFound', `Not a YouTube ${kind} ID: ${String(id)}`)
  }
  return native
}

/** The entity ID of a YouTube native ID, or `undefined` when the native ID is malformed. */
export function youTubeEntityId<K extends EntityKind>(
  source: YouTubeSource,
  kind: K,
  native: unknown,
): EntityId<K> | undefined {
  const value = kind === 'playlist' && typeof native === 'string' ? playlistIdOf(native) : native
  return isYouTubeId(kind, value) ? formatId(source, kind, value) : undefined
}
