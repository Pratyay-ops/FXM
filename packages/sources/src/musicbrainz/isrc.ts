/**
 * Two ways to find a track's ISRC in MusicBrainz, which differ in what the matching engine may
 * do with the result (ARCHITECTURE.md §12, "Get the ISRC"):
 *
 * - **Exact** ({@link findExactIsrc}): MusicBrainz links the Spotify track's URL to a recording
 *   (`/ws/2/url?resource=…&inc=recording-rels`), whose ISRCs and length FXM then reads. Someone
 *   tied that URL to that recording by hand, so a hit counts as an ISRC-verified input.
 * - **Fuzzy** ({@link findIsrcHint}): a recording search by title and artist within a duration
 *   window, preferring the recording on the most releases. MusicBrainz ranks many same-titled
 *   recordings at score 100, live, compilation and soundtrack versions often first, so this is
 *   only a hint for ranking candidates and never makes a match play without asking.
 *
 * `MusicBrainzClient.lookupIsrc` goes the other way: the recordings that carry a known ISRC.
 *
 * @module
 */

import {
  extractVersionTags,
  normalizeText,
  type ProviderContext,
  splitTitle,
  stripPresentationNoise,
  type Track,
} from '@fxm/core'
import { wordsOf } from '../shared/audio-source'
import type { MusicBrainzClient, MusicBrainzRecording, MusicBrainzSearchHit } from './api'

/** An ISRC lookup's outcome. */
export interface IsrcFinding {
  /**
   * How the recording was found:
   *
   * - `exact`: through the Spotify track's URL relationship. The matching engine may treat the
   *   ISRC as the track's own: an ISRC-verified input
   * - `hint`: through a fuzzy recording search. Only a ranking hint: it never makes a match
   *   play without asking, and it must not be stored as the track's ISRC
   */
  kind: 'exact' | 'hint'
  /**
   * The recording's ISRCs in canonical form, usually one. Empty when MusicBrainz has none; the
   * recording's length is still useful then, e.g. for a data-export row without a duration.
   * A recording can carry several ISRCs (different masterings or releases), and nothing says
   * which one Spotify uses, so check each.
   */
  isrcs: string[]
  /** The recording, with its length and artist credit. */
  recording: MusicBrainzRecording
}

/** A Spotify track ID: 22 base62 characters. */
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/u

/**
 * A Spotify track's URL as MusicBrainz stores it, `https://open.spotify.com/track/<id>`, from
 * any of the ways FXM meets one: the bare ID, a `spotify:track:<id>` URI (which is also FXM's
 * `EntityId` for it), or an open.spotify.com or play.spotify.com URL, with or without a locale
 * segment (`/intl-de/`), query or fragment. `null` for anything else.
 */
