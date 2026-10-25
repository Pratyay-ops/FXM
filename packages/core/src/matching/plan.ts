/**
 * Which page a provider should fetch next for a match, and where its answer goes. The engine
 * stays pure: `runMatch` loops `nextMatchRequest` → the provider's fetch → `addMatchResponse`
 * until the planner returns `null`, then calls `matchTrack`. The order keeps the request budget
 * small: one InnerTube call on the happy path (an ISRC that passes at once), and seven at most
 * in Music mode.
 *
 * @module
 */

import { type EntityId, entityKey, formatId, isEntityId, normalizeIsrc } from '../ids'
import type { Track } from '../model'
import { stripPresentationNoise } from '../text'
import { matchTrack } from './engine'
import { isrcTrust } from './isrc'
import { isClassicalTitle, stripArtistPrefix } from './prepare'
import { albumMatchLevel, labelWords, sanitizeReleaseFacts, yearOf } from './release'
import {
  type MatchOptions,
  type MatchPages,
  type MatchRequest,
  type MatchResponse,
  type MatchResult,
  type MatchSource,
  type ReleaseFacts,
  type ReleaseFactsKey,
  resolveMatchThresholds,
  sanitizeMatchOptions,
} from './types'

/** How many candidates' descriptions are fetched at most, in all. */
const RELEASE_FACTS_LIMIT = 2

/** How many requests `runMatch` makes at most. The plan needs nine at the very most. */
const MAX_MATCH_REQUESTS = 12

/** Typographic dashes and quotes as ASCII, with the case kept, so a known artist prefix is found. */
function plainPunctuation(text: string): string {
  return text
    .replace(/[‐-―−]/gu, '-')
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‘’‚‛]/gu, "'")
}

/** The credited artist names, trimmed, without empty ones. */
function artistNames(source: Pick<MatchSource, 'artists'>): string[] {
  return source.artists.map((artist) => artist.name.trim()).filter((name) => name !== '')
}

/** The title for a query: presentation noise and a leading credit of the artists gone. */
function queryTitle(source: Pick<MatchSource, 'title' | 'artists'>): string {
  const title = plainPunctuation(stripPresentationNoise(source.title))
  return stripArtistPrefix(title, artistNames(source)).trim()
}

/**
 * All the source's artists and its title, version words kept: "The Weeknd Blinding Lights". A
 * leading credit of the artists in the title goes, so a video's "Chubby Checker - The Twist"
 * gives "Chubby Checker The Twist".
 */
