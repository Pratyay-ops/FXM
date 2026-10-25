/**
 * The data model of the matching evaluation (stage 1.12): the labelled set is one JSON file per
 * recording ("group"), holding the inputs that describe it, the YouTube Music pages recorded for
 * them, and the labels of the candidates. See `README.md` in this folder.
 *
 * @module
 */

import type { AlbumType } from '../../model'
import { isIsrcOrigin, type MatchSource, type ReleaseFacts } from '../types'

/** Every {@link EvalCategory}, in the order the report lists them. */
export const EVAL_CATEGORIES = [
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
] as const

/**
 * What kind of track a case is, for the report's per-category tables. A case can be in several
 * (a Bollywood hit is `mainstream` and `regional`). Most come from the inputs (see
 * `inputCategories`); `cross-script` and `isrc-squatter` may also follow from the labels (see
 * `caseCategories`). `data-export` holds the data-export rows, and only them.
 */
export type EvalCategory = (typeof EVAL_CATEGORIES)[number]

/** Every {@link EvalSplit}. */
export const EVAL_SPLITS = ['held-out', 'calibration'] as const

/**
 * Which part of the set a group belongs to: thresholds are tuned on `calibration` only, and the
 * Auto gate reads `held-out` only. A group's split follows from its ID (see `splitOf`), so it
 * never moves.
 */
export type EvalSplit = (typeof EVAL_SPLITS)[number]

/** Every {@link EvalSlice}. */
export const EVAL_SLICES = [
  'spotify',
  'csv',
  'fixed',
  'data-export',
  'musicbrainz-exact',
  'musicbrainz-fuzzy',
] as const

/**
 * Where a case's input comes from, i.e. what the matcher is given:
 *
 * - `spotify`: Spotify's metadata through stage 1.5, with the ISRC, label and release date of
 *   `metadata/4` (titles keep Spotify's suffixes such as " - 2011 Remaster")
 * - `csv`: a row of an Exportify-style CSV the owner exported
 * - `fixed`: an input written down from earlier research (the known ISRC squatters)
 * - `data-export`: a row of Spotify's "Download your data" export: names and the track URI, no
 *   duration and no ISRC. It goes through the MusicBrainz exact path first, as imports do
 * - `musicbrainz-exact`: the recording MusicBrainz links to the Spotify track, with its own
 *   title, credits, length and ISRCs: an input that does not use Spotify's metadata
 * - `musicbrainz-fuzzy`: the track's names and length with the ISRC of a MusicBrainz recording
 *   search, which is only a hint
 */
export type EvalSlice = (typeof EVAL_SLICES)[number]

/** The slices whose cases count in the per-category tables (the others have a table of their own). */
export const PRIMARY_SLICES: readonly EvalSlice[] = ['spotify', 'csv', 'fixed']

/**
 * A YouTube Music search result as the labelled set stores it: what the matching engine reads
 * of a core `Track`, nothing more. `kind` follows `musicVideoType` (an `ATV` song is `song`).
 */
export interface EvalItem {
  /** `song`, `music-video`, `video` or `episode`. */
  kind: 'song' | 'music-video' | 'video' | 'episode'
  /** The title as YouTube Music shows it. */
  title: string
  /** The credited names, in order. */
  artists: string[]
  /** The album's name. */
  album?: string
  /** The album's browse ID (`MPREb_…`). */
  albumId?: string
  /** The duration in milliseconds (whole seconds, as YouTube shows it). */
  durationMs?: number
  /** Present, and `true`, only for songs with the explicit badge. */
  explicit?: true
  /** The release date the result shows (often a year only). */
  releaseDate?: string
  /** For an official video that links its song: the song's videoId. */
  songId?: string
  /** `yt` for a regular YouTube result; `ytm` when absent. */
  source?: 'yt'
}

/**
 * One recorded page, filed under its key (see `pageKeys`):
 *
 * - a search (`isrc-songs/…`, `songs/…`, `videos/…`, `youtube/…`): the videoIds of its items in
 *   page order, each described in {@link EvalRecording.items}
 * - a top-result card (`isrc-top-card/…`): the card's videoId, or `null` when the page had none
 *   (or its card was not a track)
 * - a description (`description/<videoId>`): what it says about the release, and the lines
 *   YouTube generates for label uploads, for people
 * - a page that could not be read for good (`error`): the replay treats it as skipped
 */
export type EvalPage =
  | { items: string[] }
  | { item: string | null }
  | { facts: ReleaseFacts; excerpt?: string }
  | { error: string }

/** The pages recorded for one group, shared by all of its inputs. */
export interface EvalRecording {
  /** When the group's pages were recorded (UTC dates, first and last). */
  recordedAt: string[]
  /** Every item the pages list, by videoId. */
  items: Record<string, EvalItem>
  /** The pages, by key. */
  pages: Record<string, EvalPage>
}

/**
 * What a candidate is for the group's recording:
 *
 * - `exact`: the same recording, on any release (a remaster or a compilation included)
 * - `equivalent`: the same audio in another form, e.g. an official upload of it
 * - `wrong`: another recording, version, edit, master (explicit or clean), song or artist
 */
