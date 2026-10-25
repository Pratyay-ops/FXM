/**
 * What the recommendation sources read from a seed: its main artist, its title, its MusicBrainz
 * ID when known, and the seed YouTube Music's radio can start from.
 *
 * @module
 */

import {
  type ArtistRef,
  type CatalogMode,
  isPlayable,
  isTrackSeed,
  type ProviderContext,
  parseId,
  type RadioSeed,
  songForVideo,
  type Track,
} from '@fxm/core'
import { normalizeMbid } from '../shared/mbid'
import { cleanArtist, readTitle } from '../shared/names'
import type { SongForVideo, YouTubeSeedFinder } from './adapters'
import type { RecommendationSeed, SeedRef } from './types'

/**
 * Whether `mode` is to be treated as Music mode. It fails closed, as core's `modePolicy` does:
 * any mode but Music + Video (`all`), an unknown or stale one included, gets Music mode's rules.
 */
export function isMusicMode(mode: CatalogMode): boolean {
  return mode !== 'all'
}

/** How candidates record a seed. */
export function seedRef(seed: RecommendationSeed): SeedRef {
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
export function seedArtist(seed: RecommendationSeed): ArtistRef | undefined {
  return isTrackSeed(seed) ? seed.artists[0] : seed
}

/**
 * The seed's main artist's name, without YouTube's channel suffixes ("RadioheadVEVO",
 * "Radiohead - Topic"). Empty when the seed names no artist.
 */
export function seedArtistName(seed: RecommendationSeed): string {
  const artist = seedArtist(seed)
  return artist === undefined ? '' : cleanArtist(artist.name)
}

/**
 * A track seed's title proper, without presentation noise, an "Artist - " prefix, qualifiers or
 * featured artists, e.g. `Creep` for "Radiohead - Creep (Official Music Video)". Empty for an
 * artist seed.
 */
export function seedTitle(seed: RecommendationSeed): string {
  if (!isTrackSeed(seed)) return ''
  const artists = seed.artists.map((artist) => cleanArtist(artist.name))
  return readTitle(seed.title, artists).core
}

/** An artist seed's MusicBrainz ID in its canonical form, when it carries a valid one. */
export function seedArtistMbid(seed: RecommendationSeed): string | undefined {
  return isTrackSeed(seed) ? undefined : normalizeMbid(seed.mbid)
}

/** A YouTube video ID: 11 characters of URL-safe base64. */
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u

/**
 * Whether YouTube Music's radio can start from `seed` as it is, by the YouTube Music provider's
 * own rules (stage 1.3): an artist with a YouTube channel ID; a track with a YouTube video ID of
 * its own or in `externalIds` (in Music mode only its YouTube Music song, `externalIds.ytm`,
 * since a radio from a plain video plays videos); in Music mode only a song; never an episode.
 */
export function isYouTubeRadioSeed(seed: RadioSeed, mode: CatalogMode): boolean {
  // Read defensively: an ID from storage may be malformed, which counts as none.
  if (!isTrackSeed(seed)) {
    const source = parseId(seed.id as unknown)?.source
    return source === 'ytm' || source === 'yt'
  }
  const music = isMusicMode(mode)
  if (seed.kind === 'episode' || (music && seed.kind !== 'song')) return false
  const own = parseId(seed.id as unknown)
  const videoId =
    own?.source === 'ytm' || own?.source === 'yt'
      ? own.nativeId
      : music
        ? seed.externalIds?.ytm
        : (seed.externalIds?.ytm ?? seed.externalIds?.yt)
  return videoId !== undefined && YOUTUBE_VIDEO_ID.test(videoId)
}

/** A music video's linked song as a track, from the video's own details. */
function linkedSong(video: Track, songId: Track['id']): Track {
  const { songId: _link, durationMs: _videoLength, ...details } = video
  return { ...details, id: songId, source: parseId(songId).source, kind: 'song' }
}

/** The adapters {@link youtubeRadioSeed} may use. */
export interface YouTubeSeedAdapters {
  /** The video-to-song rule, for an official video without a song link in Music mode. */
  songForVideo?: SongForVideo | undefined
  /** Finds a YouTube seed for a seed without a YouTube ID. */
  youtubeSeed?: YouTubeSeedFinder | undefined
}

/**
 * What to seed YouTube Music's radio with, or `null` when there is nothing it can start from.
 *
 * - **Music mode** (and any unknown mode): radio from a video drifts into videos, so an official
 *   music video seeds with its song: the one it links (`songForVideo`), else the one the matching
 *   engine's video-to-song rule (`adapters.songForVideo`) finds, at any band but `none`: a guess
 *   only steers the radio, which is filtered to songs anyway. Other videos and episodes have no
 *   song.
 * - A seed YouTube Music radio cannot start from as it is (see {@link isYouTubeRadioSeed}), such
 *   as a Spotify or Internet Archive track or a Last.fm artist, goes to `adapters.youtubeSeed`,
 *   and its answer is checked by the same rules.
 */
export async function youtubeRadioSeed(
  seed: RecommendationSeed,
  ctx: ProviderContext,
  adapters: YouTubeSeedAdapters = {},
): Promise<RadioSeed | null> {
  const music = isMusicMode(ctx.mode)
  let start: RecommendationSeed = seed
  if (isTrackSeed(seed)) {
    if (seed.kind === 'episode') return null
    if (music && !isPlayable(seed, 'music')) {
      if (seed.kind !== 'music-video') return null
      const linked = songForVideo(seed)
      if (linked !== undefined) {
        start = linkedSong(seed, linked)
      } else {
        const found =
          adapters.songForVideo === undefined ? null : await adapters.songForVideo(seed, ctx)
        if (found === null || !isPlayable(found.song, 'music')) return null
        start = found.song
      }
    }
  }
  const mode: CatalogMode = music ? 'music' : 'all'
  if (isYouTubeRadioSeed(start, mode)) return start
  if (adapters.youtubeSeed === undefined) return null
  const found = await adapters.youtubeSeed(start, ctx)
  return found !== null && isYouTubeRadioSeed(found, mode) ? found : null
}
