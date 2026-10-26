/**
 * What an import reads and produces: the rows of a playlist file, a Spotify data export or a
 * Spotify or YouTube playlist, the listening history a data export brings, and what the import
 * decided for each row. Everything here is plain data that survives `JSON.stringify`, so an
 * import's progress can be saved and resumed.
 *
 * Optional fields follow `exactOptionalPropertyTypes`: leave them out, never set them to
 * `undefined`.
 *
 * @module
 */

import type {
  Album,
  AlbumType,
  Artist,
  AudioCandidate,
  AutoBlocker,
  CatalogMode,
  EntityId,
  IsrcOrigin,
  MatchBand,
  Track,
  TrackKind,
} from '@fxm/core'

/**
 * What an import reads:
 *
 * - `spotify-export`: Spotify's "Download your data" files (playlists, liked songs, saved albums
 *   and artists, listening history)
 * - `csv`: a CSV file, such as one Exportify writes
 * - `m3u`: an M3U or M3U8 playlist file
 * - `spotify`: a Spotify playlist, album or track link, read through the Spotify provider
 * - `youtube`: a YouTube or YouTube Music playlist link, read through the YouTube provider
 */
export type ImportKind = 'spotify-export' | 'csv' | 'm3u' | 'spotify' | 'youtube'

/** Every {@link ImportKind}. */
export const IMPORT_KINDS: readonly ImportKind[] = [
  'spotify-export',
  'csv',
  'm3u',
  'spotify',
  'youtube',
]

/**
 * One track as an import's input describes it: a line of a CSV or M3U file, an item of a
 * Spotify data export, or a track of a Spotify or YouTube playlist.
 */
export interface ImportRow {
  /** The title as the input spells it. */
  title: string
  /** The credited artists, main artist first. May be empty when the input names none. */
  artists: string[]
  /** The album, when the input names it. */
  album?: string
  /** The length in milliseconds, when the input says. A data export never does. */
  durationMs?: number
  /** The ISRC, canonical, when the input carries one (an Exportify CSV does). */
  isrc?: string
  /** Whether the input marks the track explicit. */
  explicit?: boolean
  /** The release date of its album as ISO 8601, possibly partial. */
  releaseDate?: string
  /** The record label of its album. */
  label?: string
  /** The release type of its album. */
  albumType?: AlbumType
  /** When it joined the playlist in the input, as epoch milliseconds. */
  addedAt?: number
  /**
   * The input's own track, when it names one in a catalog FXM knows: `spotify:track:…` from a
   * Spotify URI, `ytm:track:…` or `yt:track:…` from a YouTube link or playlist. Rows without one
   * (most M3U lines, CSV rows without a URI) are matched and then take the matched song's ID.
   */
  trackId?: EntityId<'track'>
  /** What `trackId`'s track is, when the input says (YouTube playlists do). */
  kind?: TrackKind
  /** For an official music video: its song, when the source links the two. */
  songId?: EntityId<'track'>
  /** Where an M3U line points, for people: a file path or URL. */
  location?: string
  /**
   * The input's whole track, when it came from a catalog (a Spotify or YouTube playlist), for the
   * library to show with its artwork. It is only kept while the import starts: saved progress
   * leaves it out (see `storedRow`).
   */
  track?: Track
}

/** A playlist an import creates: its name and its rows, in order. */
export interface ImportCollection {
  /** The playlist's name. */
  name: string
  /** Its description, when the input has one. */
  description?: string
  /** Its rows, in the input's order, each track once. */
  rows: ImportRow[]
}

/** One play of a listening history an import brings in, as a listening signal (stage 3.1). */
export interface ImportPlay {
  /** The track that played: a Spotify track with the title, artists and album the history names. */
  track: Track
  /** When it started, as epoch milliseconds. */
  playedAt: number
  /** How long it played, in milliseconds. */
  playedMs: number
  /** Whether it played to the end, when the history says. */
  completed: boolean
  /** Whether the user skipped it, when the history says. */
  skipped: boolean
}

/** What an input held that the import leaves out, counted for the preview. */
export interface ImportSkips {
  /** Podcast episodes, audiobooks and videos: FXM imports music. */
  episodes: number
  /** Local files of the other app, which name no catalog track. */
  localFiles: number
  /** Rows without a usable title, and lines or items that could not be read. */
  unreadable: number
  /** The same track twice in one playlist: it is kept once. */
  duplicates: number
  /** Plays shorter than {@link MIN_PLAY_MS}, unless the history marks them skipped. */
  shortPlays: number
  /** Plays whose track the history does not identify and the export lists nowhere else. */
  unknownPlays: number
  /** Rows of a playlist beyond the most one import holds (`MAX_IMPORT_ROWS`). */
  overLimit: number
}

/** A {@link ImportSkips} with every count at 0. */
export function noSkips(): ImportSkips {
  return {
    episodes: 0,
    localFiles: 0,
    unreadable: 0,
    duplicates: 0,
    shortPlays: 0,
    unknownPlays: 0,
    overLimit: 0,
  }
}

/**
 * The shortest play a listening history import keeps, in milliseconds. Spotify logs a play for
 * every track that starts, even for a moment; such plays say little about taste.
 */
export const MIN_PLAY_MS = 5_000

