/**
 * The one candidate format every recommendation source's output is turned into, for the
 * recommendation engine (stage 3.3) to score, diversify and de-duplicate.
 *
 * @module
 */

import type { Artwork, EntityId, FxmErrorCode, Shelf, Track } from '@fxm/core'

/** The services recommendations come from. */
export type RecommendationSource = 'ytm' | 'spotify' | 'lastfm' | 'listenbrainz'

/**
 * Which kind of call produced a candidate:
 *
 * - `radio`: YouTube Music's or Spotify's radio for the seed
 * - `station`: Last.fm's similar-artists station for the seed's artist
 * - `similar-artists`: artists like the seed's (Spotify's related artists, Last.fm and
 *   ListenBrainz similar artists)
 * - `home`: a provider's home feed (shelves, not candidates)
 */
export type RecommendationPart = 'radio' | 'station' | 'similar-artists' | 'home'

/** What a radio or recommendation started from, as candidates record it. */
export interface SeedRef {
  /** A track or an artist. */
  type: 'track' | 'artist'
  /** The seed's ID, when it has one. */
  id?: EntityId
  /** The track's title, or the artist's name. */
  name: string
  /** For a track, its artists' names, main artist first. */
  artists?: string[]
}

/** What every candidate says about where it came from. */
export interface CandidateBase {
  /** The service that suggested it. */
  source: RecommendationSource
  /** The call that suggested it. */
  part: RecommendationPart
  /** What it was suggested for. */
  seed: SeedRef
  /** Its position in that service's list, from 0. */
  rank: number
  /**
   * How strongly the service suggests it, from 0 to 1: its own similarity where it gives one
   * (Last.fm's `match`, ListenBrainz's score relative to the best), else from the rank (the first
   * of `n` gets 1, the last `1/n`). Comparable within one list only.
   */
  score: number
  /**
   * A key that listings of the same song (or artist) share across sources, for grouping and
   * de-duplication: the main artist and the title proper, normalized. See `songKey` and
   * `artistKey`.
   */
  key: string
  /**
   * A page about it on the service, when the service asks apps to link back: Last.fm's terms
   * ask apps that show its data to link to its catalogue pages.
   */
  attributionUrl?: string
}

/**
 * A track to recommend. It passes the catalog mode's list filter: in Music mode it is a song
 * (it may still need matching to audio, as a Spotify song does, which the playback policy
 * handles), and in Music + Video mode anything but an episode.
 */
export interface TrackCandidate extends CandidateBase {
  /** A track. */
  type: 'track'
  /** The track. */
  track: Track
}

/**
 * A song known only by its artists and title: a song search (YouTube Music's songs, through the
 * matching engine) finds the song itself, when the candidate is used. Last.fm's station items
 * become these in Music mode when their YouTube video cannot be classified within the request
 * budget, or is an official video without a known song.
 */
export interface SongSearchCandidate extends CandidateBase {
  /** A song to search for. */
  type: 'song-search'
  /** The song's title. */
  title: string
  /** Its artists' names, main artist first. */
  artists: string[]
  /** Its duration in milliseconds, when known. */
  durationMs?: number
  /**
   * The YouTube video the source linked, not classified: in Music + Video mode it may play as
   * it is; in Music mode only after classification shows a song.
   */
  youtubeId?: string
}

/** An artist the source finds similar to the seed's. */
export interface CandidateArtist {
  /** The artist's name. */
  name: string
  /** The artist's ID in a source FXM reads, e.g. a Spotify artist. */
  id?: EntityId<'artist'>
  /** The artist's MusicBrainz ID, when known. */
  mbid?: string
  /** Photos, when the source has them. May be empty. */
  artwork: Artwork[]
}

/** An artist to recommend: the engine turns it into songs, e.g. the artist's top tracks. */
export interface ArtistCandidate extends CandidateBase {
  /** An artist. */
  type: 'artist'
  /** The artist. */
  artist: CandidateArtist
}

/** One recommendation, in the format every source's output is turned into. */
export type RecommendationCandidate = TrackCandidate | SongSearchCandidate | ArtistCandidate

/**
 * Why a source did not run:
 *
 * - `not-configured`: the app did not register it, or it lacks what it needs (an API key)
 * - `switched-off`: the user switched it off (Spotify)
 * - `unreachable`: the platform cannot reach it (`capabilities`), e.g. Spotify in a plain browser
 * - `needs-full-tier`: it needs FXM Connect, the desktop app or the Android app (Last.fm stations)
 * - `unsupported-seed`: it cannot start from this seed, e.g. ListenBrainz from an artist without a
 *   MusicBrainz ID, or YouTube Music radio from an official video without a known song in Music
 *   mode, or the provider rejected the seed as `Unsupported`
 */
export type SkipReason =
  | 'not-configured'
  | 'switched-off'
  | 'unreachable'
  | 'needs-full-tier'
  | 'unsupported-seed'

/** What one source did in one collection, for diagnostics and tests. */
export type SourceOutcome =
  | { source: RecommendationSource; part: RecommendationPart; status: 'ok'; count: number }
  | {
      source: RecommendationSource
      part: RecommendationPart
      status: 'skipped'
      reason: SkipReason
    }
  | {
      source: RecommendationSource
      part: RecommendationPart
      status: 'failed'
      /** The `FxmError` code, or `Unknown` for any other error. */
      code: FxmErrorCode | 'Unknown'
      /** The error's message, for logs. */
      message: string
    }

/** The candidates collected for one seed. */
export interface Collection {
  /**
   * Every candidate, grouped by source (YouTube Music, Spotify, Last.fm, ListenBrainz) and in
   * each source's own order. Not de-duplicated across sources: group them by `key`.
   */
  candidates: RecommendationCandidate[]
  /** What each source did. */
  outcomes: SourceOutcome[]
}

/** A home-feed shelf and the source it came from. */
export interface SourceShelf {
  /** The service whose home feed it is. */
  source: RecommendationSource
  /** The shelf, with its tracks filtered to the catalog mode. */
  shelf: Shelf
}

/** The home feeds collected from every source that has one. */
export interface HomeCollection {
  /** The shelves, by source, in each source's order. Shelves left empty by the mode are dropped. */
  shelves: SourceShelf[]
  /** What each source did. */
  outcomes: SourceOutcome[]
}
