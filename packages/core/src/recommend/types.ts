/**
 * What the recommendation engine reads: candidates in the one format every recommendation
 * source's output is turned into (stage 3.2, `@fxm/sources/recommend`), and the user's taste
 * (stage 3.1's affinity, the recent plays and the onboarding picks).
 *
 * The candidate types here are the structural core of that format: a `RecommendationCandidate`
 * from `@fxm/sources/recommend` is a {@link RecCandidate} as it is, so the app hands a
 * collector's candidates to the engine without converting them. Core cannot import
 * `@fxm/sources` (it depends on core), hence the shapes are declared here, read-only and with
 * open strings where that format has closed unions.
 *
 * Everything is plain data that survives `JSON.stringify`.
 *
 * @module
 */

import type { EntityId } from '../ids'
import type { Artwork, Track } from '../model'
import type { AffinityEntry } from '../signals/affinity'

/** What a candidate was recommended for: a track or an artist. */
export interface RecSeed {
  /** A track or an artist. */
  readonly type: 'track' | 'artist'
  /** The seed's ID, when it has one. */
  readonly id?: EntityId
  /** The track's title, or the artist's name. */
  readonly name: string
  /** For a track, its artists' names, main artist first. */
  readonly artists?: readonly string[]
}

/** Where a candidate came from and how strongly: what every candidate says. */
export interface RecOrigin {
  /**
   * The service that suggested it: `ytm`, `spotify`, `lastfm`, `listenbrainz`, or `library` for
   * what the user already knows.
   */
  readonly source: string
  /** The call that suggested it: `radio`, `station`, `similar-artists` or `home`. */
  readonly part: string
  /** What it was suggested for. */
  readonly seed: RecSeed
  /** Its position in that service's list, from 0. */
  readonly rank: number
  /** How strongly the service suggests it, from 0 to 1. Comparable within one list only. */
  readonly score: number
}

/** A track to recommend. */
export interface RecTrackCandidate extends RecOrigin {
  readonly type: 'track'
  /** The track. */
  readonly track: Track
}

/**
 * A song known only by its artists and title, e.g. a Last.fm station item that could not be
 * classified within the request budget. A song search finds the track itself; until then the
 * engine can rank it, but no shelf can show it.
 */
export interface RecSongCandidate extends RecOrigin {
  readonly type: 'song-search'
  /** The song's title. */
  readonly title: string
  /** Its artists' names, main artist first. */
  readonly artists: readonly string[]
  /** Its length in milliseconds, when known. */
  readonly durationMs?: number
  /** The YouTube video the source linked, not classified. */
  readonly youtubeId?: string
}

/** An artist a source finds similar to the seed's. */
export interface RecArtist {
  /** The artist's name. */
  readonly name: string
  /** The artist's ID in a source FXM reads, e.g. a Spotify artist. */
  readonly id?: EntityId<'artist'>
  /** The artist's MusicBrainz ID, when known. */
  readonly mbid?: string
  /** Photos, when the source has them. May be empty. */
  readonly artwork: readonly Artwork[]
}

/** An artist to recommend: the app turns it into songs (its top tracks) before it can show any. */
export interface RecArtistCandidate extends RecOrigin {
  readonly type: 'artist'
  /** The artist. */
  readonly artist: RecArtist
}

/**
 * One recommendation: a track, a song to search for, or an artist. `@fxm/sources/recommend`'s
 * `RecommendationCandidate` is one as it is.
 */
export type RecCandidate = RecTrackCandidate | RecSongCandidate | RecArtistCandidate

/**
 * A track the user has played, liked or saved: its affinity entry (kind `track`) and, when the
 * library has it cached, its metadata. Shelves of familiar tracks (On repeat, Rediscover, the
 * familiar half of Quick picks and the mixes) can show only the tracks whose metadata is here.
 */
export interface ProfileTrack {
  /** The track's affinity entry. */
  readonly entry: AffinityEntry
  /** The track as the library cached it. */
  readonly track?: Track
}

/** One recent play, for the history filters and the recently-played penalty. */
export interface RecentPlay {
  /** The track that played. */
  readonly trackId: EntityId<'track'>
  /** When it started, as epoch milliseconds. */
  readonly playedAt: number
  /** Its metadata, when cached: it lets other sources' listings of the song count as played. */
  readonly track?: Track
}

/** An artist the user picked when FXM knew nothing about their taste (the cold start). */
export interface PickedArtist {
  /** The artist's name. */
  readonly name: string
  /** The artist's ID, when the pick came from a list of artists with IDs. */
  readonly id?: EntityId<'artist'>
}

/**
 * What the user picked in the cold-start onboarding: artists and genres. They count like likes
 * made at `at`, so they fade with the affinity's half-life as real listening takes over.
 */
export interface TastePicks {
  /** The picked artists. */
  readonly artists: readonly PickedArtist[]
  /** The picked genres, as shown, e.g. `Hip-hop`. */
  readonly genres: readonly string[]
  /** When they were picked, as epoch milliseconds. */
  readonly at: number
}

/**
 * The user's taste as the engine reads it. Every part is optional: an empty profile is the cold
 * start. The app reads the entries from its affinity store (the top few hundred tracks, the top
 * artists and tags) and the recent plays from its history.
 */
export interface TasteProfile {
  /** Tracks the user played, liked or saved, with their affinity. */
  readonly tracks?: readonly ProfileTrack[]
  /** The affinity of artists (entries of kind `artist`). */
  readonly artists?: readonly AffinityEntry[]
  /** The affinity of tags (entries of kind `tag`). */
  readonly tags?: readonly AffinityEntry[]
  /** Recent plays, in any order. */
  readonly recent?: readonly RecentPlay[]
  /** The onboarding picks, if the user made any. */
  readonly picks?: TastePicks
}
