/**
 * How the labelled set stores YouTube Music pages, and how a recording answers the matching
 * planner's requests offline. The recorder (`@fxm/sources/eval`) files what it fetches with
 * {@link pageKeys} and {@link encodeTrack}; the replay answers with {@link answerFromRecording}.
 * Both sides use these functions, so a page recorded once is found again.
 *
 * @module
 */

import { formatId, isEntityId, parseId } from '../../ids'
import type { Track } from '../../model'
import { sanitizeReleaseFacts } from '../release'
import type {
  MatchOptions,
  MatchRequest,
  MatchResponse,
  MatchSource,
  ReleaseFacts,
  ReleaseFactsKey,
} from '../types'
import type { EvalItem, EvalPage, EvalRecording } from './types'

/**
 * The keys a request's pages are filed under: one for a search or a top-result card, one per
 * track for descriptions. Text and album searches are both songs searches, filed by their query,
 * so two inputs that search the same query share the page.
 */
export function pageKeys(request: MatchRequest): string[] {
  switch (request.kind) {
    case 'isrc-songs':
      return [`isrc-songs/${request.attempt}/${request.query}`]
    case 'isrc-top-card':
      return [`isrc-top-card/${request.query}`]
    case 'text-songs':
    case 'album-songs':
      return [`songs/${request.query}`]
    case 'videos':
      return [`videos/${request.query}`]
    case 'youtube':
      return [`youtube/${request.query}`]
    case 'release-facts':
      return request.trackIds.map((id) => `description/${parseId(id).nativeId}`)
  }
}

/** What a page key names, for the recorder to fetch it (see {@link pageKeys}). */
export type PageKeyParts =
  | { kind: 'isrc-songs'; attempt: number; query: string }
  | { kind: 'isrc-top-card'; query: string }
  | { kind: 'songs'; query: string }
  | { kind: 'videos'; query: string }
  | { kind: 'youtube'; query: string }
  | { kind: 'description'; videoId: string }

/** Reads a page key back; `undefined` for anything {@link pageKeys} does not make. */
export function parsePageKey(key: string): PageKeyParts | undefined {
  const slash = key.indexOf('/')
  if (slash <= 0) return undefined
  const kind = key.slice(0, slash)
  const rest = key.slice(slash + 1)
  if (rest === '') return undefined
  switch (kind) {
    case 'isrc-songs': {
      const match = /^(\d+)\/(.+)$/su.exec(rest)
      return match?.[1] && match[2]
        ? { kind, attempt: Number(match[1]), query: match[2] }
        : undefined
    }
    case 'isrc-top-card':
    case 'songs':
    case 'videos':
    case 'youtube':
      return { kind, query: rest }
    case 'description':
      return { kind, videoId: rest }
    default:
      return undefined
  }
}

/** At most this many characters of a description are kept, for people. */
const EXCERPT_LIMIT = 400

/**
 * The lines YouTube generates for a label upload ("Provided to YouTube by …", "Title · Artist",
 * the album, the ℗ line, "Released on: …"), for people reviewing labels; `undefined` for any
 * other description. The rest (credits, links, lyrics) is never kept.
 */