export function textSearchQuery(source: Pick<MatchSource, 'title' | 'artists'>): string {
  return [...artistNames(source), queryTitle(source)].join(' ').trim()
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
export function videoSearchQuery(source: Pick<MatchSource, 'title' | 'artists'>): string {
  const artists = artistNames(source)
  const title = queryTitle(source)
  return artists.length > 0 ? `${artists.join(', ')} - ${title}` : title
}

/**
 * The songs search that `matchVideoToSong` reads for an official music video: its artists and
 * its title, without "(Official Video)" and the like or a leading "Artist - ".
 */
export function videoSongsQuery(video: Pick<Track, 'title' | 'artists'>): string {
  return textSearchQuery(video)
}

/** Whether the source has a label or a release date to check candidates' descriptions against. */
function hasReleaseFacts(source: MatchSource): boolean {
  const label = typeof source.label === 'string' && labelWords(source.label).size > 0
  return label || yearOf(source.releaseDate) !== undefined
}

/**
 * The descriptions to fetch next: of the top two songs that reach `suggest`, those not yet
 * described, within two descriptions in all.
 */
function releaseFactsRequest(
  result: MatchResult,
  pages: MatchPages,
  suggest: number,
): MatchRequest | null {
  const described = new Set(
    Object.keys(pages.releaseFacts ?? {})
      .filter((key): key is EntityId<'track'> => isEntityId(key, 'track'))
      .map((key) => entityKey(key)),
  )
  const budget = RELEASE_FACTS_LIMIT - described.size
  if (budget <= 0) return null
  const trackIds = result.candidates
    .filter((candidate) => candidate.kind === 'song' && candidate.confidence >= suggest)
    .slice(0, RELEASE_FACTS_LIMIT)
    .map((candidate) => formatId(candidate.source, 'track', candidate.ref))
    .filter((id) => !described.has(entityKey(id)))
    .slice(0, budget)
  return trackIds.length > 0 ? { kind: 'release-facts', trackIds } : null
}

/**
 * The next page to fetch for `source`, or `null` when the engine has what it needs. Pass the
 * same options as to `matchTrack` (`runMatch` does).
 *
 * 1. With an ISRC: the songs search for it; when nothing passes the gate, the unfiltered
 *    search's top-result card, then one retry (results vary between runs). A fuzzy ISRC gets the
 *    first search only. A verified item ends the plan.
 * 2. The songs search for all artists plus the title.
 * 3. When nothing would play automatically (judged as if the Auto setting were on, before any
 *    description is read), the search with the album, except for singles and classical titles.
 * 4. When the source has a label or a release date, the descriptions of the top two songs that
 *    reach `suggest`, last, so they cover what the album search added. When they turn an Auto
 *    match into a suggestion, the album search follows, and a song it brings to the top two is
 *    described too, within two descriptions in all.
 * 5. In Music + Video mode, when no song reaches `suggest`: the videos filter, then a regular
 *    YouTube search.
 *
 * When Auto is out of reach whatever else comes (no-duration mode, or a trusted ISRC that
 * missed), no description is fetched, and the album search only when no text candidate already
 * reaches `suggest` on the source's album. A request filed as skipped is never asked again, and
 * a skipped ISRC songs search ends the ISRC step (a skipped first one leaves the gate `not-run`).
 * Either way the result is `incomplete`.
 */
export function nextMatchRequest(
  source: MatchSource,
  pages: MatchPages,
  options: MatchOptions = {},
): MatchRequest | null {
  const settings = sanitizeMatchOptions(options)
  const thresholds = resolveMatchThresholds(settings.thresholds)
  const skipped = new Set(pages.skipped ?? [])
  const isrc = normalizeIsrc(source.isrc)
  const songs = pages.isrcSongs ?? []
  if (isrc !== null && songs.length === 0 && !skipped.has('isrc-songs')) {
    return { kind: 'isrc-songs', query: isrc, attempt: 1 }
  }
  // Judged as if the Auto setting were on: the setting decides whether the best plays without
  // asking, not which pages are worth fetching.
  const result = matchTrack(source, pages, { ...settings, auto: true })
  if (result.isrc.status === 'verified') return null
  if (
    isrc !== null &&
    songs.length > 0 &&
    isrcTrust(source.isrcOrigin) !== 'hint' &&
    !skipped.has('isrc-songs')
  ) {
    if (pages.isrcTopCard === undefined && !skipped.has('isrc-top-card')) {
      return { kind: 'isrc-top-card', query: isrc }
    }
    if (songs.length < 2) return { kind: 'isrc-songs', query: isrc, attempt: 2 }
  }
  if (pages.text === undefined && !skipped.has('text-songs')) {
    return { kind: 'text-songs', query: textSearchQuery(source) }
  }

  // Auto is out of reach whatever else is fetched: spend nothing that cannot change the band.
  const settled =
    result.autoBlockers.includes('no-duration') || result.autoBlockers.includes('isrc-miss')
  if (!result.autoEligible && pages.album === undefined && !skipped.has('album-songs')) {
    const query = albumSearchQuery(source)
    const onAlbum = result.candidates.some(
      (candidate) =>
        candidate.kind === 'song' &&
        candidate.confidence >= thresholds.suggest &&
        candidate.signals?.sourceAlbumMatch === true,
    )
    if (query !== undefined && !(settled && onAlbum)) return { kind: 'album-songs', query }
  }
  if (!settled && hasReleaseFacts(source) && !skipped.has('release-facts')) {
    const request = releaseFactsRequest(result, pages, thresholds.suggest)
    if (request !== null) return request
  }
  if (settings.mode === 'all') {
    const songFound = result.candidates.some(
      (candidate) => candidate.kind === 'song' && candidate.confidence >= thresholds.suggest,
    )
    if (!songFound && pages.videos === undefined && !skipped.has('videos')) {
      return { kind: 'videos', query: videoSearchQuery(source) }
    }
    if (!songFound && pages.youtube === undefined && !skipped.has('youtube')) {
      return { kind: 'youtube', query: videoSearchQuery(source) }
    }
  }
  return null
}

/** Files the songs search for `attempt`, which must be the next attempt or one already filed. */
function fileAttempt(
  songs: readonly (readonly Track[])[],
  attempt: number,
  tracks: readonly Track[],
): (readonly Track[])[] {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > songs.length + 1) {
    throw new RangeError(`ISRC search attempt ${attempt} cannot follow ${songs.length} attempts`)
  }
  const filed = [...songs]
  filed[attempt - 1] = tracks
  return filed
}

