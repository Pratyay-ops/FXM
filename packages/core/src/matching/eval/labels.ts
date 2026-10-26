/**
 * Drafting the labels and the owner's review checklist. The rules decide a label only on
 * evidence that does not come from the matcher's score: an ISRC search hit, a description
 * whose ℗ label or release year agrees with the input's, or the input's own album. A candidate
 * that only looks right (same title, artist and length) is `ambiguous`: its label is a draft, and
 * the owner reviews it (`REVIEW.csv`).
 *
 * @module
 */

import { normalizeIsrc } from '../../ids'
import { isrcTrust } from '../isrc'
import {
  albumMatchLevel,
  compareLabels,
  compareYears,
  isGenericAlbum,
  isSameRelease,
  yearOf,
} from '../release'
import { prepareSource, scoreCandidate, sourceSide, trackSide } from '../score'
import { inDifferentScripts } from '../similarity'
import type { MatchOptions, MatchSource } from '../types'
import { stableHash } from './categories'
import {
  decodeItem,
  pageKeys,
  parsePageKey,
  RECORDING_OPTIONS,
  recordedFacts,
  withoutIsrcCap,
} from './recording'
import { replayMatch } from './replay'
import { type EvalGroup, type EvalLabel, type EvalLabelEntry, PRIMARY_SLICES } from './types'

/** A label the rules drafted. */
export type DraftLabel = EvalLabelEntry & { by: 'rule' }

/** At most this many seconds apart, a candidate can be the same recording. */
const SAME_LENGTH_MS = 3000

/** More than this many seconds apart, a candidate is another edit or recording. */
const OTHER_EDIT_MS = 10_000

/** The input the labels are about: the group's primary input (Spotify, a CSV row, a fixed one). */
export function referenceSource(group: EvalGroup): MatchSource | undefined {
  const primary = group.variants.find((variant) => PRIMARY_SLICES.includes(variant.slice))
  return (primary ?? group.variants[0])?.source
}

/**
 * The ISRCs that name the group's recording: the primary input's own (when trusted) and those
 * of the recording MusicBrainz links to its Spotify track.
 */
export function trustedIsrcs(group: EvalGroup): Set<string> {
  const found = new Set<string>()
  const reference = referenceSource(group)
  const own = normalizeIsrc(reference?.isrc)
  if (own !== null && isrcTrust(reference?.isrcOrigin) === 'trusted') found.add(own)
  for (const isrc of group.musicBrainz?.exact?.isrcs ?? []) {
    const canonical = normalizeIsrc(isrc)
    if (canonical !== null) found.add(canonical)
  }
  return found
}

/** Where a videoId sits on the ISRC searches for the group's trusted ISRCs. */
function isrcPlaces(
  group: EvalGroup,
  videoId: string,
): Array<{ isrc: string; attempt: number; position: number }> {
  const isrcs = trustedIsrcs(group)
  const places: Array<{ isrc: string; attempt: number; position: number }> = []
  for (const [key, page] of Object.entries(group.recording?.pages ?? {})) {
    const parts = parsePageKey(key)
    if (parts?.kind === 'isrc-songs' && isrcs.has(parts.query) && 'items' in page) {
      const index = page.items.indexOf(videoId)
      if (index >= 0)
        places.push({ isrc: parts.query, attempt: parts.attempt, position: index + 1 })
    }
    if (parts?.kind === 'isrc-top-card' && isrcs.has(parts.query) && 'item' in page) {
      if (page.item === videoId) places.push({ isrc: parts.query, attempt: 0, position: 1 })
    }
  }
  return places.sort((a, b) => a.attempt - b.attempt || a.position - b.position)
}

/** Seconds, signed, for evidence. */
function seconds(deltaMs: number): string {
  const value = Math.round(deltaMs / 100) / 10
  return `${value >= 0 ? '+' : ''}${value} s`
}

/** A rule's label. */
function rule(label: EvalLabel, evidence: string[], ambiguous = false): DraftLabel {
  return ambiguous
    ? { label, by: 'rule', evidence, ambiguous: true }
    : { label, by: 'rule', evidence }
}

