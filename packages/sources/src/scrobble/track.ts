/**
 * What a scrobble says about a track, built from a core `Track`, and the guard that checks
 * scrobbles read back from storage.
 *
 * Only songs and official music videos are scrobbled. Other videos (covers, live sets, uploads
 * that Music + Video mode plays) and episodes are not: their artist is a channel and their
 * title free text, and Last.fm asks for metadata "from well-structured sources" only.
 *
 * @module
 */

import {
  artistAffinityKey,
  normalizeIsrc,
  normalizeText,
  parseId,
  stripPresentationNoise,
  type Track,
} from '@fxm/core'
import { playLengthMs, validLengthMs } from './rules'
import type { Scrobble, ScrobblePlay, ScrobbleTrack } from './types'

/** The longest name a scrobble sends, in UTF-16 code units; longer ones are cut. */
export const MAX_SCROBBLE_NAME_LENGTH = 500

/** The most artists a scrobble lists. */
const MAX_ARTISTS = 10

/** A Spotify ID: 22 base62 characters. */
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/u

/** The oldest start ListenBrainz accepts (2002-10-01), in epoch milliseconds. */
export const MIN_SCROBBLE_TIME_MS = 1_033_430_400_000

/**
 * A name cleaned for sending: runs of whitespace fold into one space, the ends are trimmed, and
 * it is cut to {@link MAX_SCROBBLE_NAME_LENGTH}, never inside a character. `undefined` when
 * nothing is left.
 */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const folded = value.replace(/\s+/gu, ' ').trim()
  if (folded === '') return undefined
  if (folded.length <= MAX_SCROBBLE_NAME_LENGTH) return folded
  const cut = folded.slice(0, MAX_SCROBBLE_NAME_LENGTH)
  const last = cut.charCodeAt(cut.length - 1)
  // A high surrogate at the end is half of a character that the cut split.
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd()
}

/** A YouTube channel's name as the artist's: without " - Topic" and a trailing "VEVO". */
function youtubeArtist(name: string): string {
  return name.replace(/\s*-\s*Topic$/iu, '').replace(/\s*VEVO$/u, '')
}

/**
 * A music video's title as the song's: without presentation noise ("(Official Video)") and
 * without a leading "Artist - " that names one of its artists.
 */
function videoTitle(title: string, artists: readonly string[]): string {
  const stripped = stripPresentationNoise(title)
  const dash = /\s+[-–—]\s+/u.exec(stripped)
  if (dash !== null) {
    const before = normalizeText(stripped.slice(0, dash.index))
    if (artists.some((artist) => normalizeText(artist) === before)) {
      const rest = stripped.slice(dash.index + dash[0].length).trim()
      if (rest !== '') return rest
    }
  }
  return stripped
}

/** The parts of a `Track` a scrobble can carry. */
export type ScrobbleSource = Pick<
  Track,
  | 'id'
  | 'source'
  | 'title'
  | 'artists'
  | 'album'
  | 'durationMs'
  | 'trackNumber'
  | 'isrc'
  | 'kind'
  | 'externalIds'
>

/**
 * What a scrobble says about `track`, or `null` when FXM doesn't scrobble it: a video that is
 * not an official music video, an episode, or a track without a title or a real artist
 * ("Unknown Artist" and "Various Artists" don't count, as in the listening signals).
 *
 * Artists keep their credited order, each once. A YouTube channel's " - Topic" and "VEVO" are
 * dropped, and a music video's title loses its presentation noise and an "Artist - " prefix.
 */
