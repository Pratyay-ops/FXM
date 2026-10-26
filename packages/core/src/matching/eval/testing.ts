/**
 * Test helpers: small labelled groups, built in code, for the evaluation's unit tests. Only
 * tests import this module.
 *
 * @module
 */

import type { MatchSource } from '../types'
import type {
  EvalCategory,
  EvalGroup,
  EvalItem,
  EvalLabelEntry,
  EvalPage,
  EvalSplit,
  EvalVariant,
} from './types'

/** A song item: `item('Song', 'Artist', 200, { album: 'LP' })`. */
export function item(
  title: string,
  artist: string | string[],
  seconds: number,
  extra: Partial<EvalItem> = {},
): EvalItem {
  return {
    kind: 'song',
    title,
    artists: typeof artist === 'string' ? [artist] : artist,
    durationMs: seconds * 1000,
    ...extra,
  }
}

/** A match source: `source('Song', 'Artist', 200, { isrc: '…' })`. */
export function source(
  title: string,
  artist: string,
  seconds: number | undefined,
  extra: Partial<MatchSource> = {},
): MatchSource {
  return {
    title,
    artists: [{ name: artist }],
    ...(seconds === undefined ? {} : { durationMs: seconds * 1000 }),
    ...extra,
  }
}

/** What {@link group} builds a group from. */
export interface GroupSpec {
  id?: string
  split?: EvalSplit
  categories?: EvalCategory[]
  variants: EvalVariant[]
  items?: Record<string, EvalItem>
  pages?: Record<string, EvalPage>
  labels?: Record<string, EvalLabelEntry>
  spotify?: EvalGroup['spotify']
  musicBrainz?: EvalGroup['musicBrainz']
}

/** A group with a recording made of `items` and `pages`. */
export function group(spec: GroupSpec): EvalGroup {
  const result: EvalGroup = {
    id: spec.id ?? 'sp:test',
    split: spec.split ?? 'held-out',
    categories: spec.categories ?? ['mainstream'],
    provenance: ['built in a test'],
    variants: spec.variants,
    recording: { recordedAt: ['2026-10-26'], items: spec.items ?? {}, pages: spec.pages ?? {} },
  }
  if (spec.labels !== undefined) result.labels = spec.labels
  if (spec.spotify !== undefined) result.spotify = spec.spotify
  if (spec.musicBrainz !== undefined) result.musicBrainz = spec.musicBrainz
  return result
}

/** A rule's label. */
export function label(
  value: EvalLabelEntry['label'],
  extra: Partial<EvalLabelEntry> = {},
): EvalLabelEntry {
  return { label: value, by: 'rule', evidence: ['test'], ...extra }
}