/**
 * Drafts the label of one candidate of a group, from the recording alone. Certain labels:
 *
 * - `wrong`: a version tag on one side only (live, remix, acoustic, sped up…), two different
 *   remixes, a featured artist the input does not credit, more than 10 s apart, explicit against
 *   clean (unless the ISRC search found it, which makes it ambiguous), another title (in the same
 *   script), or no shared artist
 * - `exact`: found by an ISRC search for the group's ISRC (Spotify's or MusicBrainz's), with
 *   the input's title and artist and within 3 s; or within 3 s with the input's title and artist
 *   and a description whose ℗ label or release year agrees with the input's; or on the input's
 *   own album (not a compilation title or a self-titled one)
 *
 * Anything else is `ambiguous`, with a draft: `exact` for the input's title, artist and length
 * without such evidence (unless the description names another label two or more years before
 * the input's release, a sign of a re-recording or its original), else `wrong`.
 *
 * @returns `undefined` when the group has no such item or no input.
 */
export function draftLabel(group: EvalGroup, videoId: string): DraftLabel | undefined {
  const reference = referenceSource(group)
  const item = group.recording?.items[videoId]
  if (reference === undefined || item === undefined) return undefined
  const track = decodeItem(videoId, item)
  const prepared = prepareSource(sourceSide(reference))
  const breakdown = scoreCandidate(prepared, trackSide(track))
  const crossTitle = inDifferentScripts(reference.title, item.title)
  const crossArtist = inDifferentScripts(
    reference.artists.map((artist) => artist.name).join(' '),
    item.artists.join(' '),
  )
  const delta = breakdown.deltaMs
  const off = delta === undefined ? undefined : Math.abs(delta)
  const evidence: string[] = []
  if (delta !== undefined) evidence.push(`length ${seconds(delta)}`)

  const versions = breakdown.versionMismatches.filter((mismatch) => mismatch.level !== 'soft')
  if (versions.length > 0 || breakdown.differentRemix) {
    const tags = versions.map((m) => `${m.side === 'candidate' ? '+' : '-'}${m.tag}`)
    if (breakdown.differentRemix) tags.push('another remix')
    return rule('wrong', [...evidence, `version: ${tags.join(', ')}`])
  }
  if (breakdown.uncreditedFeatured.length > 0) {
    return rule('wrong', [...evidence, `features ${breakdown.uncreditedFeatured.join(', ')}`])
  }
  if (off !== undefined && off > OTHER_EDIT_MS) {
    return rule('wrong', [...evidence, 'more than 10 s apart: another edit or recording'])
  }
  const places = isrcPlaces(group, videoId)
  if (breakdown.explicitMismatch) {
    // YouTube Music keeps explicit and clean masters apart by ISRC, so an ISRC hit whose mark
    // differs may just lack the badge.
    return places.length > 0
      ? rule(
          'exact',
          [...evidence, 'found by the ISRC search, but its explicit mark differs'],
          true,
        )
      : rule('wrong', [...evidence, 'explicit against clean: another master'])
  }
  if (!crossTitle && breakdown.title < 0.5) {
    return rule('wrong', [...evidence, `another title (similarity ${breakdown.title.toFixed(2)})`])
  }
  if (!crossArtist && breakdown.artist === 0) {
    return rule('wrong', [...evidence, 'no shared artist'])
  }

  const titleOk = breakdown.title >= 0.8 || crossTitle
  const artistOk = breakdown.artist >= 0.5 || crossArtist
  const sameLength = off === undefined || off <= SAME_LENGTH_MS
  const firstOfSongs = places.some((place) => place.attempt > 0 && place.position === 1)
  if (
    places.length > 0 &&
    artistOk &&
    sameLength &&
    (breakdown.title >= 0.8 || (crossTitle && firstOfSongs))
  ) {
    const place = places[0]
    const where =
      place === undefined
        ? 'the ISRC search'
        : place.attempt === 0
          ? `the top-result card for ${place.isrc}`
          : `the ISRC search for ${place.isrc} (#${place.position}, attempt ${place.attempt})`
    return rule('exact', [...evidence, `found by ${where}`])
  }

  const facts = recordedFacts(group.recording ?? { recordedAt: [], items: {}, pages: {} }, videoId)
  const labelCompare = compareLabels(reference.label, facts)
  const yearCompare = compareYears(
    yearOf(reference.releaseDate),
    facts?.releaseYear ?? yearOf(item.releaseDate),
  )
  if (facts?.providedBy !== undefined) evidence.push(`provided by ${facts.providedBy}`)
  if (facts?.label !== undefined) evidence.push(`℗ ${facts.label}`)
  if (facts?.releaseYear !== undefined) evidence.push(`released ${facts.releaseYear}`)
  const strongText = breakdown.title >= 0.9 && artistOk
  if (strongText && sameLength && (labelCompare === 'match' || yearCompare === 'match')) {
    const why =
      labelCompare === 'match'
        ? "the label agrees with the input's"
        : "the release year agrees with the input's"
    return rule('exact', [...evidence, `same title, artist and length; ${why}`])
  }
  const album = reference.album?.name
  const level = albumMatchLevel(
    album,
    item.album,
    reference.artists.map((artist) => artist.name),
  )
  const selfTitled =
    album !== undefined &&
    reference.artists.some((artist) => albumMatchLevel(album, artist.name) !== 'none')
  if (
    strongText &&
    sameLength &&
    album !== undefined &&
    isSameRelease(level) &&
    !isGenericAlbum(album) &&
    !selfTitled
  ) {
    return rule('exact', [...evidence, `on the input's album (${album})`])
  }

  if (titleOk && artistOk && sameLength) {
    if (labelCompare === 'conflict' && yearCompare === 'conflict') {
      return rule(
        'wrong',
        [
          ...evidence,
          'another label, two or more years earlier: possibly the original of a re-recording',
        ],
        true,
      )
    }
    const conflicts = [
      labelCompare === 'conflict' ? 'another label' : undefined,
      yearCompare === 'later' ? 'a later release' : undefined,
    ].filter((text): text is string => text !== undefined)
    return rule(
      'exact',
      [
        ...evidence,
        'same title, artist and length, without ISRC, label, year or album evidence',
        ...conflicts,
      ],
      true,
    )
  }
  return rule(
    'wrong',
    [
      ...evidence,
      `title ${breakdown.title.toFixed(2)}, artist ${breakdown.artist.toFixed(2)}${sameLength ? '' : ', 3 to 10 s apart'}`,
    ],
    true,
  )
}

