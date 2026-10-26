/**
 * An import's match report: what became of every row, with the totals, as data for the app and
 * as CSV or JSON files the user can save.
 *
 * @module
 */

import type { AutoBlocker, CatalogMode, EntityId, MatchBand, TrackKind } from '@fxm/core'
import { candidateTrackId } from './match'
import { type RowStatus, rowStatus } from './state'
import type { ImportKind, ImportState, RowResult, StoredRow } from './types'

/** The totals of a match report. */
export interface ImportReportTotals {
  /** Rows in the input. */
  rows: number
  /** Rows not processed yet. */
  pending: number
  /** Rows whose own track plays as it is. */
  ready: number
  /** Rows matched to a song that plays without asking. */
  matched: number
  /** Rows with a best guess waiting for the user. */
  review: number
  /** Rows for which nothing good enough was found. */
  notFound: number
  /** Rows that failed. */
  failed: number
  /** Rows the user confirmed in the review list. */
  confirmed: number
  /** Rows the user skipped. */
  skipped: number
  /** Rows in review whose guess would play without asking once Auto matching is on. */
  likely: number
  /** Rows matched through their ISRC. */
  isrcVerified: number
  /** Rows matched without a length (no-duration mode, at most Suggest). */
  noDuration: number
  /** Rows whose ISRC or length came from MusicBrainz's exact path. */
  musicBrainz: number
  /** Rows whose ISRC or length came from Spotify. */
  spotify: number
  /** Rows whose decision came from the library's match cache. */
  cached: number
  /** Rows whose search could not fetch every page. */
  incomplete: number
}

/** The match a report row names. */
export interface ImportReportMatch {
  /** Its track ID, e.g. `ytm:track:…`. */
  id: EntityId<'track'>
  /** Its title. */
  title: string
  /** Its artists. */
  artists: string[]
  /** Its length in milliseconds. */
  durationMs?: number
  /** Song or video. */
  kind: TrackKind
}

/** One row of a match report. */
export interface ImportReportRow {
  /** Its position in the input, from 1. */
  position: number
  /** The title as the input spells it. */
  title: string
  /** The artists as the input names them. */
  artists: string[]
  /** The album, when the input names it. */
  album?: string
  /** The length the input gives, in milliseconds. */
  durationMs?: number
  /** The input's own track, when it names one. */
  trackId?: EntityId<'track'>
  /** Where it stands. */
  status: RowStatus
  /** The band the engine reached with the Auto setting on. */
  verdict?: MatchBand
  /** How sure the engine is about the match, from 0 to 1. */
  confidence?: number
  /** The match: the one the user chose, else the engine's best. */
  match?: ImportReportMatch
  /** The ISRC the match used. */
  isrc?: string
  /** Whether the match was verified through its ISRC. */
  isrcVerified: boolean
  /** Where the ISRC or length came from, when the import looked them up. */
  lookup?: 'spotify' | 'musicbrainz'
  /** Whether the row had no length (no-duration mode). */
  noDuration: boolean
  /** Why the match did not reach the Auto band. */
  blockers: AutoBlocker[]
  /** The engine's evidence. */
  evidence: string[]
  /** Why it failed. */
  error?: string
}

/** An import's match report. */
export interface ImportReport {
  /** What was imported, for people. */
  label: string
  /** What kind of input it was. */
  kind: ImportKind
  /** The catalog mode it matched in. */
  mode: CatalogMode
  /** The totals. */
  totals: ImportReportTotals
  /** Every row, in the input's order. */
  rows: ImportReportRow[]
}

/** The match a row names: the candidate the user chose, else the best. */
function chosenMatch(result: RowResult): ImportReportMatch | undefined {
  const ref = result.review?.action === 'confirmed' ? result.review.ref : undefined
  const candidate =
    (ref === undefined
      ? undefined
      : [result.best, ...(result.alternatives ?? [])].find((option) => option?.ref === ref)) ??
    result.best
  if (candidate === undefined) return undefined
  const match: ImportReportMatch = {
    id: candidateTrackId(candidate),
    title: candidate.title,
    artists: [...candidate.artists],
    kind: candidate.kind,
  }
  if (candidate.durationMs !== undefined) match.durationMs = candidate.durationMs
  return match
}

