/**
 * The keys the affinity scores artists and tags under. Tracks use `entityKey`, so a song's
 * `ytm` and `yt` IDs share one entry.
 *
 * @module
 */

import { normalizeText } from '../text'

/** Longest artist key kept; longer names are noise from bad data. */
const MAX_ARTIST_KEY_LENGTH = 200

/** Longest tag key kept. */
const MAX_TAG_KEY_LENGTH = 64

/** Artist credits that say nothing about who made a track, as normalized keys. */
const NO_ARTIST: ReadonlySet<string> = new Set([
  'various artists',
  'unknown artist',
  'unknown',
  '[unknown]',
  '<unknown>',
])

/**
 * The key of an artist's affinity: the name as `normalizeText` compares it, so "Beyoncé" and
 * "BEYONCE" share an entry, and so does one artist across sources (a YouTube Music artist and
 * the same name in an imported history, which has no IDs). Two artists with the same name share
 * one too, which recommendations can live with.
 *
 * `undefined` for a name that is empty, absurdly long, or a placeholder such as "Various
 * Artists" or "Unknown Artist", which never gets an affinity.
 */
export function artistAffinityKey(name: string): string | undefined {
  if (typeof name !== 'string') return undefined
  const key = normalizeText(name)
  if (key === '' || key.length > MAX_ARTIST_KEY_LENGTH || NO_ARTIST.has(key)) return undefined
  return key
}

/**
 * The key of a tag's affinity: normalized like an artist name, with runs of spaces, hyphens,
 * underscores and slashes made one space, so "Hip-Hop", "hip hop" and "HIP_HOP" share an
 * entry. `undefined` for an empty tag or one longer than 64 characters.
 */
export function tagAffinityKey(tag: string): string | undefined {
  if (typeof tag !== 'string') return undefined
  const key = normalizeText(tag)
    .replace(/[\s_\-/]+/gu, ' ')
    .trim()
  return key === '' || key.length > MAX_TAG_KEY_LENGTH ? undefined : key
}