/**
 * The candidates of a group that need a label, most important first: every input's pick (the
 * best candidate) under each option set (by default the recorder's, which cover the calibration
 * grid's corners), the main input first and the defaults first; then the picks with the ISRC
 * cap lifted; then the first item of each ISRC search for a trusted ISRC (which the report's
 * ISRC columns read). The recorder fetches descriptions for the first ambiguous ones.
 */
export function labelTargets(
  group: EvalGroup,
  optionSets: readonly MatchOptions[] = RECORDING_OPTIONS,
): string[] {
  const recording = group.recording
  if (recording === undefined) return []
  const targets = new Set<string>()
  const variants = [...group.variants].sort(
    (a, b) => Number(!PRIMARY_SLICES.includes(a.slice)) - Number(!PRIMARY_SLICES.includes(b.slice)),
  )
  for (const capped of [true, false]) {
    for (const options of optionSets) {
      for (const variant of variants) {
        const source = capped ? variant.source : withoutIsrcCap(variant.source)
        if (source === undefined) continue
        const best = replayMatch(source, recording, options).result.best
        if (best !== undefined && best.source === 'ytm') targets.add(best.ref)
      }
    }
  }
  for (const isrc of trustedIsrcs(group)) {
    const [key] = pageKeys({ kind: 'isrc-songs', query: isrc, attempt: 1 })
    const page = key === undefined ? undefined : recording.pages[key]
    const first = page !== undefined && 'items' in page ? page.items[0] : undefined
    if (first !== undefined) targets.add(first)
  }
  return [...targets]
}

/**
 * The group's labels with the rules applied to every target: labels by an agent or the owner are
 * kept as they are, rule labels are drafted again (the rules may have changed), and labels of
 * candidates that are no longer targets are kept too, so a review is never lost.
 */