/** What an input holds, ready for the import preview and the library. */
export interface ParsedImport {
  /** What was read. */
  kind: ImportKind
  /** What to call it, for people: a file name or a playlist's name. */
  label: string
  /** The playlists to create, in order. */
  collections: ImportCollection[]
  /** The listening history, oldest first (data exports only). */
  plays: ImportPlay[]
  /** Saved albums and followed artists (data exports only). */
  follows: (Album | Artist)[]
  /** What the input held that the import leaves out. */
  skipped: ImportSkips
}

/**
 * What an import decided for one row, before the user's review:
 *
 * - `ready`: the row's own track plays as it is in the import's catalog mode (a YouTube Music
 *   song, or any YouTube item in Music + Video mode); nothing to match
 * - `matched`: matched to a song that plays without asking (the Auto band)
 * - `review`: a best guess that plays only once the user confirms it (the Suggest band)
 * - `not-found`: nothing good enough was found (the None band), or the row's own track cannot
 *   play in the mode and has no match (a YouTube video in Music mode)
 * - `failed`: the row could not be processed
 */
export type RowOutcome = 'ready' | 'matched' | 'review' | 'not-found' | 'failed'

/** Every {@link RowOutcome}. */
export const ROW_OUTCOMES: readonly RowOutcome[] = [
  'ready',
  'matched',
  'review',
  'not-found',
  'failed',
]

/**
 * What a candidate's search page said beyond the `AudioCandidate`, kept so the review list can
 * show it and the library can save the song: its album and one artwork size.
 */
export interface CandidateExtras {
  /** The album, as the search page listed it. */
  album?: { id?: EntityId<'album'>; name: string }
  /** One artwork image, small enough for a list row. */
  artwork?: { url: string; width?: number; height?: number }
}

/** What the user decided about a row in the review list. */
export interface RowReview {
  /** `confirmed`: they chose a candidate; `skipped`: they left the row out. */
  action: 'confirmed' | 'skipped'
  /** The candidate they chose (its `ref`), for `confirmed`. */
  ref?: string
  /** When, as epoch milliseconds. */
  at: number
}

/** What the matching found for a row, and what became of it. */
export interface RowResult {
  /** What the import decided. */
  outcome: RowOutcome
  /**
   * The band the matching engine reached with the Auto setting on (its verdict): `auto` means
   * the match would play without asking once Auto matching is on.
   */
  verdict?: MatchBand
  /** The best candidate, carrying the engine's verdict. */
  best?: AudioCandidate
  /** The next candidates, best first: the alternatives the review list offers. */
  alternatives?: AudioCandidate[]
  /** Album and artwork of the best candidate and the alternatives, by candidate `ref`. */
  extras?: Record<string, CandidateExtras>
  /** Why, for people: the engine's evidence. */
  evidence?: string[]
  /** Why the best did not reach the Auto band. */
  blockers?: AutoBlocker[]
  /** The ISRC the match used, canonical. */
  isrc?: string
  /** Where that ISRC came from. */
  isrcOrigin?: IsrcOrigin
  /** Where the row's ISRC or length came from, when the import looked them up. */
  lookup?: 'spotify' | 'musicbrainz'
  /** Set when the row had no length, so the engine ran in no-duration mode (at most Suggest). */
  noDuration?: true
  /** Set when a search the engine asked for could not be fetched. */
  incomplete?: true
  /** Set when the decision came from the library's match cache, not a new search. */
  cached?: true
  /** Why the row failed, for people. */
  error?: string
  /** What the user decided in the review list. */
  review?: RowReview
  /**
   * The track the row has in the playlist: its own catalog track, or the song it was matched
   * to. Absent while a row without a catalog track waits for the user's review.
   */
  playlistTrackId?: EntityId<'track'>
}

/** An import row as saved with the progress: an {@link ImportRow} without its whole track. */
export type StoredRow = Omit<ImportRow, 'track'>

/** What the import looked up about a row before matching it. */
export interface RowLookup {
  /** Where it came from. */
  source: 'spotify' | 'musicbrainz'
  /** The ISRC found, canonical. */
  isrc?: string
  /** Where the ISRC comes from, in the matching engine's words. */
  isrcOrigin?: IsrcOrigin
  /** The length found, in milliseconds. */
  durationMs?: number
  /** The album's label (Spotify). */
  label?: string
  /** The album's release date (Spotify). */
  releaseDate?: string
  /** The album's release type (Spotify). */
  albumType?: AlbumType
  /** Whether the track is explicit (Spotify). */
  explicit?: boolean
}

/**
 * An import's saved progress: its rows, what was decided for each, and what was looked up. It
 * goes into the library's import-progress record (`state`), so an import resumes after a reload
 * where it stopped.
 */
export interface ImportState {
  /** The format's version. */
  version: 1
  /** What was imported. */
  kind: ImportKind
  /** The catalog mode the import matches in. */
  mode: CatalogMode
  /** The rows, in order. */
  rows: StoredRow[]
  /** What was decided for each row, in the same order; `null` while a row waits. */
  results: (RowResult | null)[]
  /** What was looked up about rows before matching, by row index. `null`: nothing was found. */
  lookups: Record<string, RowLookup | null>
}

/** The current {@link ImportState.version}. */
export const IMPORT_STATE_VERSION = 1
