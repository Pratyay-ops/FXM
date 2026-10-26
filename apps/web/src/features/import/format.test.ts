import { noSkips } from '@fxm/sources/import'
import { describe, expect, it } from 'vitest'
import type { ImportProgressRecord } from '../../db/types'
import {
  canPause,
  canResume,
  countsText,
  isAlarming,
  kindLabel,
  lengthText,
  shownStatus,
  skippedText,
  statusText,
} from './format'
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

const idle = { activeId: null, queued: [] }

describe('import words', () => {
  it('shows an import no tab runs as interrupted, and one another tab runs as elsewhere', () => {
    expect(shownStatus(record(), idle)).toBe('interrupted')
    expect(shownStatus(record(), { activeId: 'one', queued: [] })).toBe('running')
    expect(shownStatus(record({ status: 'paused' }), idle)).toBe('paused')
    expect(shownStatus(record({ status: 'pending' }), { activeId: null, queued: ['one'] })).toBe(
      'pending',
    )
    expect(shownStatus(record({ status: 'pending' }), idle)).toBe('interrupted')
    // Starting: no longer queued, not running yet.
    expect(shownStatus(record({ status: 'pending' }), { activeId: 'one', queued: [] })).toBe(
      'running',
    )
    expect(shownStatus(record(), { ...idle, elsewhere: new Set(['one']) })).toBe('elsewhere')
    const history = record({ kind: HISTORY_IMPORT_KIND })
    expect(shownStatus(history, { ...idle, recording: ['one'] })).toBe('running')
  })

  it('offers no Resume, Pause or Cancel for a listening history', () => {
    const history = record({ kind: HISTORY_IMPORT_KIND })
    expect(canResume(history, 'interrupted')).toBe(false)
    expect(canPause(history, 'running')).toBe(false)
    expect(canResume(record(), 'interrupted')).toBe(true)
    expect(canPause(record(), 'pending')).toBe(true)
    expect(canResume(record(), 'elsewhere')).toBe(false)
    expect(canPause(record(), 'elsewhere')).toBe(false)
  })

  it('says what a running import does, including a wait for the request budget', () => {
    const now = Date.UTC(2026, 9, 26, 12)
    expect(
      statusText(record(), 'running', {
        activity: { status: { index: 41, phase: 'matching' } },
        now,
      }),
    ).toBe('Matching song 42 of 100')
    expect(
      statusText(record(), 'running', {
        activity: { status: { index: 3, phase: 'looking-up' } },
        now,
      }),
    ).toBe('Looking up song 4 of 100')
    expect(
      statusText(record(), 'running', {
        activity: { status: { index: 41, phase: 'waiting' }, waitingUntil: now + 30 * 60_000 },
        now,
      }),
    ).toMatch(/^Waiting for YouTube’s request limit: the next search is at /u)
    expect(statusText(record(), 'interrupted')).toMatch(/^Stopped when the page closed/u)
    expect(statusText(record(), 'elsewhere')).toBe('Importing in another tab or window')
    expect(statusText(record({ status: 'done' }), 'done')).toBe('Done')
  })

  it('says why an import paused, neutrally unless something failed', () => {
    const paused = record({ status: 'paused' })
    expect(statusText(paused, 'paused')).toBe('Paused')
    expect(
      statusText(paused, 'paused', { blocked: 'unsupported', matching: 'needs-connect' }),
    ).toBe('Paused: needs FXM Connect')
    expect(statusText(paused, 'paused', { blocked: 'unsupported', matching: 'unavailable' })).toBe(
      'Paused: finding songs isn’t available yet',
    )
    expect(statusText(paused, 'paused', { blocked: 'offline' })).toMatch(/^Paused: no connection/u)
    expect(isAlarming(paused, 'paused')).toBe(false)
    const full = record({ status: 'paused', error: 'The library couldn’t save the import.' })
    expect(statusText(full, 'paused')).toBe('Paused. The library couldn’t save the import.')
    expect(isAlarming(full, 'paused')).toBe(true)
    expect(isAlarming(record({ status: 'failed' }), 'failed')).toBe(true)
  })

  it('words listening-history imports differently', () => {
    const history = record({ kind: HISTORY_IMPORT_KIND, total: 3, done: 3, status: 'done' })
    expect(kindLabel(HISTORY_IMPORT_KIND)).toBe('Listening history')
    expect(statusText(history, 'done')).toBe('3 plays recorded')
    expect(countsText(history)).toBe('3 plays')
    const recording = record({ kind: HISTORY_IMPORT_KIND, total: 3, done: 1 })
    expect(statusText(recording, 'running')).toBe('Recording plays: 1 of 3')
    expect(statusText(recording, 'elsewhere')).toMatch(/^Recording plays in another tab/u)
    for (const status of ['interrupted', 'failed', 'paused', 'cancelled'] as const) {
      expect(statusText(recording, status)).toMatch(/no play is recorded twice/u)
    }
    expect(isAlarming(record({ kind: HISTORY_IMPORT_KIND, status: 'failed' }), 'failed')).toBe(
      false,
    )
  })

  it('counts an import and what its input left out', () => {
    expect(countsText(record())).toBe('100 songs: 30 matched · 8 to review · 2 failed')
    expect(countsText(record({ needsReview: 0, failed: 0 }))).toBe('100 songs: 30 matched')
    expect(skippedText(noSkips())).toBe('')
    expect(skippedText({ ...noSkips(), episodes: 1 })).toBe('1 podcast episode')
    expect(skippedText({ ...noSkips(), episodes: 2, localFiles: 1, shortPlays: 3 })).toBe(
      '2 podcast episodes, 1 local file and 3 plays shorter than 5 seconds',
    )
    expect(skippedText({ ...noSkips(), overLimit: 5000 })).toBe(
      '5,000 songs over the 20,000-song limit',
    )
    expect(kindLabel('spotify-export')).toBe('Spotify data')
    expect(kindLabel('something-new')).toBe('Import')
    expect(lengthText(185_000)).toBe('3:05')
    expect(lengthText(undefined)).toBe('')
  })
})
