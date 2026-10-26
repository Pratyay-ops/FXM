/**
 * Words for imports: what each kind is called, where an import stands, and what its input left
 * out.
 *
 * @module
 */

import { formatTime } from '@fxm/player'
import {
  type ImportBlockReason,
  type ImportRunStatus,
  type ImportSkips,
  MAX_IMPORT_ROWS,
} from '@fxm/sources/import'
import type { ImportProgressRecord } from '../../db/types'
import { countLabel } from '../library/format'
import type { ImportActivity } from './runner'
import { HISTORY_IMPORT_KIND } from './runner'
import type { MatchingAvailability } from './services'

const KIND_LABELS: Readonly<Record<string, string>> = {
  'spotify-export': 'Spotify data',
  csv: 'CSV file',
  m3u: 'M3U playlist',
  spotify: 'Spotify link',
  youtube: 'YouTube playlist',
  [HISTORY_IMPORT_KIND]: 'Listening history',
}

/** What an import's kind is called. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? 'Import'
}

/**
 * Where an import stands, as the page shows it: the record's status, except for an import the
 * record calls `running` or `pending`. That one is `running` when this tab runs or records it,
 * `elsewhere` when another tab does, `pending` while it waits in this tab's queue, and
 * `interrupted` otherwise (its tab closed or reloaded).
 */
export type ShownStatus = ImportProgressRecord['status'] | 'interrupted' | 'elsewhere'

/** What this tab knows about the imports beyond their records. */
export interface RunnerView {
  /** The import this tab runs. */
  activeId: string | null
  /** The imports waiting in this tab's queue. */
  queued: readonly string[]
  /** The listening histories this tab records. */
  recording?: readonly string[]
  /** The imports another tab runs or records. */
  elsewhere?: ReadonlySet<string>
}

/** Where an import stands (see {@link ShownStatus}). */
export function shownStatus(record: ImportProgressRecord, runner: RunnerView): ShownStatus {
  const { id, status } = record
  if (status !== 'running' && status !== 'pending') return status
  if (id === runner.activeId || runner.recording?.includes(id)) return 'running'
  if (runner.elsewhere?.has(id)) return 'elsewhere'
  if (status === 'pending' && runner.queued.includes(id)) return 'pending'
  return 'interrupted'
}

/** Whether an import's state lets the user resume it. */
export function canResume(record: ImportProgressRecord, status: ShownStatus): boolean {
  return record.kind !== HISTORY_IMPORT_KIND && (status === 'paused' || status === 'interrupted')
}

/** Whether an import's state lets the user pause or cancel it. */
export function canPause(record: ImportProgressRecord, status: ShownStatus): boolean {
  return record.kind !== HISTORY_IMPORT_KIND && (status === 'running' || status === 'pending')
}

/** Whether an import is being worked on, here or in another tab. */
export function isBusy(status: ShownStatus): boolean {
  return status === 'running' || status === 'pending' || status === 'elsewhere'
}

const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' })

/** What the running job does, in words. */
function activityText(activity: ImportActivity, record: ImportProgressRecord, now: number): string {
  const position = Math.min(record.total, (activity.status?.index ?? record.done) + 1)
  const of = `${position.toLocaleString('en')} of ${record.total.toLocaleString('en')}`
  const phase: ImportRunStatus['phase'] | undefined = activity.status?.phase
  if (
    phase === 'waiting' &&
    activity.waitingUntil !== undefined &&
    activity.waitingUntil > now + 1000
  ) {
    return `Waiting for YouTube’s request limit: the next search is at ${time.format(activity.waitingUntil)}`
  }
  if (phase === 'loading') return `Reading song ${of}`
  if (phase === 'looking-up') return `Looking up song ${of}`
  return `Matching song ${of}`
}

/** Why an import paused by itself, in a few neutral words. */
function blockedText(reason: ImportBlockReason, matching: MatchingAvailability | undefined) {
  if (reason === 'offline') return 'Paused: no connection. It goes on once you’re back online.'
  if (matching === 'needs-connect') return 'Paused: needs FXM Connect'
  if (matching === 'unavailable') return 'Paused: finding songs isn’t available yet'
  if (matching === 'ready') return 'Paused. Resume it to find the songs.'
  return 'Paused: YouTube Music was out of reach'
}

