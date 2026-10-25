/**
 * What the recommendation sources read from a radio seed: its main artist, its title, and in
 * Music mode the song to seed YouTube Music's radio with.
 *
 * @module
 */

import {
  type ArtistRef,
  isPlayable,
  isTrackSeed,
  type ProviderContext,
  parseId,
  type RadioSeed,
  songForVideo,
  type Track,
} from '@fxm/core'
import type { SongForVideo } from './adapters'
import { cleanArtist, readTitle } from './internal/text'
import type { SeedRef } from './types'

/** How candidates record a seed. */
export function seedRef(seed: RadioSeed): SeedRef {
  if (!isTrackSeed(seed)) {
    return seed.id === undefined
      ? { type: 'artist', name: seed.name }
      : { type: 'artist', id: seed.id, name: seed.name }
  }
  return {
    type: 'track',
    id: seed.id,
    name: seed.title,
    artists: seed.artists.map((artist) => artist.name),
  }
}

/** The seed's main artist: the artist itself, or a track's first credited artist. */
export function seedArtist(seed: RadioSeed): ArtistRef | undefined {
  return isTrackSeed(seed) ? seed.artists[0] : seed
}

/**
 * The seed's main artist's name, without YouTube's channel suffixes ("RadioheadVEVO",
 * "Radiohead - Topic"). Empty when the seed names no artist.
 */
export function seedArtistName(seed: RadioSeed): string {
  const artist = seedArtist(seed)
  return artist === undefined ? '' : cleanArtist(artist.name)
}

/**
 * A track seed's title proper, without presentation noise, an "Artist - " prefix, qualifiers or
 * featured artists, e.g. `Creep` for "Radiohead - Creep (Official Music Video)". Empty for an
 * artist seed.
 */
export function seedTitle(seed: RadioSeed): string {
  if (!isTrackSeed(seed)) return ''
  const artists = seed.artists.map((artist) => cleanArtist(artist.name))
  return readTitle(seed.title, artists).core
}

/** A music video's linked song as a track, from the video's own details. */
function linkedSong(video: Track, songId: Track['id']): Track {
  const { songId: _link, durationMs: _videoLength, ...details } = video
  return { ...details, id: songId, source: parseId(songId).source, kind: 'song' }
}

/**
 * What to seed YouTube Music's radio with. In Music + Video mode, and for songs and artists, the
 * seed itself. In Music mode radio from a video drifts into videos, so an official music video
 * seeds with its song: the one it links (`songForVideo`), else the one `hook` (the matching
 * engine's video-to-song rule) finds. `null` when there is none, and for other videos and
 * episodes, which have no song.
 */
export async function youtubeRadioSeed(
  seed: RadioSeed,
  ctx: ProviderContext,
  hook: SongForVideo | undefined,
): Promise<RadioSeed | null> {
  if (!isTrackSeed(seed) || ctx.mode !== 'music' || isPlayable(seed, 'music')) return seed
  if (seed.kind !== 'music-video') return null
  const linked = songForVideo(seed)
  if (linked !== undefined) return linkedSong(seed, linked)
  if (hook === undefined) return null
  const song = await hook(seed, ctx)
  return song !== null && isPlayable(song, 'music') ? song : null
}
