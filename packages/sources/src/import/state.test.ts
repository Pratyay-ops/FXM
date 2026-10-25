import type { EntityId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { csvField, importReport, reportToCsv, reportToJson } from './report'
import {
  applyReview,
  createImportState,
  firstPendingRow,
  importCounts,
  initialPlaylistTracks,
  isLikelyMatch,
  needsReview,
  nextPlaylistTrack,
  playlistTrackIdOf,
  rowStatus,
  sanitizeImportState,
} from './state'
import { candidate } from './testing'
import type { ImportCollection, ImportState } from './types'

const collection: ImportCollection = {
  name: 'Mix',
  rows: [
    {
      title: 'One',
      artists: ['A'],
      trackId: 'spotify:track:0000000000000000000001' as EntityId<'track'>,
    },
    { title: 'Two', artists: ['B'] },
    {
      title: 'Three',
      artists: ['C'],
      trackId: 'spotify:track:0000000000000000000003' as EntityId<'track'>,
    },
    { title: '', artists: [], trackId: 'yt:track:aaaaaaaaaaa' as EntityId<'track'> },
  ],
}

function stateWithResults(): ImportState {
  const state = createImportState('csv', 'music', collection)
  state.results[0] = {
    outcome: 'matched',
    verdict: 'auto',
    best: candidate('one00000000', 'One', 'A', 0.95),
  }
  state.results[1] = {
    outcome: 'review',
    verdict: 'auto',
    best: candidate('two00000000', 'Two', 'B', 0.92),
    alternatives: [candidate('twoalt00000', 'Two (Live)', 'B', 0.5)],
    extras: { two00000000: { album: { name: 'LP' }, artwork: { url: 'https://img/two' } } },
    blockers: ['setting-off'],
  }
  state.results[2] = { outcome: 'not-found', verdict: 'none', evidence: ['nothing close'] }
  return state
}

describe('import state', () => {
  it('starts with every row waiting, and the catalog tracks in the playlist', () => {
    const state = createImportState('csv', 'music', collection)
    expect(state.results).toEqual([null, null, null, null])
    expect(firstPendingRow(state)).toBe(0)
    expect(initialPlaylistTracks(collection).map((track) => track.id)).toEqual([
      'spotify:track:0000000000000000000001',
      'spotify:track:0000000000000000000003',
    ])
    expect(importCounts(state)).toEqual({
      total: 4,
      done: 0,
      matched: 0,
      needsReview: 0,
      failed: 0,
    })
  })

  it('counts where rows stand, and says which wait for review', () => {
    const state = stateWithResults()
    expect(state.results.map(rowStatus)).toEqual(['matched', 'review', 'not-found', 'pending'])
    expect(firstPendingRow(state)).toBe(3)
    expect(importCounts(state)).toEqual({
      total: 4,
      done: 3,
      matched: 1,
      needsReview: 2,
      failed: 0,
    })
    expect(state.results.map(needsReview)).toEqual([false, true, true, false])
    expect(state.results.map(isLikelyMatch)).toEqual([false, true, false, false])
  })

  it('applies review decisions: a pin for catalog rows, a placement for the others', () => {
    const state = stateWithResults()
    expect(applyReview(state, 1, { action: 'confirm', ref: 'twoalt00000' }, 10)).toEqual({
      type: 'place',
      index: 1,
      track: expect.objectContaining({ id: 'ytm:track:twoalt00000', title: 'Two (Live)' }),
      before: 'spotify:track:0000000000000000000003',
    })
    expect(rowStatus(state.results[1])).toBe('confirmed')
    expect(playlistTrackIdOf(state.rows[1] as never, state.results[1])).toBe(
      'ytm:track:twoalt00000',
    )
    state.results[2] = { outcome: 'review', best: candidate('three000000', 'Three', 'C', 0.7) }
    expect(applyReview(state, 2, { action: 'confirm', ref: 'three000000' }, 11)).toMatchObject({
      type: 'pin',
      sourceTrackId: 'spotify:track:0000000000000000000003',
      candidate: { ref: 'three000000' },
    })
    expect(applyReview(state, 0, { action: 'skip' }, 12)).toEqual({ type: 'none' })
    expect(rowStatus(state.results[0])).toBe('skipped')
    expect(() => applyReview(state, 3, { action: 'skip' }, 13)).toThrow(RangeError)
    expect(() => applyReview(state, 1, { action: 'confirm', ref: 'nope' }, 13)).toThrow(RangeError)
  })

  it('places a song before the next row that has a playlist track', () => {
    const state = stateWithResults()
    expect(nextPlaylistTrack(state, 0)).toBe('spotify:track:0000000000000000000003')
    expect(nextPlaylistTrack(state, 2)).toBeNull()
  })

  it('reads saved progress back, and refuses anything it cannot resume', () => {
    const state = stateWithResults()
    expect(sanitizeImportState(JSON.parse(JSON.stringify(state)))).toEqual(state)
    const broken = [
      null,
      { ...state, version: 2 },
      { ...state, kind: 'mp3' },
      { ...state, mode: 'video' },
      { ...state, results: [null] },
      { ...state, rows: [{ title: 1, artists: [] }, ...state.rows.slice(1)] },
      { ...state, rows: [{ title: 'x', artists: [], trackId: 'nope' }, ...state.rows.slice(1)] },
      { ...state, results: [{ outcome: 'great' }, null, null, null] },
      { ...state, results: [{ outcome: 'matched', best: { ref: '' } }, null, null, null] },
      { ...state, lookups: { 0: { source: 'elsewhere' } } },
    ]
    for (const value of broken) expect(sanitizeImportState(value)).toBeNull()
  })
})

describe('importReport', () => {
  it('reports every row with its match and the totals', () => {
    const state = stateWithResults()
    applyReview(state, 1, { action: 'confirm', ref: 'two00000000' }, 10)
    const report = importReport(state, 'Mix')
    expect(report.totals).toMatchObject({
      rows: 4,
      pending: 1,
      matched: 1,
      confirmed: 1,
      notFound: 1,
      review: 0,
      likely: 0,
    })
    expect(report.rows[1]).toMatchObject({
      position: 2,
      status: 'confirmed',
      verdict: 'auto',
      confidence: 0.92,
      match: { id: 'ytm:track:two00000000', title: 'Two', artists: ['B'] },
      blockers: ['setting-off'],
    })
    expect(report.rows[3]).toMatchObject({ position: 4, status: 'pending' })
  })

  it('writes CSV a spreadsheet opens safely, and JSON', () => {
    const state = createImportState('csv', 'music', {
      name: 'X',
      rows: [{ title: '=HYPERLINK("http://evil")', artists: ['A, B', 'C'], durationMs: 61_000 }],
    })
    state.results[0] = { outcome: 'failed', error: 'Line\nbreak' }
    const csv = reportToCsv(importReport(state, 'X'))
    const [header, line] = csv.split('\r\n')
    expect(header?.startsWith('Position,Title,Artists')).toBe(true)
    expect(line).toBe(
      `1,"'=HYPERLINK(""http://evil"")","A, B; C",,1:01,Failed,,,,,,,,no,,no,,,"Line\nbreak"`,
    )
    expect(csvField('-1')).toBe("'-1")
    expect(csvField(undefined)).toBe('')
    expect(JSON.parse(reportToJson(importReport(state, 'X')))).toMatchObject({
      format: 'fxm-import-report',
      version: 1,
      label: 'X',
      totals: { failed: 1 },
    })
  })
})
