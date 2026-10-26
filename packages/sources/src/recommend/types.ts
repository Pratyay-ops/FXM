/**
 * The one candidate format every recommendation source's output is turned into, for the
 * recommendation engine (stage 3.3) to score, diversify and de-duplicate.
 *
 * @module
 */

import type {
  ArtistRef,
  Artwork,
  EntityId,
  FxmErrorCode,
  MatchVerdict,
  Shelf,
  Track,
} from '@fxm/core'

/** The services recommendations come from. */
export type RecommendationSource = 'ytm' | 'spotify' | 'lastfm' | 'listenbrainz'

/**
 * Which kind of call a source ran:
 *
 * - `radio`: YouTube Music's or Spotify's radio for the seed
 * - `station`: Last.fm's similar-artists station for the seed's artist
 * - `similar-artists`: artists like the seed's (Spotify's related artists, Last.fm and
 *   ListenBrainz similar artists)
 * - `home`: a provider's home feed (shelves, not candidates)
 */
export type RecommendationPart = 'radio' | 'station' | 'similar-artists' | 'home'

/** The parts that produce candidates: every part but `home`, which produces shelves. */
export type CandidatePart = Exclude<RecommendationPart, 'home'>

/**
 * An artist to start from, with its MusicBrainz ID when it is known, e.g. the `artist` of an
 * {@link ArtistCandidate}, so that ListenBrainz needs no lookup for it.
 */
export interface ArtistSeed extends ArtistRef {
  /** The artist's MusicBrainz ID. */
  mbid?: string
}

/** What recommendations start from: a track, or an artist. */
export type RecommendationSeed = Track | ArtistSeed

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
  part: CandidatePart
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
 * How a candidate's song was found for the video a source linked (a Last.fm station item's
 * official music video), when it was.
 */
export interface SongMatch {
  /**
   * `link`: the video's source links the song (`Track.songId`), which is no guess. `match`: the
   * matching engine's video-to-song rule mapped the video to the song.
   */
  via: 'link' | 'match'
  /**
   * The engine's verdict on a `match`. It is kept so that the player applies the user's Auto
   * setting at play time, with `effectiveMatchBand(verdict, autoOn)`, which also refuses an
   * `auto` from another matcher version: a stored candidate follows the setting and the engine
   * as they change. A `match` without a verdict is `suggest`.
   */
  verdict?: MatchVerdict
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
  /**
   * Set when the track is the song of a video the source linked, rather than what the source
   * named itself: whether that is a link or a match, and the match's verdict to re-check when it
   * plays. Only links and matches that were `auto` when collected become track candidates.
   */
  match?: SongMatch
}

/**
 * A song known only by its artists and title: a song search (YouTube Music's songs, through the
 * matching engine) finds the song itself, when the candidate is used. Last.fm's station items
 * become these in Music mode when their YouTube video cannot be classified within the request
 * budget and its time limit, or is an official video without a song FXM may play unasked.
 */
export interface SongSearchCandidate extends CandidateBase {
  /** A song to search for. */
  type: 'song-search'
  /** The song's title. */
  title: string
  /** Its artists' names, main artist first. */
  artists: string[]
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

/**
 * An artist to recommend: the engine turns it into songs, e.g. the artist's top tracks. Its
 * `artist` is an {@link ArtistSeed} as it is, MusicBrainz ID included.
 */
export interface ArtistCandidate extends CandidateBase {
  /** An artist. */
  type: 'artist'
  /** The artist. */
  artist: CandidateArtist
}

/** One recommendation, in the format every source's output is turned into. */
export type RecommendationCandidate = TrackCandidate | SongSearchCandidate | ArtistCandidate

/**
 * Why a source did not run. Each is the collector's own decision before it asks the source (or,
 * for a radio that doesn't follow a track of another source, after), or, for `unsupported-seed`,
 * a refusal the source makes explicitly about the seed:
 *
 * - `not-configured`: the app did not register it, or it lacks what it needs (an API key)
 * - `switched-off`: the user switched it off (Spotify)
 * - `unreachable`: the platform cannot reach it (`capabilities`), e.g. Spotify in a plain browser
 * - `needs-full-tier`: it needs FXM Connect, the desktop app or the Android app (Last.fm stations)
 * - `unsupported-seed`: it cannot start from this seed: the seed names no artist; ListenBrainz
 *   finds no MusicBrainz ID for its artist; YouTube Music has no YouTube seed for it (an official
 *   video without a song in Music mode, a track or artist without a YouTube ID and no
 *   `youtubeSeed` adapter that finds one, a track of another source whose match is not its own
 *   song, or whose radio doesn't follow it); Spotify finds no artist for it, or refuses it as
 *   `unsupported-seed` itself
 *
 * Every other refusal, `Unsupported` ones included (a transport route that is closed, Spotify's
 * `client-rejected`), is a failure, reported with its error.
 */
export type SkipReason =
  | 'not-configured'
  | 'switched-off'
  | 'unreachable'
  | 'needs-full-tier'
  | 'unsupported-seed'

/** What one source did in one collection, for diagnostics, the UI and tests. */
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
      /**
       * The error itself, for the app to tell cases apart: `isRouteUnavailable` (and its
       * `needs` and `connectFeature`, to offer a fix), `isBudgetError`, Spotify's
       * `isSpotifyError(error, 'client-rejected')`.
       */
      error: unknown
    }
  | {
      source: RecommendationSource
      part: RecommendationPart
      /** It had not finished when the call's `deadlineMs` passed, and was cancelled. */
      status: 'timed-out'
      /** The deadline it missed, in milliseconds. */
      afterMs: number
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

/** One source's part of a {@link Collection}, as `onResult` delivers it. */
export interface SourceResult {
  /** What the source did. */
  outcome: SourceOutcome
  /** Its candidates, in its own order; empty unless the outcome is `ok`. */
  candidates: RecommendationCandidate[]
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

/** One source's part of a {@link HomeCollection}, as `onResult` delivers it. */
export interface SourceShelves {
  /** What the source did. */
  outcome: SourceOutcome
  /** Its shelves; empty unless the outcome is `ok`. */
  shelves: SourceShelf[]
}
