/**
 * What a pool can't show by itself: similar artists, which must become songs (their top
 * tracks), and song searches, which must become tracks. Both cost requests, so the engine picks
 * the few worth it ({@link planExpansions}), the app fetches them, and hands the tracks back as
 * candidates ({@link artistTrackCandidates}, {@link songTrackCandidates}) that keep the
 * evidence of what they came from.
 *
 * @module
 */

import type { Track } from '../model'
import { artistKeyOf } from './identity'
import type { PooledArtist, PooledSong } from './pool'
import { compareKeys } from './pool'
import { DEFAULT_SCORE_WEIGHTS, scoreSongs } from './score'
import type { TasteIndex } from './taste'
import type { RecTrackCandidate } from './types'

/** What to fetch: artists to turn into songs and songs to find, best first. */
export interface ExpansionPlan {
  /** Similar artists to turn into songs, e.g. their top tracks. */
  readonly artists: readonly PooledArtist[]
  /** Song searches to turn into tracks. */
  readonly songs: readonly PooledSong[]
}

/** Options for {@link planExpansions}. */
export interface ExpansionOptions {
  /** Most artists to expand. Default 4. */
  readonly maxArtists?: number
  /** Most songs to search for. Default 8. */
  readonly maxSongs?: number
  /** An artist with this many songs in the pool already needs no expanding. Default 3. */
  readonly enoughSongs?: number
}

/**
 * Picks the similar artists and song searches worth fetching, best first:
 *
 * - **artists** by how strongly the sources suggest them, less the more the user already knows
 *   them (Discover is about new artists) or skips them, leaving out artists the pool already
 *   has enough songs by;
 * - **songs** that only a search can turn into tracks, that the user doesn't know yet, by their
 *   score.
 */
export function planExpansions(
  pool: { readonly songs: readonly PooledSong[]; readonly artists: readonly PooledArtist[] },
  taste: TasteIndex,
  options: ExpansionOptions = {},
): ExpansionPlan {
  const { maxArtists = 4, maxSongs = 8, enoughSongs = 3 } = options
  const songsByArtist = new Map<string, number>()
  for (const song of pool.songs) {
    const main = song.artistKeys[0]
    if (song.track !== undefined && main !== undefined) {
      songsByArtist.set(main, (songsByArtist.get(main) ?? 0) + 1)
    }
  }
  const artists = pool.artists
    .map((artist) => {
      const known = taste.artist(artist.key)
      const value =
        artist.similarity * (1 - 0.6 * (known?.familiarity ?? 0)) * (1 - (known?.skipShare ?? 0))
      return { artist, value }
    })
    .filter(({ artist, value }) => value > 0 && (songsByArtist.get(artist.key) ?? 0) < enoughSongs)
    .sort((a, b) => b.value - a.value || compareKeys(a.artist.key, b.artist.key))
    .slice(0, Math.max(0, maxArtists))
    .map(({ artist }) => artist)

  const searches = pool.songs.filter((song) => song.track === undefined && !taste.known(song.keys))
  const songs = scoreSongs(searches, taste, { weights: DEFAULT_SCORE_WEIGHTS })
    .slice(0, Math.max(0, maxSongs))
    .map(({ song }) => song)
  return { artists, songs }
}

/** The score of the item at `rank` in a list of `total`: 1 for the first, `1/total` for the last. */
function rankScore(rank: number, total: number): number {
  return total > 0 ? (total - rank) / total : 0
}

/**
 * An expanded artist's tracks as candidates: each carries the artist's strongest evidence (its
 * source, part and seed), with that evidence's score scaled by the track's rank, so an artist's
 * top track counts most. Tracks by someone else (a search can return them) are left out, as is
 * everything past `limit` (default 5).
 */
export function artistTrackCandidates(
  artist: PooledArtist,
  tracks: readonly Track[],
  limit = 5,
): RecTrackCandidate[] {
  const evidence = artist.evidence[0]
  if (evidence === undefined) return []
  const own = tracks
    .filter((track) =>
      (Array.isArray(track?.artists) ? track.artists : []).some(
        (credit) => artistKeyOf(credit?.name) === artist.key,
      ),
    )
    .slice(0, Math.max(0, limit))
  return own.map((track, rank) => ({
    type: 'track',
    source: evidence.source,
    part: evidence.part,
    seed: evidence.seed,
    rank,
    score: evidence.score * rankScore(rank, own.length),
    track,
  }))
}

/** A song search's track as candidates: one per piece of the song's evidence, as it was. */
export function songTrackCandidates(song: PooledSong, track: Track): RecTrackCandidate[] {
  return song.evidence.map((evidence) => ({
    type: 'track',
    source: evidence.source,
    part: evidence.part,
    seed: evidence.seed,
    rank: evidence.rank,
    score: evidence.score,
    track,
  }))
}
