/**
 * The keys the affinity scores tracks, artists and tags under, and {@link artistKey}, the one
 * artist key every part of FXM compares artists with.
 *
 * Each key function is idempotent: given a key it made, it gives the same key back. So a reader
 * can take either a name or a key and key it itself.
 *
 * @module
 */

import { type EntityId, entityKey } from '../ids'
import { normalizeText } from '../text'

/** Longest artist key kept; longer names are noise from bad data. */
const MAX_ARTIST_KEY_LENGTH = 200

/** Longest tag key kept. */
const MAX_TAG_KEY_LENGTH = 64

/** Artist credits that say nothing about who made a track, as {@link artistKey}s. */
const NO_ARTIST: ReadonlySet<string> = new Set([
  'various artists',
  'various artist',
  'various',
  'va',
  'v a',
  'unknown artist',
  'unknown',
])

/** Bracketed parts of a name: "(Official)", "[JP]", "（公式）". */
const NAME_BRACKETS = /\s*(?:\([^)]*\)|\[[^\]]*\]|（[^）]*）)\s*/gu
/** The word "official" anywhere in a channel name: "Taylor Swift Official". */
const OFFICIAL = /(?<![\p{L}\p{N}])official(?![\p{L}\p{N}])/gu
/** YouTube's automatic artist channels: "Radiohead - Topic". */
const TOPIC = /\s*-\s*topic$/u
/** VEVO channels: "RadioheadVEVO", "Radiohead VEVO". */
const VEVO = /(?<=\S)(?:\s*vevo)+$/u

/**
 * Text reduced for comparison: `&` read as "and", apostrophes and dots dropped, and every other
 * run of punctuation, symbols and spaces made one space.
 */
function comparable(text: string): string {
  return text
    .replace(/&/gu, ' and ')
    .replace(/['.]/gu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
}

/** One pass of {@link artistKey}. */
function artistKeyOnce(name: string): string {
  const base = normalizeText(name)
  const bare = base
    .replace(NAME_BRACKETS, ' ')
    .replace(OFFICIAL, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(TOPIC, '')
    .replace(VEVO, '')
  return comparable(bare) || comparable(base) || base
}

/**
 * The key that names one artist wherever it comes from: the name as `normalizeText` compares
 * it, without bracketed parts and without YouTube's channel decorations (" - Topic", "VEVO",
 * "Official"), with `&` read as "and" and without punctuation. "Radiohead", "RADIOHEAD",
 * "Radiohead - Topic" and "RadioheadVEVO" are one artist, and so are "Simon & Garfunkel" and
 * "Simon and Garfunkel" or "Beyoncé" and "Beyonce". A name that would lose everything keeps
 * what it can: "VEVO" stays "vevo", "!!!" stays "!!!". Empty for an empty name.
 *
 * The rules are the matching engine's `cleanArtistName` followed by the recommendation
 * sources' comparison, so recommendations, matching and the listening affinity agree on who an
 * artist is. Two artists with the same name share a key, which recommendations can live with.
 */
export function artistKey(name: string): string {
  if (typeof name !== 'string') return ''
  let key = artistKeyOnce(name)
  // A second pass changes a key only when stripping exposed another decoration
  // ("X VEVO VEVO!"), so the result is stable after a few.
  for (let pass = 0; pass < 4; pass++) {
    const next = artistKeyOnce(key)
    if (next === key) break
    key = next
  }
  return key
}

/**
 * The key of an artist's affinity: its {@link artistKey}, so one artist across sources, and in
 * an imported history that has no IDs, is one entry.
 *
 * `undefined` for a name that is empty, absurdly long, or a placeholder such as "Various
 * Artists" or "Unknown Artist", which never gets an affinity.
 */
export function artistAffinityKey(name: string): string | undefined {
  const key = artistKey(name)
  if (key === '' || key.length > MAX_ARTIST_KEY_LENGTH || NO_ARTIST.has(key)) return undefined
  return key
}

/**
 * The key of a tag's affinity: normalized like a name (`normalizeText`), with runs of spaces,
 * hyphens, underscores and slashes made one space, so "Hip-Hop", "hip hop" and "HIP_HOP" share
 * an entry. `undefined` for an empty tag or one longer than 64 characters.
 */
export function tagAffinityKey(tag: string): string | undefined {
  if (typeof tag !== 'string') return undefined
  const key = normalizeText(tag)
    .replace(/[\s_\-/]+/gu, ' ')
    .trim()
  return key === '' || key.length > MAX_TAG_KEY_LENGTH ? undefined : key
}

/**
 * The key of a track's affinity: its `entityKey`, so a video's `ytm` and `yt` IDs share an
 * entry. A key gives itself back. `undefined` for a value that is empty or not a string.
 */
export function trackAffinityKey(id: string): string | undefined {
  if (typeof id !== 'string' || id === '') return undefined
  return entityKey(id as EntityId)
}
