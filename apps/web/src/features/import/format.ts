/**
 * Words for imports: what each kind is called, where an import stands, and what its input left
 * out.
 *
 * @module
 */

import { formatTime } from '@fxm/player'
import type { ImportRunStatus, ImportSkips } from '@fxm/sources/import'
import type { ImportProgressRecord } from '../../db/types'
import { countLabel } from '../library/format'
import type { ImportActivity } from './runner'
import { HISTORY_IMPORT_KIND } from './runner'

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
 * Where an import stands, as the page shows it: the record's status, except that an import the
 * record calls `running` or `pending` that this tab neither runs nor has queued is
 * `interrupted` (its tab closed or reloaded).
 */
export type ShownStatus = ImportProgressRecord['status'] | 'interrupted'

/** Where an import stands, given which import this tab runs and which it has queued. */
export function shownStatus(
  record: ImportProgressRecord,
  activeId: string | null,
  queued: readonly string[] = [],
): ShownStatus {
  if (record.status === 'running' && record.id !== activeId) return 'interrupted'
  if (record.status === 'pending' && !queued.includes(record.id)) return 'interrupted'
  return record.status
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

/** One line on where an import stands. */
export function statusText(
  record: ImportProgressRecord,
  status: ShownStatus,
  activity: ImportActivity,
  now = Date.now(),
): string {
  if (record.kind === HISTORY_IMPORT_KIND) {
    if (status === 'done') return `${countLabel(record.done, 'play')} recorded`
    if (status === 'interrupted' || status === 'failed') {
      return 'Interrupted. Import the data download again to record the rest: no play is recorded twice.'
    }
    return `Recording plays: ${record.done.toLocaleString('en')} of ${record.total.toLocaleString('en')}`
  }
  switch (status) {
    case 'running':
      return activityText(activity, record, now)
    case 'pending':
      return 'Waiting to start'
    case 'paused':
      return record.error ? `Paused. ${record.error}` : 'Paused'
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

/** The counts of an import, e.g. "80 matched · 10 to review · 1 failed". */
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