function reportRow(row: StoredRow, result: RowResult | null, index: number): ImportReportRow {
  const status = rowStatus(result)
  const entry: ImportReportRow = {
    position: index + 1,
    title: row.title,
    artists: [...row.artists],
    status,
    isrcVerified: result?.best?.signals?.isrcVerified === true,
    noDuration: result?.noDuration === true,
    blockers: [...(result?.blockers ?? [])],
    evidence: [...(result?.evidence ?? [])],
  }
  if (row.album !== undefined) entry.album = row.album
  if (row.durationMs !== undefined) entry.durationMs = row.durationMs
  if (row.trackId !== undefined) entry.trackId = row.trackId
  if (result === null) return entry
  if (result.verdict !== undefined) entry.verdict = result.verdict
  if (result.best !== undefined) entry.confidence = result.best.confidence
  const match = chosenMatch(result)
  if (match !== undefined) entry.match = match
  if (result.isrc !== undefined) entry.isrc = result.isrc
  if (result.lookup !== undefined) entry.lookup = result.lookup
  if (result.error !== undefined) entry.error = result.error
  return entry
}

/** The match report of an import's progress so far. */
export function importReport(state: ImportState, label: string): ImportReport {
  const totals: ImportReportTotals = {
    rows: state.rows.length,
    pending: 0,
    ready: 0,
    matched: 0,
    review: 0,
    notFound: 0,
    failed: 0,
    confirmed: 0,
    skipped: 0,
    likely: 0,
    isrcVerified: 0,
    noDuration: 0,
    musicBrainz: 0,
    spotify: 0,
    cached: 0,
    incomplete: 0,
  }
  const rows = state.rows.map((row, index) => {
    const result = state.results[index] ?? null
    const entry = reportRow(row, result, index)
    const key = entry.status === 'not-found' ? 'notFound' : entry.status
    totals[key]++
    if (entry.status === 'review' && result?.verdict === 'auto') totals.likely++
    if (entry.isrcVerified) totals.isrcVerified++
    if (entry.noDuration) totals.noDuration++
    if (result?.lookup === 'musicbrainz') totals.musicBrainz++
    if (result?.lookup === 'spotify') totals.spotify++
    if (result?.cached) totals.cached++
    if (result?.incomplete) totals.incomplete++
    return entry
  })
  return { label, kind: state.kind, mode: state.mode, totals, rows }
}

/** `m:ss` for a length in milliseconds; empty when unknown. */
function clock(ms: number | undefined): string {
  if (ms === undefined) return ''
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * One CSV field: quoted when it holds a quote, a comma or a line break. A field that a
 * spreadsheet would read as a formula (starting with `=`, `+`, `-`, `@` or a tab) gets a
 * leading apostrophe, so a crafted song title cannot run in the user's spreadsheet.
 */
export function csvField(value: string | number | boolean | undefined): string {
  let text = value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const STATUS_LABELS: Readonly<Record<RowStatus, string>> = {
  pending: 'Waiting',
  ready: 'Plays as it is',
  matched: 'Matched',
  review: 'Needs review',
  'not-found': 'Not found',
  failed: 'Failed',
  confirmed: 'Confirmed by you',
  skipped: 'Skipped by you',
}

/** A report's rows as CSV, with a header row; lines end with CRLF, as RFC 4180 asks. */
export function reportToCsv(report: ImportReport): string {
  const header = [
    'Position',
    'Title',
    'Artists',
    'Album',
    'Length',
    'Status',
    'With Auto on',
    'Confidence',
    'Matched title',
    'Matched artists',
    'Matched length',
    'Matched ID',
    'ISRC',
    'ISRC verified',
    'Looked up on',
    'No length',
    'Why not automatic',
    'Evidence',
    'Error',
  ]
  const lines = [header.map(csvField).join(',')]
  for (const row of report.rows) {
    lines.push(
      [
        row.position,
        row.title,
        row.artists.join('; '),
        row.album,
        clock(row.durationMs),
        STATUS_LABELS[row.status],
        row.verdict,
        row.confidence === undefined ? undefined : row.confidence.toFixed(2),
        row.match?.title,
        row.match?.artists.join('; '),
        clock(row.match?.durationMs),
        row.match?.id,
        row.isrc,
        row.isrcVerified ? 'yes' : 'no',
        row.lookup,
        row.noDuration ? 'yes' : 'no',
        row.blockers.join('; '),
        row.evidence.join('; '),
        row.error,
      ]
        .map(csvField)
        .join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/** A report as pretty-printed JSON. */
export function reportToJson(report: ImportReport): string {
  return `${JSON.stringify({ format: 'fxm-import-report', version: 1, ...report }, null, 2)}\n`
}