export function draftLabels(group: EvalGroup): Record<string, EvalLabelEntry> {
  const labels: Record<string, EvalLabelEntry> = { ...group.labels }
  for (const videoId of labelTargets(group)) {
    const existing = labels[videoId]
    if (existing !== undefined && existing.by !== 'rule') continue
    const draft = draftLabel(group, videoId)
    if (draft !== undefined) labels[videoId] = draft
  }
  return Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

// --- The review checklist ---------------------------------------------------------------

/** The columns of `REVIEW.csv`, in order. */
export const REVIEW_COLUMNS = [
  'kind',
  'group',
  'video',
  'link',
  'input',
  'candidate',
  'release',
  'draft',
  'by',
  'evidence',
  'decision',
  'notes',
] as const

/**
 * Why a row is in the checklist: an `ambiguous` label to decide, a `spot-check` of the 10 %
 * sample of certain labels, or, once a spot check was overturned, an `auto-play`: a certain
 * label that a held-out Auto play rests on.
 */
export type ReviewKind = 'ambiguous' | 'spot-check' | 'auto-play'

/** One row of the review checklist. */
export type ReviewRow = Record<(typeof REVIEW_COLUMNS)[number], string> & { kind: ReviewKind }

/** The share of the certain labels the owner spot-checks. */
const SPOT_CHECK_SHARE = 0.1

/** Minutes the owner needs per row: listening for an ambiguous label, checking a certain one. */
export const REVIEW_MINUTES: Readonly<Record<ReviewKind, number>> = Object.freeze({
  ambiguous: 3,
  'spot-check': 1.5,
  'auto-play': 1.5,
})

/** "m:ss" for people. */
function clock(ms: number | undefined): string {
  if (ms === undefined) return '?'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** One line for an input. */
function describeInput(source: MatchSource): string {
  const artists = source.artists.map((artist) => artist.name).join(', ')
  const facts = [source.releaseDate, source.label].filter((part) => part !== undefined).join(', ')
  return [
    `${source.title} — ${artists}`,
    source.album?.name === undefined ? '' : ` — ${source.album.name}`,
    facts === '' ? '' : ` (${facts})`,
    ` [${clock(source.durationMs)}]`,
    source.isrc === undefined ? '' : ` ISRC ${source.isrc}`,
  ].join('')
}

/** A label with what the checklist shows about it. */
function reviewRow(
  group: EvalGroup,
  videoId: string,
  entry: EvalLabelEntry,
  kind: ReviewKind,
): ReviewRow | undefined {
  const reference = referenceSource(group)
  const item = group.recording?.items[videoId]
  if (reference === undefined || item === undefined) return undefined
  const description = group.recording?.pages[`description/${videoId}`]
  return {
    kind,
    group: group.id,
    video: videoId,
    link: `https://music.youtube.com/watch?v=${videoId}`,
    input: describeInput(reference),
    candidate: `${item.title} — ${item.artists.join(', ')}${item.album === undefined ? '' : ` — ${item.album}`} [${clock(item.durationMs)}]`,
    release:
      description !== undefined && 'facts' in description
        ? (description.excerpt ?? '').replace(/\n+/gu, ' | ')
        : '',
    draft: entry.label,
    by: entry.by,
    evidence: entry.evidence.join('; '),
    decision: '',
    notes: '',
  }
}

/** The key of a group's candidate in {@link reviewPlan}'s `autoPicks`: `<group id>/<videoId>`. */
export function pickKey(groupId: string, videoId: string): string {
  return `${groupId}/${videoId}`
}

/** Whether the owner's label differs from the draft they reviewed. */
export function isOverturned(entry: EvalLabelEntry): boolean {
  return entry.by === 'owner' && entry.draft !== undefined && entry.draft.label !== entry.label
}

/** What the owner's review covers, and how far it got. */
export interface ReviewPlan {
  /** Ambiguous labels, and how many of them the owner decided. */
  ambiguous: { total: number; decided: number }
  /**
   * Certain labels, how many the spot check needs (10 %), how many it checked, and how many of
   * those the owner overturned.
   */
  spotCheck: { labels: number; required: number; checked: number; overturned: number }
  /**
   * Set once a spot check was overturned, which shows that the rules' certain labels can be
   * wrong: the certain labels that held-out Auto plays rest on, which then all need the owner's
   * check, and how many the owner checked.
   */
  autoPlays?: { labels: number; checked: number }
  /**
   * The rows still to review: undecided ambiguous labels, the spot checks still needed, then
   * the unchecked labels of held-out Auto plays (only after an overturned spot check).
   */
  pending: ReviewRow[]
}

/**
 * What the owner reviews, of the labels in the set: every ambiguous one, and a spot check of 10 %
 * of the certain ones (drafted by the rules or an agent). The spot-check rows are a fixed sample
 * (by a hash of group and video), so every run lists the same ones until enough are checked.
 *
 * A spot check the owner overturned shows that certain labels can be wrong, so from then on
 * every certain label that a held-out Auto play rests on needs the owner's check too:
 * `autoPicks` names those candidates (see {@link pickKey}); it is called only then.
 */
export function reviewPlan(
  groups: readonly EvalGroup[],
  autoPicks: () => ReadonlySet<string> = () => new Set(),
): ReviewPlan {
  const ambiguous: ReviewRow[] = []
  let ambiguousTotal = 0
  let decided = 0
  let overturned = 0
  const certain: Array<{ key: string; group: EvalGroup; videoId: string; entry: EvalLabelEntry }> =
    []
  for (const group of groups) {
    for (const [videoId, entry] of Object.entries(group.labels ?? {})) {
      const row = reviewRow(group, videoId, entry, 'ambiguous')
      if (row === undefined) continue
      if (entry.ambiguous === true) {
        ambiguousTotal += 1
        if (entry.by === 'owner') decided += 1
        else ambiguous.push(row)
      } else {
        certain.push({ key: pickKey(group.id, videoId), group, videoId, entry })
        if (isOverturned(entry)) overturned += 1
      }
    }
  }
  const isChecked = (label: { entry: EvalLabelEntry }) => label.entry.reviewed !== undefined
  const required = Math.ceil(certain.length * SPOT_CHECK_SHARE)
  const checked = certain.filter(isChecked).length
  const sample = certain
    .filter((label) => !isChecked(label))
    .sort(
      (a, b) =>
        stableHash(a.key) - stableHash(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, Math.max(0, required - checked))
  const rows = (labels: typeof certain, kind: ReviewKind) =>
    labels.flatMap(({ group, videoId, entry }) => reviewRow(group, videoId, entry, kind) ?? [])
  const plan: ReviewPlan = {
    ambiguous: { total: ambiguousTotal, decided },
    spotCheck: { labels: certain.length, required, checked, overturned },
    pending: [...ambiguous, ...rows(sample, 'spot-check')],
  }
  if (overturned > 0) {
    const picks = autoPicks()
    const backing = certain.filter((label) => picks.has(label.key))
    const listed = new Set(sample.map((label) => label.key))
    plan.autoPlays = { labels: backing.length, checked: backing.filter(isChecked).length }
    plan.pending.push(
      ...rows(
        backing.filter((label) => !isChecked(label) && !listed.has(label.key)),
        'auto-play',
      ),
    )
  }
  return plan
}

/**
 * The review checklist's rows (see {@link reviewPlan}). The owner fills in `decision` (`exact`,
 * `equivalent` or `wrong`; `ok` confirms the draft the row shows) and, optionally, `notes`.
 */
export function reviewRows(
  groups: readonly EvalGroup[],
  autoPicks?: () => ReadonlySet<string>,
): ReviewRow[] {
  return reviewPlan(groups, autoPicks).pending
}

/** Minutes the owner needs for the rows still to review (see {@link REVIEW_MINUTES}). */
export function reviewMinutes(rows: readonly ReviewRow[]): number {
  return Math.round(rows.reduce((sum, row) => sum + REVIEW_MINUTES[row.kind], 0))
}

/**
 * What a spreadsheet would read as a formula: a cell starting with `=`, `+`, `-`, `@`, a tab or
 * a carriage return. The checklist writes such a cell with a leading `'`, which spreadsheets
 * take as "text"; {@link reviewCell} takes it off again.
 */
const FORMULA_START = /^[=+\-@\t\r]/u

/** One CSV field: protected from spreadsheets, and quoted when it needs to be (RFC 4180). */
function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\n\r]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe
}

/** A checklist cell as it was before {@link renderReviewCsv} protected it from spreadsheets. */
export function reviewCell(cell: string): string {
  return cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell
}

/**
 * The review checklist as CSV, with a header row and CRLF line ends (RFC 4180). A cell that
 * starts like a formula (a videoId such as `-FosatJWWas`, a title such as "=)") gets a leading
 * `'`, so that a spreadsheet shows it as text instead of evaluating it.
 */
export function renderReviewCsv(rows: readonly ReviewRow[]): string {
  const lines = [REVIEW_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(REVIEW_COLUMNS.map((column) => csvField(row[column])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

/** Reads CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF) into rows of fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((fields) => fields.some((value) => value.trim() !== ''))
}