export function scrobbleTrackOf(track: ScrobbleSource): ScrobbleTrack | null {
  if (track.kind !== 'song' && track.kind !== 'music-video') return null
  const youtube = track.source === 'ytm' || track.source === 'yt'
  const artists: string[] = []
  const seen = new Set<string>()
  for (const credit of Array.isArray(track.artists) ? track.artists : []) {
    const raw = cleanName(credit?.name)
    const name = raw !== undefined && youtube ? cleanName(youtubeArtist(raw)) : raw
    const key = name === undefined ? undefined : artistAffinityKey(name)
    if (name === undefined || key === undefined || seen.has(key)) continue
    seen.add(key)
    artists.push(name)
    if (artists.length === MAX_ARTISTS) break
  }
  if (artists.length === 0) return null
  const fullTitle = cleanName(track.title)
  const title =
    fullTitle !== undefined && track.kind === 'music-video'
      ? cleanName(videoTitle(fullTitle, artists))
      : fullTitle
  if (title === undefined) return null

  const result: ScrobbleTrack = { artists, title }
  const album = cleanName(track.album?.name)
  if (album !== undefined) result.album = album
  const durationMs = validLengthMs(track.durationMs)
  if (durationMs !== undefined) result.durationMs = Math.round(durationMs)
  const { trackNumber } = track
  if (typeof trackNumber === 'number' && Number.isSafeInteger(trackNumber) && trackNumber > 0) {
    result.trackNumber = trackNumber
  }
  const isrc = normalizeIsrc(track.isrc)
  if (isrc !== null) result.isrc = isrc
  const spotifyId =
    track.source === 'spotify' ? parseId(track.id)?.nativeId : track.externalIds?.spotify
  if (typeof spotifyId === 'string' && SPOTIFY_ID.test(spotifyId)) result.spotifyId = spotifyId
  return result
}

/**
 * The scrobble of a play that ended, or `null` when its track isn't scrobbled (see
 * {@link scrobbleTrackOf}) or its start is not a believable time. It doesn't check whether
 * the play was long enough: each service's rules decide (`qualifiesForScrobble`).
 *
 * The track's length is the one the player knew, else its metadata's. A play started from a
 * radio was chosen by FXM, not the user, so it says `chosenByUser: false`.
 */
export function scrobbleOf(play: ScrobblePlay): Scrobble | null {
  const track = scrobbleTrackOf(play.track)
  const { at } = play
  if (track === null || typeof at !== 'number' || !Number.isFinite(at)) return null
  if (at < MIN_SCROBBLE_TIME_MS) return null
  const lengthMs = playLengthMs(play)
  if (lengthMs !== undefined) track.durationMs = Math.round(lengthMs)
  const scrobble: Scrobble = { track, startedAt: Math.floor(at) }
  const { playedMs } = play
  if (typeof playedMs === 'number' && Number.isFinite(playedMs) && playedMs >= 0) {
    scrobble.playedMs = Math.round(playedMs)
  }
  if (play.context?.type === 'radio') scrobble.chosenByUser = false
  return scrobble
}

/** Whether `value` is a list of artist names as {@link scrobbleTrackOf} writes them. */
function isNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ARTISTS &&
    value.every((name) => cleanName(name) === name)
  )
}

/**
 * The scrobble in `value`, when it is one as FXM stores it, else `null`. Queues read scrobbles
 * back from storage, which an older version, another tab or a bad disk may have written, so
 * they keep only what passes: the required fields, and the optional ones that are valid.
 */
export function sanitizeScrobble(value: unknown): Scrobble | null {
  if (typeof value !== 'object' || value === null) return null
  const { track, startedAt, playedMs, chosenByUser } = value as Record<string, unknown>
  if (typeof track !== 'object' || track === null) return null
  const fields = track as Record<string, unknown>
  const title = cleanName(fields.title)
  if (!isNameList(fields.artists) || title === undefined || title !== fields.title) return null
  if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt)) return null
  if (startedAt < MIN_SCROBBLE_TIME_MS) return null
  const clean: ScrobbleTrack = { artists: [...fields.artists], title }
  const album = cleanName(fields.album)
  if (album !== undefined) clean.album = album
  const durationMs = validLengthMs(fields.durationMs)
  if (durationMs !== undefined) clean.durationMs = Math.round(durationMs)
  const { trackNumber, isrc, spotifyId } = fields
  if (typeof trackNumber === 'number' && Number.isSafeInteger(trackNumber) && trackNumber > 0) {
    clean.trackNumber = trackNumber
  }
  if (typeof isrc === 'string' && normalizeIsrc(isrc) === isrc) clean.isrc = isrc
  if (typeof spotifyId === 'string' && SPOTIFY_ID.test(spotifyId)) clean.spotifyId = spotifyId
  const scrobble: Scrobble = { track: clean, startedAt }
  if (typeof playedMs === 'number' && Number.isSafeInteger(playedMs) && playedMs >= 0) {
    scrobble.playedMs = playedMs
  }
  if (chosenByUser === false) scrobble.chosenByUser = false
  return scrobble
}