export function spotifyTrackUrl(reference: string): string | null {
  const value = reference.trim()
  let id: string | undefined
  if (SPOTIFY_ID.test(value)) id = value
  else if (value.startsWith('spotify:track:')) id = value.slice('spotify:track:'.length)
  else {
    const match = value.match(
      /^(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([^/?#]+)/iu,
    )
    id = match?.[1]
  }
  return id !== undefined && SPOTIFY_ID.test(id) ? `https://open.spotify.com/track/${id}` : null
}

/** The URL for `reference`, or a `RangeError`. */
function requireSpotifyUrl(reference: string): string {
  const url = spotifyTrackUrl(reference)
  if (url === null) throw new RangeError(`Not a Spotify track: ${reference}`)
  return url
}

/**
 * The exact path: the recording that MusicBrainz links to a Spotify track, with its ISRCs and
 * length, as an ISRC-verified input (`kind: 'exact'`). `null` when MusicBrainz links no
 * recording to it, or more than one, which leaves the ISRC unsure. Two requests, so about two
 * seconds in the shared queue.
 *
 * @param reference The Spotify track: an ID, URI or URL (see {@link spotifyTrackUrl}).
 * @throws RangeError when `reference` is not a Spotify track.
 */
export async function findExactIsrc(
  client: MusicBrainzClient,
  reference: string,
  ctx: ProviderContext,
): Promise<IsrcFinding | null> {
  const recordings = await client.lookupUrl(requireSpotifyUrl(reference), ctx)
  const [only] = recordings
  if (only === undefined || recordings.length > 1) return null
  const recording = await client.getRecording(only.id, ctx)
  return { kind: 'exact', isrcs: recording.isrcs, recording }
}

/**
 * {@link findExactIsrc} for many Spotify tracks, e.g. a playlist import: one request per 100
 * URLs plus one per 50 recordings, instead of two per track. The map is keyed by each
 * reference as given and holds only the tracks with exactly one linked recording.
 *
 * @throws RangeError when a reference is not a Spotify track.
 */
export async function findExactIsrcs(
  client: MusicBrainzClient,
  references: readonly string[],
  ctx: ProviderContext,
): Promise<Map<string, IsrcFinding>> {
  const urlOf = new Map(references.map((reference) => [reference, requireSpotifyUrl(reference)]))
  const linked = await client.lookupUrls([...urlOf.values()], ctx)
  const recordingOf = new Map<string, string>()
  for (const [url, recordings] of linked) {
    const [only] = recordings
    if (only !== undefined && recordings.length === 1) recordingOf.set(url, only.id)
  }
  const recordings = await client.getRecordings([...new Set(recordingOf.values())], ctx)
  const findings = new Map<string, IsrcFinding>()
  for (const [reference, url] of urlOf) {
    const id = recordingOf.get(url)
    const recording = id === undefined ? undefined : recordings.get(id)
    if (recording !== undefined) {
      findings.set(reference, { kind: 'exact', isrcs: recording.isrcs, recording })
    }
  }
  return findings
}

/** The strong version tags of a title's qualifiers and a disambiguation comment, sorted. */
function strongTags(qualifiers: readonly string[], disambiguation = ''): string[] {
  return [...new Set(extractVersionTags([...qualifiers, disambiguation].join(' ')).strong)].sort()
}

/** The duration window of the fuzzy path: max(10 s, 5 %). */
function windowFor(durationMs: number): number {
  return Math.max(10_000, durationMs * 0.05)
}

/**
 * The fuzzy path: a recording search by the track's title (without version qualifiers) and main
 * artist, within max(10 s, 5 %) of its duration when it has one. Of the recordings whose title
 * and artist fit and whose strong version tags (live, remix, acoustic…, also read from their
 * disambiguation) are the track's, it picks the one on the most releases, then the closest in
 * length, then the best score. That is the canonical recording far more often than
 * MusicBrainz's own first hit, but still only a hint (`kind: 'hint'`). `null` when nothing fits.
 * One request.
 */
export async function findIsrcHint(
  client: MusicBrainzClient,
  track: Pick<Track, 'title' | 'artists' | 'durationMs'>,
  ctx: ProviderContext,
): Promise<IsrcFinding | null> {
  const { core, qualifiers } = splitTitle(stripPresentationNoise(track.title))
  const artist = track.artists[0]?.name.trim() ?? ''
  if (core.trim() === '' || artist === '') return null
  const { durationMs } = track
  const hits = await client.searchRecordings(
    { title: core, artist, ...(durationMs === undefined ? {} : { durationMs }) },
    ctx,
  )
  const wantedTitle = normalizeText(core)
  const wantedArtist = wordsOf(artist)
  const wantedTags = strongTags(qualifiers).join()
  const offBy = (hit: MusicBrainzSearchHit) =>
    durationMs === undefined || hit.lengthMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(hit.lengthMs - durationMs)
  const fitting = hits.filter((hit) => {
    const parts = splitTitle(hit.title)
    const credit = wordsOf(hit.artists.join(' '))
    return (
      normalizeText(parts.core) === wantedTitle &&
      wantedArtist.every((word) => credit.includes(word)) &&
      strongTags(parts.qualifiers, hit.disambiguation).join() === wantedTags &&
      (durationMs === undefined ||
        hit.lengthMs === undefined ||
        offBy(hit) <= windowFor(durationMs))
    )
  })
  const [best] = fitting.sort(
    (a, b) =>
      b.releases.length - a.releases.length ||
      offBy(a) - offBy(b) ||
      b.score - a.score ||
      a.id.localeCompare(b.id),
  )
  if (best === undefined) return null
  const { score: _score, releases: _releases, ...recording } = best
  return { kind: 'hint', isrcs: recording.isrcs, recording }
}
