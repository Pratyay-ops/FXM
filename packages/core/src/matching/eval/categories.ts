/**
 * Which split a group falls in, and which categories a case counts in. Categories come from the
 * inputs (popularity, album type, title words, the source the input was drawn from), except
 * `cross-script`, which comes from the labels: it describes how YouTube Music titles the
 * recording, which the inputs cannot tell. The matcher's own decisions never decide a category.
 *
 * @module
 */

import type { AlbumType } from '../../model'
import { isClassicalTitle } from '../prepare'
import { isGenericAlbum } from '../release'
import { inDifferentScripts, scriptsOf } from '../similarity'
import { type EvalCase, type EvalCategory, type EvalSplit, PRIMARY_SLICES } from './types'

/** The share of groups, in percent, that go to the calibration split. */
export const CALIBRATION_PERCENT = 30

/** FNV-1a over UTF-16 code units, 32 bits: a stable hash, the same on every platform and run. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * The split of a group, from its ID alone: about {@link CALIBRATION_PERCENT} % of groups are
 * `calibration`, the rest `held-out`. The ID never changes, so neither does the split, and no
 * one can move a group after seeing how the matcher does on it.
 */
export function splitOf(groupId: string): EvalSplit {
  return stableHash(groupId) % 100 < CALIBRATION_PERCENT ? 'calibration' : 'held-out'
}

/** What {@link categoriesOfInput} reads. */
export interface InputFacts {
  /** The title as the source shows it. */
  title: string
  /** The credited names. */
  artists: readonly string[]
  /** The album's name. */
  album?: string
  /** The album's release type (`metadata/4`). */
  albumType?: AlbumType
  /** Spotify's popularity, 0 to 100. */
  popularity?: number
  /**
   * Categories the input source was chosen for, e.g. `regional` for a national chart or
   * `classical` for a classical playlist. Only `regional`, `classical`, `re-recording`,
   * `long-tail` and `isrc-squatter` are taken from here as they are; the others need the facts.
   */
  sourceCategories?: readonly EvalCategory[]
}

/** Spotify's popularity from which a track counts as mainstream. */
export const MAINSTREAM_POPULARITY = 50

/** Spotify's popularity up to which a track counts as long-tail. */
export const LONG_TAIL_POPULARITY = 30

const RE_RECORDING =
  /taylor['’]s version|re-?recorded|\bre-?record(?:ing)?\b|\(\d{4} version\)|\bforgery\b|\(new version\)|\bnew recording\b/iu

const SPOTIFY_SINGLES = /\bspotify singles?\b|recorded at spotify studios|\bspotify sessions?\b/iu

/** Whether a text has letters of a script other than Latin. */
function hasNonLatin(text: string): boolean {
  return [...scriptsOf(text)].some((script) => script !== 'latin')
}

/**
 * The categories an input falls in, from its facts:
 *
 * - `classical`: a classical-looking title (the matcher's own test), or a classical source
 * - `spotify-singles`: Spotify's own recordings ("Spotify Singles", "Recorded at Spotify Studios")
 * - `re-recording`: "Taylor's Version", "Re-Recorded", "(2009 Version)" and the like in the title
 *   or the album, or a source of re-recordings
 * - `compilation`: Spotify lists the release as a compilation, or names it like one ("Greatest
 *   Hits", "The Very Best of …")
 * - `long-tail`: popularity of {@link LONG_TAIL_POPULARITY} or less, or a long-tail source
 * - `mainstream`: popularity of {@link MAINSTREAM_POPULARITY} or more, unless classical or a
 *   Spotify Single
 * - `regional`: a national chart or regional source, or a title or main artist in a non-Latin
 *   script
 * - `isrc-squatter`: the known squatter inputs, whose ISRC another catalogue gives to another
 *   recording
 *
 * Never `cross-script`: a title in a non-Latin script says nothing about how YouTube Music
 * titles the recording, so that category follows from the labels (see {@link caseCategories}).
 */
export function categoriesOfInput(facts: InputFacts): EvalCategory[] {
  const from = new Set(facts.sourceCategories ?? [])
  const found = new Set<EvalCategory>()
  const text = [facts.title, facts.album ?? ''].join(' ')
  const mainArtist = facts.artists[0] ?? ''
  const classical = isClassicalTitle(facts.title) || from.has('classical')
  const singles = SPOTIFY_SINGLES.test(text)
  if (classical) found.add('classical')
  if (singles) found.add('spotify-singles')
  if (RE_RECORDING.test(text) || from.has('re-recording')) found.add('re-recording')
  if (
    facts.albumType === 'compilation' ||
    (facts.album !== undefined && isGenericAlbum(facts.album))
  ) {
    found.add('compilation')
  }
  const popularity = facts.popularity
  if ((popularity !== undefined && popularity <= LONG_TAIL_POPULARITY) || from.has('long-tail')) {
    found.add('long-tail')
  }
  if (popularity !== undefined && popularity >= MAINSTREAM_POPULARITY && !classical && !singles) {
    found.add('mainstream')
  }
  if (from.has('regional') || hasNonLatin(facts.title) || hasNonLatin(mainArtist)) {
    found.add('regional')
  }
  if (from.has('isrc-squatter')) found.add('isrc-squatter')
  // A track can't be both: popularity decides, and a long-tail source alone yields to it.
  if (found.has('mainstream')) found.delete('long-tail')
  return [...found].sort((a, b) => order(a) - order(b))
}

const ORDER: readonly EvalCategory[] = [
  'mainstream',
  'long-tail',
  'regional',
  'cross-script',
  'classical',
  're-recording',
  'compilation',
  'spotify-singles',
  'isrc-squatter',
  'data-export',
]

function order(category: EvalCategory): number {
  return ORDER.indexOf(category)
}

/** The videoIds a group's labels mark as the recording (`exact` or `equivalent`). */
function rightVideos(evalCase: EvalCase): string[] {
  return Object.entries(evalCase.group.labels ?? {})
    .filter(([, entry]) => entry.label === 'exact' || entry.label === 'equivalent')
    .map(([videoId]) => videoId)
}

/**
 * The categories a case counts in:
 *
 * - inputs of the primary slices (`spotify`, `csv`, `fixed`): the group's categories, plus
 *   `cross-script` when YouTube Music titles the recording (an item labelled `exact` or
 *   `equivalent`) in another script than the input ("Idol" and "アイドル")
 * - data-export rows: `data-export` only, so their no-duration matches never mix with the
 *   mainstream rate
 * - MusicBrainz inputs: none; the report has a table per slice for them
 */
export function caseCategories(evalCase: EvalCase): EvalCategory[] {
  const { group, variant } = evalCase
  if (variant.slice === 'data-export') return ['data-export']
  if (!PRIMARY_SLICES.includes(variant.slice)) return []
  const found = new Set(group.categories)
  const items = group.recording?.items ?? {}
  for (const videoId of rightVideos(evalCase)) {
    const item = items[videoId]
    if (item !== undefined && inDifferentScripts(variant.source.title, item.title)) {
      found.add('cross-script')
    }
  }
  return [...found].sort((a, b) => order(a) - order(b))
}