export type EvalLabel = 'exact' | 'equivalent' | 'wrong'

/** Every {@link EvalLabel}. */
export const EVAL_LABELS = ['exact', 'equivalent', 'wrong'] as const satisfies readonly EvalLabel[]

/** Who decided a label: the drafting rules, an agent, or the owner. */
export type EvalLabelAuthor = 'rule' | 'agent' | 'owner'

/** One candidate's label, with why. */
export interface EvalLabelEntry {
  /** The label. */
  label: EvalLabel
  /** Who decided it. */
  by: EvalLabelAuthor
  /** Why, for people: the facts the label rests on. */
  evidence: string[]
  /**
   * Set when the rules could not decide: the label is a draft that the owner reviews (see
   * `REVIEW.csv`). It stays set after the review, which `by: 'owner'` records.
   */
  ambiguous?: true
  /** When the owner reviewed it (a date), for an ambiguous label or a spot check. */
  reviewed?: string
}

/** What the MusicBrainz exact path found for the group's Spotify track. */
export interface EvalMusicBrainzExact {
  /** The recording's MBID. */
  recording: string
  /** Its title. */
  title: string
  /** Its credited names. */
  artists: string[]
  /** Its length in milliseconds. */
  lengthMs?: number
  /** Its ISRCs, canonical. */
  isrcs: string[]
  /** The date of its first release. */
  firstReleaseDate?: string
}

/** What the MusicBrainz fuzzy path (a recording search) found. */
export interface EvalMusicBrainzFuzzy {
  /** The recording's MBID. */
  recording: string
  /** Its ISRCs, canonical. */
  isrcs: string[]
}

/** The input of one case: a slice and what the matcher is given. */
export interface EvalVariant {
  /** Where the input comes from. */
  slice: EvalSlice
  /** What the matcher is given. */
  source: MatchSource
}

/** One recording to find, with its inputs, its recorded pages and its labels. */
export interface EvalGroup {
  /** `sp:<Spotify ID>` for a Spotify track, `fx:<name>` for a fixed input, `csv:<…>` for a row. */
  id: string
  /** Its split, from the ID (`splitOf`). */
  split: EvalSplit
  /** The categories its inputs fall in (see {@link EvalCategory}). */
  categories: EvalCategory[]
  /** Where the inputs come from and when they were read. */
  provenance: string[]
  /** Spotify's facts beyond the input (popularity and album type from `metadata/4`). */
  spotify?: { id: string; popularity?: number; albumType?: AlbumType }
  /**
   * What MusicBrainz found: for `exact` and `fuzzy` alike, `null` when the path was run and found
   * nothing usable, absent when it was not run.
   */
  musicBrainz?: { exact?: EvalMusicBrainzExact | null; fuzzy?: EvalMusicBrainzFuzzy | null }
  /** The inputs, one per slice. */
  variants: EvalVariant[]
  /** The recorded pages, once recorded. */
  recording?: EvalRecording
  /** The candidates' labels, by videoId. */
  labels?: Record<string, EvalLabelEntry>
}

/** One case of the report: a group's input of one slice. */
export interface EvalCase {
  /** `<group id>/<slice>`. */
  id: string
  /** The group. */
  group: EvalGroup
  /** The input. */
  variant: EvalVariant
}

/** The cases of groups: one per input. */
export function casesOf(groups: readonly EvalGroup[]): EvalCase[] {
  return groups.flatMap((group) =>
    group.variants.map((variant) => ({ id: `${group.id}/${variant.slice}`, group, variant })),
  )
}

// --- Reading the fixtures ------------------------------------------------------------------