/** What {@link statusText} needs besides the record and its status. */
export interface StatusContext {
  /** What this tab's job does, when it runs the import. */
  activity?: ImportActivity | null
  /** Why the import paused by itself, from its progress (`importBlockOf`). */
  blocked?: ImportBlockReason | undefined
  /** Whether imports can find songs here now. */
  matching?: MatchingAvailability | undefined
  /** The clock. */
  now?: number
}

/** One line on where an import stands. */
export function statusText(
  record: ImportProgressRecord,
  status: ShownStatus,
  context: StatusContext = {},
): string {
  const of = `${record.done.toLocaleString('en')} of ${record.total.toLocaleString('en')}`
  if (record.kind === HISTORY_IMPORT_KIND) {
    if (status === 'done') return `${countLabel(record.done, 'play')} recorded`
    if (status === 'running') return `Recording plays: ${of}`
    if (status === 'elsewhere') return `Recording plays in another tab or window: ${of}`
    return 'Interrupted. Import the data download again to record the rest: no play is recorded twice.'
  }
  switch (status) {
    case 'running':
      return activityText(context.activity ?? {}, record, context.now ?? Date.now())
    case 'pending':
      return 'Waiting to start'
    case 'elsewhere':
      return 'Importing in another tab or window'
    case 'paused':
      if (record.error) return `Paused. ${record.error}`
      return context.blocked === undefined
        ? 'Paused'
        : blockedText(context.blocked, context.matching)
    case 'interrupted':
      return 'Stopped when the page closed. Resume it to go on where it left off.'
    case 'done':
      return 'Done'
    case 'failed':
      return record.error ?? 'Stopped'
    case 'cancelled':
      return 'Cancelled'
  }
}

/** Whether an import's status line reports a failure that needs the user (in the danger color). */
export function isAlarming(record: ImportProgressRecord, status: ShownStatus): boolean {
  if (record.kind === HISTORY_IMPORT_KIND) return false
  return status === 'failed' || (status === 'paused' && Boolean(record.error))
}

/** The counts of an import, e.g. "100 songs: 80 matched · 10 to review · 1 failed". */
export function countsText(record: ImportProgressRecord): string {
  if (record.kind === HISTORY_IMPORT_KIND) return countLabel(record.total, 'play')
  const parts = [`${record.matched.toLocaleString('en')} matched`]
  if (record.needsReview > 0) parts.push(`${record.needsReview.toLocaleString('en')} to review`)
  if (record.failed > 0) parts.push(`${record.failed.toLocaleString('en')} failed`)
  return `${countLabel(record.total, 'song')}: ${parts.join(' · ')}`
}

/** What an input left out, e.g. "3 podcast episodes and 1 local file". Empty when nothing. */
export function skippedText(skipped: ImportSkips): string {
  const parts: string[] = []
  if (skipped.episodes > 0) parts.push(countLabel(skipped.episodes, 'podcast episode'))
  if (skipped.localFiles > 0) parts.push(countLabel(skipped.localFiles, 'local file'))
  if (skipped.duplicates > 0) parts.push(countLabel(skipped.duplicates, 'duplicate'))
  if (skipped.unreadable > 0) parts.push(countLabel(skipped.unreadable, 'unreadable line'))
  if (skipped.overLimit > 0) {
    parts.push(
      `${countLabel(skipped.overLimit, 'song')} over the ${MAX_IMPORT_ROWS.toLocaleString('en')}-song limit`,
    )
  }
  if (skipped.shortPlays > 0) {
    parts.push(`${countLabel(skipped.shortPlays, 'play')} shorter than 5 seconds`)
  }
  if (skipped.unknownPlays > 0) {
    parts.push(`${countLabel(skipped.unknownPlays, 'play')} of songs the download doesn’t name`)
  }
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** "3:05" for a length in milliseconds; empty when unknown. */
export function lengthText(ms: number | undefined): string {
  return ms === undefined ? '' : formatTime(ms / 1000)
}
