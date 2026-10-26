/**
 * The tags of a saved file from what FXM knows about the track: its metadata, its lyrics and
 * its cover.
 *
 * @module
 */

import type { Lyrics, Track } from '@fxm/core'
import type { CoverArt, ExportTags, TimedLyric } from './types'

/** What goes into the tags besides the track itself. */
export interface TrackTagExtras {
  /** The track's lyrics (LRCLIB through stage 1.8), or `null`/absent when it has none. */
  readonly lyrics?: Lyrics | null
  readonly cover?: CoverArt
}

/** The tags of `track`, with its lyrics and cover when given. */
export function tagsFromTrack(track: Track, extras: TrackTagExtras = {}): ExportTags {
  const lines = extras.lyrics?.lines.filter((line) => line.text.trim() !== '') ?? []
  const synced: TimedLyric[] | undefined =
    extras.lyrics?.synced === true
      ? lines.flatMap((line) =>
          line.timeMs === undefined ? [] : [{ timeMs: line.timeMs, text: line.text }],
        )
      : undefined
  const text = lines.map((line) => line.text).join('\n')
  return {
    title: typeof track.title === 'string' ? track.title : '',
    // A stored track's names are data from disk: only text becomes a tag.
    artists: track.artists.flatMap((artist) =>
      typeof artist?.name === 'string' ? [artist.name] : [],
    ),
    ...(track.album === undefined ? {} : { album: track.album.name }),
    ...(track.trackNumber === undefined ? {} : { trackNumber: track.trackNumber }),
    ...(track.discNumber === undefined ? {} : { discNumber: track.discNumber }),
    ...(track.releaseDate === undefined ? {} : { releaseDate: track.releaseDate }),
    ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
    ...(text === '' ? {} : { lyrics: text }),
    ...(synced === undefined || synced.length === 0 ? {} : { syncedLyrics: synced }),
    ...(extras.cover === undefined ? {} : { cover: extras.cover }),
  }
}
