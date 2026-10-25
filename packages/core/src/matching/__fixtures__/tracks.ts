/**
 * Test helpers: core tracks shaped like the YouTube provider's search results.
 *
 * @module
 */

import { formatId } from '../../ids'
import type { Track, TrackKind } from '../../model'

/** What a test track may set besides its ID, title and artists. */
export interface TrackSpec {
  /** `song` unless set. */
  kind?: TrackKind
  /** Album name. */
  album?: string
  /** The album's browse ID; `MPREb_<album>` when only the name is given. */
  albumId?: string
  /** Duration in whole seconds, as YouTube shows it. */
  seconds?: number
  /** Explicit badge. */
  explicit?: boolean
  /** `ytm` unless set. */
  source?: 'ytm' | 'yt'
  /** Release date of the album. */
  releaseDate?: string
  /** A music video's song link, as a videoId. */
  songId?: string
}

/** A search result: `track('abc', 'Song', 'Artist', { album: 'LP', seconds: 200 })`. */
export function track(
  id: string,
  title: string,
  artists: string | readonly string[],
  spec: TrackSpec = {},
): Track {
  const source = spec.source ?? 'ytm'
  const result: Track = {
    id: formatId(source, 'track', id),
    source,
    title,
    artists: (typeof artists === 'string' ? [artists] : artists).map((name) => ({ name })),
    artwork: [],
    kind: spec.kind ?? 'song',
  }
  if (spec.album !== undefined) {
    const browseId = spec.albumId ?? `MPREb_${spec.album.replace(/\W+/gu, '')}`
    result.album = { name: spec.album, id: formatId(source, 'album', browseId) }
  }
  if (spec.seconds !== undefined) result.durationMs = spec.seconds * 1000
  if (spec.explicit !== undefined) result.explicit = spec.explicit
  if (spec.releaseDate !== undefined) result.releaseDate = spec.releaseDate
  if (spec.songId !== undefined) result.songId = formatId('ytm', 'track', spec.songId)
  return result
}
