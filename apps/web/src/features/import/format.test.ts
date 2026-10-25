import { noSkips } from '@fxm/sources/import'
import { describe, expect, it } from 'vitest'
import type { ImportProgressRecord } from '../../db/types'
import { countsText, kindLabel, lengthText, shownStatus, skippedText, statusText } from './format'
import { HISTORY_IMPORT_KIND } from './runner'

function record(overrides: Partial<ImportProgressRecord> = {}): ImportProgressRecord {
  return {
    id: 'one',
    kind: 'csv',
    label: 'Mix',
    status: 'running',
    total: 100,
    done: 40,
    matched: 30,
    needsReview: 8,
    failed: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('import words', () => {
  it('shows an import no tab runs as interrupted', () => {
    expect(shownStatus(record(), null)).toBe('interrupted')
    expect(shownStatus(record(), 'one')).toBe('running')
    expect(shownStatus(record({ status: 'paused' }), null)).toBe('paused')
    expect(shownStatus(record({ status: 'pending' }), null, ['one'])).toBe('pending')
    expect(shownStatus(record({ status: 'pending' }), null, [])).toBe('interrupted')
  })

  it('says what a running import does, including a wait for the request budget', () => {
    const now = Date.UTC(2026, 9, 26, 12)
    expect(statusText(record(), 'running', { status: { index: 41, phase: 'matching' } }, now)).toBe(
      'Matching song 42 of 100',
    )
    expect(
      statusText(record(), 'running', { status: { index: 3, phase: 'looking-up' } }, now),
    ).toBe('Looking up song 4 of 100')
    expect(
      statusText(
        record(),
        'running',
        { status: { index: 41, phase: 'waiting' }, waitingUntil: now + 30 * 60_000 },
        now,
      ),
    ).toMatch(/^Waiting for YouTube’s request limit: the next search is at /u)
    expect(statusText(record({ status: 'paused', error: 'No YouTube.' }), 'paused', {})).toBe(
      'Paused. No YouTube.',
    )
    expect(statusText(record(), 'interrupted', {})).toMatch(/^Stopped when the page closed/u)
    expect(statusText(record({ status: 'done' }), 'done', {})).toBe('Done')
  })

  it('words listening-history imports differently', () => {
    const history = record({ kind: HISTORY_IMPORT_KIND, total: 3, done: 3, status: 'done' })
    expect(kindLabel(HISTORY_IMPORT_KIND)).toBe('Listening history')
    expect(statusText(history, 'done', {})).toBe('3 plays recorded')
    expect(countsText(history)).toBe('3 plays')
    expect(statusText(history, 'interrupted', {})).toMatch(/no play is recorded twice/u)
  })

  it('counts an import and what its input left out', () => {
    expect(countsText(record())).toBe('100 songs: 30 matched · 8 to review · 2 failed')
    expect(countsText(record({ needsReview: 0, failed: 0 }))).toBe('100 songs: 30 matched')
    expect(skippedText(noSkips())).toBe('')
    expect(skippedText({ ...noSkips(), episodes: 1 })).toBe('1 podcast episode')
    expect(skippedText({ ...noSkips(), episodes: 2, localFiles: 1, shortPlays: 3 })).toBe(
      '2 podcast episodes, 1 local file and 3 plays shorter than 5 seconds',
    )
    expect(kindLabel('spotify-export')).toBe('Spotify data')
    expect(kindLabel('something-new')).toBe('Import')
    expect(lengthText(185_000)).toBe('3:05')
    expect(lengthText(undefined)).toBe('')
  })
})
