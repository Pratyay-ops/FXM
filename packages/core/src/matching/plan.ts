/**
 * Which page a provider should fetch next for a match, and where its answer goes. The engine
 * stays pure: a provider loops `nextMatchRequest` → fetch → `addMatchResponse` until the planner
 * returns `null`, then calls `matchTrack`. The order keeps the request budget small: one
 * InnerTube call on the happy path (an ISRC that passes at once), and about seven at most.
 *
 * @module
 */

import { type EntityId, formatId, normalizeIsrc } from '../ids'
import type { Track } from '../model'
import { stripPresentationNoise } from '../text'
import { matchTrack } from './engine'
import { isClassicalTitle } from './prepare'
import { albumMatchLevel, yearOf } from './release'
import {
  type MatchOptions,
  type MatchPages,
  type MatchSource,
  type ReleaseFacts,
  resolveThresholds,
} from './types'

/** A page the engine needs, in YouTube Music's terms. */
export type MatchRequest =
  /** A YouTube Music songs search with the ISRC as the query (`attempt` 2 is the retry). */
  | { kind: 'isrc-songs'; query: string; attempt: number }
  /** An unfiltered YouTube Music search for the ISRC; only its top-result card is read. */
  | { kind: 'isrc-top-card'; query: string }
  /** A YouTube Music songs search for all artists plus the title. */
  | { kind: 'text-songs'; query: string }
  /** The same with the album added. */
  | { kind: 'album-songs'; query: string }
  /**
   * The descriptions of these candidates (one `next` or `player` call each), for their label and
   * release year. Read them with `parseReleaseDescription`.
   */
  | { kind: 'release-facts'; trackIds: EntityId<'track'>[] }
  /** Music + Video mode: a YouTube Music search with the videos filter. */
  | { kind: 'videos'; query: string }
  /** Music + Video mode: a regular YouTube search. */
  | { kind: 'youtube'; query: string }

/** The answer to a {@link MatchRequest}. */
export type MatchResponse =
  | {
      kind: 'isrc-songs' | 'text-songs' | 'album-songs' | 'videos' | 'youtube'
      /** The page's items in order. */
      tracks: readonly Track[]
    }
  | {
      kind: 'isrc-top-card'
      /** The top-result card's track, or `null` when the page had none. */
      card: Track | null
    }
  | {
      kind: 'release-facts'
      /** What each description says, keyed by the candidate's track ID. */
      facts: Readonly<Record<string, ReleaseFacts>>
    }

/** All the source's artists and its title, version words kept: "The Weeknd Blinding Lights". */
export function textSearchQuery(source: MatchSource): string {
  const artists = source.artists.map((artist) => artist.name.trim()).filter((name) => name !== '')
  return [...artists, stripPresentationNoise(source.title)].join(' ').trim()
}

/**
 * The text query with the album added, or `undefined` when a second search would not help:
 * without an album, for singles (`albumType` `single`, or an album named like the title), and
 * for classical-looking titles, whose album search returns other performers.
 */
export function albumSearchQuery(source: MatchSource): string | undefined {
  const album = source.album?.name.trim()
  if (album === undefined || album === '') return undefined
  if (source.albumType === 'single') return undefined
  if (albumMatchLevel(album, source.title) !== 'none') return undefined
  if (isClassicalTitle(source.title)) return undefined
  return `${textSearchQuery(source)} ${album}`
}

/** "Artists - Title", for the video searches of Music + Video mode. */
export function videoSearchQuery(source: MatchSource): string {
  const artists = source.artists.map((artist) => artist.name.trim()).filter((name) => name !== '')
  const title = stripPresentationNoise(source.title)
  return artists.length > 0 ? `${artists.join(', ')} - ${title}` : title
}

/** How many candidates' descriptions are fetched at most. */
const RELEASE_FACTS_LIMIT = 2

/**
 * The next page to fetch for `source`, or `null` when the engine has what it needs:
 *
 * 1. With an ISRC: the songs search for it; when nothing passes the gate, the unfiltered
 *    search's top-result card, then one retry (results vary between runs). A fuzzy ISRC gets the
 *    first search only. A verified item ends the plan.
 * 2. The songs search for all artists plus the title.
 * 3. When nothing would play automatically (judged as if the Auto setting were on), the search
 *    with the album, except for singles and classical titles.
 * 4. When the source has a label or a release date, the descriptions of the top two songs that
 *    reach `suggest`, once.
 * 5. In Music + Video mode, when no song reaches `suggest`: the videos filter, then a regular
 *    YouTube search.
 */
export function nextMatchRequest(
  source: MatchSource,
  pages: MatchPages,
  options: MatchOptions = {},
): MatchRequest | null {
  const thresholds = resolveThresholds(options)
  const isrc = normalizeIsrc(source.isrc)
  const songs = pages.isrcSongs ?? []
  if (isrc !== null && songs.length === 0) return { kind: 'isrc-songs', query: isrc, attempt: 1 }
  // Judged as if the Auto setting were on: the setting decides whether the best plays without
  // asking, not which candidate is best.
  const result = matchTrack(source, pages, { ...options, auto: true })
  if (isrc !== null) {
    if (result.isrc.status === 'verified') return null
    if (source.isrcOrigin !== 'musicbrainz-fuzzy') {
      if (pages.isrcTopCard === undefined) return { kind: 'isrc-top-card', query: isrc }
      if (songs.length < 2) return { kind: 'isrc-songs', query: isrc, attempt: 2 }
    }
  }
  if (pages.text === undefined) return { kind: 'text-songs', query: textSearchQuery(source) }

  if (result.band !== 'auto' && pages.album === undefined) {
    const query = albumSearchQuery(source)
    if (query !== undefined) return { kind: 'album-songs', query }
  }
  const hasReleaseFacts = source.label !== undefined || yearOf(source.releaseDate) !== undefined
  if (hasReleaseFacts && pages.releaseFacts === undefined) {
    const top = result.candidates
      .filter(
        (candidate) => candidate.kind === 'song' && candidate.confidence >= thresholds.suggest,
      )
      .slice(0, RELEASE_FACTS_LIMIT)
      .map((candidate) => formatId(candidate.source, 'track', candidate.ref))
    if (top.length > 0) return { kind: 'release-facts', trackIds: top }
  }
  if ((options.mode ?? 'music') === 'all') {
    const songFound = result.candidates.some(
      (candidate) => candidate.kind === 'song' && candidate.confidence >= thresholds.suggest,
    )
    if (!songFound && pages.videos === undefined) {
      return { kind: 'videos', query: videoSearchQuery(source) }
    }
    if (!songFound && pages.youtube === undefined) {
      return { kind: 'youtube', query: videoSearchQuery(source) }
    }
  }
  return null
}

/** Files a provider's answer to a {@link MatchRequest} into the pages, returning new pages. */
export function addMatchResponse(pages: MatchPages, response: MatchResponse): MatchPages {
  switch (response.kind) {
    case 'isrc-songs':
      return { ...pages, isrcSongs: [...(pages.isrcSongs ?? []), response.tracks] }
    case 'isrc-top-card':
      return { ...pages, isrcTopCard: response.card }
    case 'text-songs':
      return { ...pages, text: response.tracks }
    case 'album-songs':
      return { ...pages, album: response.tracks }
    case 'videos':
      return { ...pages, videos: response.tracks }
    case 'youtube':
      return { ...pages, youtube: response.tracks }
    case 'release-facts':
      return { ...pages, releaseFacts: { ...pages.releaseFacts, ...response.facts } }
  }
}