/** A malformed fixture, named by its group and the path of the bad value. */
export class EvalFixtureError extends Error {
  override readonly name = 'EvalFixtureError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** A whole number of milliseconds above 0. */
function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const ITEM_KINDS = ['song', 'music-video', 'video', 'episode'] as const

/** The problems of an item, as paths; empty when it is well formed. */
function itemProblems(item: unknown, path: string): string[] {
  if (!isRecord(item)) return [path]
  const problems: string[] = []
  if (!isOneOf(ITEM_KINDS, item.kind)) problems.push(`${path}.kind`)
  if (typeof item.title !== 'string') problems.push(`${path}.title`)
  if (!isStringArray(item.artists)) problems.push(`${path}.artists`)
  for (const key of ['album', 'albumId', 'releaseDate', 'songId'] as const) {
    if (item[key] !== undefined && typeof item[key] !== 'string') problems.push(`${path}.${key}`)
  }
  if (item.durationMs !== undefined && !isDuration(item.durationMs)) {
    problems.push(`${path}.durationMs`)
  }
  if (item.explicit !== undefined && item.explicit !== true) problems.push(`${path}.explicit`)
  if (item.source !== undefined && item.source !== 'yt') problems.push(`${path}.source`)
  return problems
}

/** The problems of a page, as paths. */
function pageProblems(page: unknown, path: string, items: Record<string, unknown>): string[] {
  if (!isRecord(page)) return [path]
  if ('items' in page) {
    if (!isStringArray(page.items)) return [`${path}.items`]
    return page.items.filter((id) => !(id in items)).map((id) => `${path}.items: ${id}`)
  }
  if ('item' in page) {
    if (page.item === null) return []
    return typeof page.item === 'string' && page.item in items ? [] : [`${path}.item`]
  }
  if ('facts' in page) return isRecord(page.facts) ? [] : [`${path}.facts`]
  if ('error' in page) return typeof page.error === 'string' ? [] : [`${path}.error`]
  return [path]
}

/** The problems of a match source, as paths. */
function sourceProblems(source: unknown, path: string): string[] {
  if (!isRecord(source)) return [path]
  const problems: string[] = []
  if (typeof source.title !== 'string' || source.title.trim() === '') problems.push(`${path}.title`)
  if (
    !Array.isArray(source.artists) ||
    !source.artists.every((artist) => isRecord(artist) && typeof artist.name === 'string')
  ) {
    problems.push(`${path}.artists`)
  }
  if (
    source.album !== undefined &&
    !(isRecord(source.album) && typeof source.album.name === 'string')
  ) {
    problems.push(`${path}.album`)
  }
  if (source.durationMs !== undefined && !isDuration(source.durationMs)) {
    problems.push(`${path}.durationMs`)
  }
  for (const key of ['isrc', 'releaseDate', 'label', 'albumType'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'string')
      problems.push(`${path}.${key}`)
  }
  if (source.isrcOrigin !== undefined && !isIsrcOrigin(source.isrcOrigin)) {
    problems.push(`${path}.isrcOrigin`)
  }
  if (source.explicit !== undefined && typeof source.explicit !== 'boolean') {
    problems.push(`${path}.explicit`)
  }
  return problems
}

/** The problems of a label entry, as paths. */
function labelProblems(entry: unknown, path: string): string[] {
  if (!isRecord(entry)) return [path]
  const problems: string[] = []
  if (!isOneOf(EVAL_LABELS, entry.label)) problems.push(`${path}.label`)
  if (!isOneOf(['rule', 'agent', 'owner'] as const, entry.by)) problems.push(`${path}.by`)
  if (!isStringArray(entry.evidence)) problems.push(`${path}.evidence`)
  if (entry.ambiguous !== undefined && entry.ambiguous !== true) problems.push(`${path}.ambiguous`)
  if (entry.reviewed !== undefined && typeof entry.reviewed !== 'string') {
    problems.push(`${path}.reviewed`)
  }
  return problems
}

/**
 * Checks a group read from a fixture file and returns it typed. Fixtures are written by the
 * recorder and edited by people (labels), so every field is checked: a typo must fail the
 * offline replay rather than skew the report.
 *
 * @throws EvalFixtureError naming every malformed field.
 */
export function parseEvalGroup(value: unknown): EvalGroup {
  if (!isRecord(value)) throw new EvalFixtureError('A group must be a JSON object')
  const id = typeof value.id === 'string' ? value.id : '?'
  const problems: string[] = []
  if (!/^(?:sp|fx|csv):[\w.-]+$/u.test(id)) problems.push('id')
  if (!isOneOf(EVAL_SPLITS, value.split)) problems.push('split')
  if (
    !Array.isArray(value.categories) ||
    !value.categories.every((category) => isOneOf(EVAL_CATEGORIES, category))
  ) {
    problems.push('categories')
  }
  if (!isStringArray(value.provenance) || value.provenance.length === 0) problems.push('provenance')
  if (!Array.isArray(value.variants) || value.variants.length === 0) {
    problems.push('variants')
  } else {
    const slices = new Set<unknown>()
    value.variants.forEach((variant, index) => {
      const path = `variants[${index}]`
      if (!isRecord(variant) || !isOneOf(EVAL_SLICES, variant.slice)) {
        problems.push(`${path}.slice`)
        return
      }
      if (slices.has(variant.slice)) problems.push(`${path}.slice (twice)`)
      slices.add(variant.slice)
      problems.push(...sourceProblems(variant.source, `${path}.source`))
    })
  }
  if (value.recording !== undefined) {
    const recording = value.recording
    if (
      !isRecord(recording) ||
      !isStringArray(recording.recordedAt) ||
      !isRecord(recording.items) ||
      !isRecord(recording.pages)
    ) {
      problems.push('recording')
    } else {
      const items = recording.items
      for (const [videoId, item] of Object.entries(items)) {
        problems.push(...itemProblems(item, `recording.items.${videoId}`))
      }
      for (const [key, page] of Object.entries(recording.pages)) {
        problems.push(...pageProblems(page, `recording.pages.${key}`, items))
      }
    }
  }
  if (value.labels !== undefined) {
    if (!isRecord(value.labels)) problems.push('labels')
    else {
      for (const [videoId, entry] of Object.entries(value.labels)) {
        problems.push(...labelProblems(entry, `labels.${videoId}`))
      }
    }
  }
  if (problems.length > 0) {
    throw new EvalFixtureError(`Group ${id} is malformed at ${problems.join(', ')}`)
  }
  return value as unknown as EvalGroup
}
