import { describe, expect, it } from 'vitest'
import type { RootStatus } from './local-files'
import {
  blockedRootsOf,
  needsAttention,
  scanSummary,
  scanText,
  sourcesSummary,
  statusText,
} from './root-status'
import type { LocalRootRecord } from './types'

const MUSIC: LocalRootRecord = {
  id: 'music',
  kind: 'folder',
  name: 'Music',
  addedAt: 1,
  scannedAt: Date.now(),
}
const TUNES: LocalRootRecord = { id: 'tunes', kind: 'picked-folder', name: 'Tunes', addedAt: 2 }
const CHOSEN: LocalRootRecord = {
  id: 'chosen',
  kind: 'picked-files',
  name: 'Chosen files',
  addedAt: 3,
}

const OUTCOME = { added: 0, updated: 0, unchanged: 0, moved: 0, skipped: {} }

describe('what a scan says', () => {
  it('has no total until the walk is over', () => {
    expect(scanText({ state: 'queued' })).toBe('Waiting to scan…')
    expect(scanText({ state: 'scanning', found: 0, read: 0, walked: false })).toBe(
      'Looking for music…',
    )
    expect(scanText({ state: 'scanning', found: 40, read: 12, walked: false })).toBe(
      'Read 12 files…',
    )
    expect(scanText({ state: 'scanning', found: 1340, read: 12, walked: true })).toBe(
      'Reading files: 12 of 1,340',
    )
  })

  it('tells what a finished scan found', () => {
    expect(scanSummary(MUSIC, OUTCOME, 8, 'Added')).toBe('Added “Music”: 8 songs')
    expect(scanSummary(MUSIC, { ...OUTCOME, skipped: { unsupported: 2 } }, 8, 'Found')).toBe(
      'Found “Music”: 8 songs. 2 files can’t be played here',
    )
    expect(scanSummary(MUSIC, OUTCOME, 0, 'Added')).toBe('No music files were found in “Music”')
    expect(scanSummary(MUSIC, { ...OUTCOME, skipped: { unreadable: 1 } }, 0, 'Added')).toBe(
      'No songs FXM can play in “Music”: 1 file can’t be played here',
    )
    // Chosen files add up: what this pick brought.
    expect(scanSummary(CHOSEN, { ...OUTCOME, added: 2, unchanged: 1 }, 9, 'Added')).toBe(
      'Added 3 songs',
    )
    expect(scanSummary(CHOSEN, OUTCOME, 9, 'Added')).toBe('None of those files can be played here')
  })
})

describe('roots', () => {
  it('says what each needs, and which need the user', () => {
    const needs: [RootStatus, string, boolean][] = [
      [{ state: 'needs-access' }, 'FXM needs your permission to read this folder again', true],
      [{ state: 'denied' }, 'You didn’t allow FXM to read this folder', true],
      [{ state: 'missing' }, 'This folder was moved or deleted', true],
      [{ state: 'failed', message: 'Disk on fire' }, 'Disk on fire', true],
      [{ state: 'queued' }, 'Waiting to scan…', false],
    ]
    for (const [status, text, attention] of needs) {
      expect(statusText(MUSIC, status, 3)).toBe(text)
      expect(needsAttention(status)).toBe(attention)
    }
    expect(statusText(TUNES, { state: 'unavailable' }, 3)).toBe(
      'Choose this folder again to play its songs',
    )
    expect(statusText(MUSIC, { state: 'ready' }, 3)).toBe('3 songs · updated just now')
    expect(statusText(TUNES, { state: 'ready' }, 1)).toBe('1 song · until FXM reloads')
  })

  it('folds the folders into one line for phones', () => {
    const counts = new Map([
      ['music', 1204],
      ['tunes', 8],
    ])
    expect(sourcesSummary([MUSIC], {}, counts)).toBe('Music · 1,204 songs · updated just now')
    expect(
      sourcesSummary(
        [MUSIC],
        { music: { state: 'scanning', found: 9, read: 2, walked: true } },
        counts,
      ),
    ).toBe('Music · Reading files: 2 of 9')
    expect(sourcesSummary([MUSIC, TUNES], {}, counts)).toBe('Music and 1 more · 1,212 songs')
    expect(sourcesSummary([MUSIC, TUNES], { tunes: { state: 'queued' } }, counts)).toBe(
      'Music and 1 more · scanning…',
    )
    expect(sourcesSummary([], {}, counts)).toBe('')
  })

  it('knows whose songs can’t play now, and what to say', () => {
    const blocked = blockedRootsOf([MUSIC, TUNES, CHOSEN], {
      music: { state: 'needs-access' },
      tunes: { state: 'unavailable' },
      chosen: { state: 'unavailable' },
    })
    // A folder that only needs asking isn't blocked: a click on Play asks.
    expect([...blocked.keys()]).toEqual(['tunes', 'chosen'])
    expect(blocked.get('tunes')).toEqual({
      badge: 'Choose again',
      message: 'Choose “Tunes” again to play this song',
    })
    expect(blocked.get('chosen')?.message).toBe('Choose your files again to play this song')
    expect(blockedRootsOf([MUSIC], { music: { state: 'missing' } }).get('music')).toEqual({
      badge: 'Missing',
      message: '“Music” was moved or deleted. Find it again to play this song',
    })
    expect(blockedRootsOf([MUSIC], { music: { state: 'denied' } }).get('music')?.badge).toBe(
      'Choose again',
    )
  })
})