/**
 * Files descriptions: every requested track counts as described, with what the answer says
 * about it or nothing.
 */
function fileFacts(
  pages: MatchPages,
  trackIds: readonly EntityId<'track'>[],
  facts: Readonly<Record<string, ReleaseFacts>>,
): Record<ReleaseFactsKey, ReleaseFacts> {
  const requested = new Map(trackIds.map((id) => [entityKey(id), id] as const))
  const filed: Record<ReleaseFactsKey, ReleaseFacts> = { ...pages.releaseFacts }
  for (const id of trackIds) filed[id] = {}
  for (const [key, value] of Object.entries(facts)) {
    if (!isEntityId(key, 'track')) {
      throw new RangeError(
        `Release facts are keyed by a full track ID such as ytm:track:<videoId>, not ${JSON.stringify(key)}`,
      )
    }
    const id = requested.get(entityKey(key))
    if (id === undefined) throw new RangeError(`Release facts for ${key}, which was not requested`)
    filed[id] = sanitizeReleaseFacts(value)
  }
  return filed
}

/** Files a request the provider could not answer. */
function skipRequest(pages: MatchPages, request: MatchRequest): MatchPages {
  const skipped = [...(pages.skipped ?? []), request.kind]
  if (request.kind !== 'release-facts') return { ...pages, skipped }
  const filed: Record<ReleaseFactsKey, ReleaseFacts> = { ...pages.releaseFacts }
  for (const id of request.trackIds) filed[id] ??= {}
  return { ...pages, skipped, releaseFacts: filed }
}

/**
 * Files a provider's answer to `request` into the pages, returning new pages. `null` files the
 * request as skipped: the planner never asks it again, and the match is `incomplete`.
 *
 * @throws RangeError when the answer is of another kind than the request, when an ISRC search
 * attempt comes out of order (a second answer to an attempt replaces the first), or when
 * release facts are keyed by anything but a requested track ID, such as a bare videoId.
 */
export function addMatchResponse(
  pages: MatchPages,
  request: MatchRequest,
  response: MatchResponse | null,
): MatchPages {
  if (response === null) return skipRequest(pages, request)
  if (response.kind !== request.kind) {
    throw new RangeError(`A ${response.kind} answer cannot answer a ${request.kind} request`)
  }
  switch (response.kind) {
    case 'isrc-songs': {
      const attempt = request.kind === 'isrc-songs' ? request.attempt : 0
      return { ...pages, isrcSongs: fileAttempt(pages.isrcSongs ?? [], attempt, response.tracks) }
    }
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
    case 'release-facts': {
      const trackIds = request.kind === 'release-facts' ? request.trackIds : []
      return { ...pages, releaseFacts: fileFacts(pages, trackIds, response.facts) }
    }
  }
}

/**
 * Runs a whole match: asks the planner for each page, has `fetchPage` fetch it, files the
 * answer, and returns `matchTrack`'s decision, with the same `options` throughout. A provider
 * needs no user settings for it: the best candidate carries the verdict without the Auto
 * setting (see `effectiveMatchBand`).
 *
 * `fetchPage` makes the one InnerTube call a request names, through the provider's request
 * budget, and answers it with a {@link MatchResponse} of the same kind. When it cannot (a network
 * error, a bot check, a request the budget refuses), it returns `null`: the match goes on
 * without that page and the result is `incomplete`, so a cache does not keep it. To cancel,
 * reject (e.g. with the context's abort reason): `runMatch` rejects with it.
 */
export async function runMatch(
  source: MatchSource,
  fetchPage: (request: MatchRequest) => Promise<MatchResponse | null>,
  options: MatchOptions = {},
): Promise<MatchResult> {
  let pages: MatchPages = {}
  for (let count = 0; count < MAX_MATCH_REQUESTS; count++) {
    const request = nextMatchRequest(source, pages, options)
    if (request === null) return matchTrack(source, pages, options)
    pages = addMatchResponse(pages, request, await fetchPage(request))
  }
  const result = matchTrack(source, pages, options)
  return nextMatchRequest(source, pages, options) === null
    ? result
    : { ...result, incomplete: true }
}