export function descriptionExcerpt(description: string | undefined): string | undefined {
  if (description === undefined) return undefined
  const lines = description
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (!/^Provided to YouTube by\s/iu.test(lines[0] ?? '')) return undefined
  const kept: string[] = []
  for (const line of lines.slice(0, 6)) {
    if (/https?:\/\//iu.test(line)) continue
    kept.push(line)
    if (/^Released on:/iu.test(line)) break
  }
  const text = kept.join('\n')
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT - 1)}…` : text
}

/** The videoId of a YouTube track, or `undefined` for a track of another source. */
export function videoIdOf(track: Pick<Track, 'id'>): string | undefined {
  const parts = parseId(track.id)
  return parts !== null && (parts.source === 'ytm' || parts.source === 'yt')
    ? parts.nativeId
    : undefined
}

/**
 * A YouTube track as the labelled set stores it: what the matching engine reads, without
 * artwork, artist IDs or anything else. `undefined` for a track of another source.
 */
export function encodeTrack(track: Track): EvalItem | undefined {
  const videoId = videoIdOf(track)
  if (videoId === undefined) return undefined
  const item: EvalItem = {
    kind: track.kind,
    title: track.title,
    artists: track.artists.map((artist) => artist.name),
  }
  if (track.album !== undefined) {
    item.album = track.album.name
    const albumId = track.album.id === undefined ? undefined : parseId(track.album.id)
    if (albumId?.kind === 'album') item.albumId = albumId.nativeId
  }
  if (typeof track.durationMs === 'number' && track.durationMs > 0) {
    item.durationMs = Math.round(track.durationMs)
  }
  if (track.explicit === true) item.explicit = true
  if (track.releaseDate !== undefined) item.releaseDate = track.releaseDate
  const song = track.songId === undefined ? undefined : parseId(track.songId)
  if (song?.kind === 'track') item.songId = song.nativeId
  if (track.source === 'yt') item.source = 'yt'
  return item
}

/** A stored item as a core `Track`, the way the YouTube provider returns it. */
export function decodeItem(videoId: string, item: EvalItem): Track {
  const source = item.source ?? 'ytm'
  const track: Track = {
    id: formatId(source, 'track', videoId),
    source,
    title: item.title,
    artists: item.artists.map((name) => ({ name })),
    artwork: [],
    kind: item.kind,
  }
  if (item.album !== undefined) {
    track.album = { name: item.album }
    if (item.albumId !== undefined) track.album.id = formatId(source, 'album', item.albumId)
  }
  if (item.durationMs !== undefined) track.durationMs = item.durationMs
  if (item.explicit === true) track.explicit = true
  if (item.releaseDate !== undefined) track.releaseDate = item.releaseDate
  if (item.songId !== undefined) track.songId = formatId('ytm', 'track', item.songId)
  return track
}

/** An empty recording. */
export function emptyRecording(): EvalRecording {
  return { recordedAt: [], items: {}, pages: {} }
}

/**
 * Files tracks in a recording's item table and returns their videoIds in order. An item already
 * filed is kept as it was: YouTube describes a video the same way on every page.
 */
export function fileItems(recording: EvalRecording, tracks: readonly Track[]): string[] {
  const ids: string[] = []
  for (const track of tracks) {
    const item = encodeTrack(track)
    const videoId = videoIdOf(track)
    if (item === undefined || videoId === undefined) continue
    recording.items[videoId] ??= item
    ids.push(videoId)
  }
  return ids
}

/** The tracks of a recorded search page, or `undefined` when it is missing or failed. */
export function recordedTracks(recording: EvalRecording, key: string): Track[] | undefined {
  const page = recording.pages[key]
  if (page === undefined || !('items' in page)) return undefined
  return page.items.flatMap((videoId) => {
    const item = recording.items[videoId]
    return item === undefined ? [] : [decodeItem(videoId, item)]
  })
}

/** Whether a page was recorded, as a page or as a failure. */
export function isRecorded(recording: EvalRecording, key: string): boolean {
  return recording.pages[key] !== undefined
}

/** The release facts of a recorded description, or `undefined` when it is missing or failed. */
export function recordedFacts(recording: EvalRecording, videoId: string): ReleaseFacts | undefined {
  const page = recording.pages[`description/${videoId}`]
  return page !== undefined && 'facts' in page ? sanitizeReleaseFacts(page.facts) : undefined
}

/**
 * The answer a recording gives to a planner request, as the provider gave it when it was
 * recorded; `null` when the recording has no usable answer: a page that was never recorded
 * (another configuration asked for it) or one that failed. The caller files `null` as a skipped
 * page, so the match is `incomplete`, as it would be live.
 */
export function answerFromRecording(
  request: MatchRequest,
  recording: EvalRecording,
): MatchResponse | null {
  switch (request.kind) {
    case 'isrc-songs':
    case 'text-songs':
    case 'album-songs':
    case 'videos':
    case 'youtube': {
      const [key] = pageKeys(request)
      const tracks = key === undefined ? undefined : recordedTracks(recording, key)
      return tracks === undefined ? null : { kind: request.kind, tracks }
    }
    case 'isrc-top-card': {
      const [key] = pageKeys(request)
      const page = key === undefined ? undefined : recording.pages[key]
      if (page === undefined || !('item' in page)) return null
      if (page.item === null) return { kind: 'isrc-top-card', card: null }
      const item = recording.items[page.item]
      return item === undefined
        ? null
        : { kind: 'isrc-top-card', card: decodeItem(page.item, item) }
    }
    case 'release-facts': {
      const facts: Record<ReleaseFactsKey, ReleaseFacts> = {}
      for (const id of request.trackIds) {
        const videoId = isEntityId(id, 'track') ? parseId(id).nativeId : undefined
        const found = videoId === undefined ? undefined : recordedFacts(recording, videoId)
        if (found === undefined) return null
        facts[id] = found
      }
      return { kind: 'release-facts', facts }
    }
  }
}

/** The kinds of page a recorder fetches, and so the kinds of {@link EvalPage} it files. */
export type RecordedPageKind = 'search' | 'top-card' | 'description' | 'error'

/** What kind of page a recorded page is. */
export function pageKindOf(page: EvalPage): RecordedPageKind {
  if ('items' in page) return 'search'
  if ('item' in page) return 'top-card'
  if ('facts' in page) return 'description'
  return 'error'
}

// --- What the recorder records ------------------------------------------------------------

/**
 * The match options the recorder runs the planner with, for every input: the pages any of them
 * asks for are recorded, so the replay can run each offline. Besides the default thresholds:
 * the measured fallback (album or year agreement for text-only Auto, which changes when the
 * album search runs), and the strictest corner of the calibration grid (`TUNING_GRID`), which
 * asks for album searches and descriptions wherever a stricter setting would.
 */
export const RECORDING_OPTIONS: readonly MatchOptions[] = Object.freeze([
  { auto: true, mode: 'music' },
  { auto: true, mode: 'music', requireReleaseAgreement: true },
  { auto: true, mode: 'music', thresholds: { auto: 0.9, autoTitle: 0.9, margin: 0.1 } },
])

/**
 * The input with its ISRC's miss cap lifted: a trusted ISRC (`catalog`, `musicbrainz-exact` or
 * no origin) becomes one of several (`musicbrainz-exact-several`), which still verifies on a
 * pass but caps nothing on a miss. The report replays it to measure what the cap costs; the
 * recorder records its pages for that. `undefined` when the input has no trusted ISRC.
 */
export function withoutIsrcCap(source: MatchSource): MatchSource | undefined {
  if (source.isrc === undefined) return undefined
  const origin = source.isrcOrigin
  if (origin !== undefined && origin !== 'catalog' && origin !== 'musicbrainz-exact') {
    return undefined
  }
  return { ...source, isrcOrigin: 'musicbrainz-exact-several' }
}
