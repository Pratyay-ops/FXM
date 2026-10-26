import type { EntityId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { csvField, importReport, reportToCsv, reportToJson } from './report'
import {
  applyReview,
  createImportState,
  firstPendingRow,
  importBlockOf,
  importCounts,
  initialPlaylistTracks,
  isLikelyMatch,
  isRetryable,
  needsReview,
  nextPlaylistTrack,
  planReopen,
  planReview,
  playlistTrackIdOf,
  retryFailedRows,
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

  it('plans a decision without changing the state, so a failed library change loses nothing', () => {
    const state = stateWithResults()
    const before = structuredClone(state)
    const planned = planReview(state, 1, { action: 'confirm', ref: 'two00000000' }, 10)
    expect(planned.effect).toMatchObject({ type: 'place', track: { id: 'ytm:track:two00000000' } })
    expect(planned.result).toMatchObject({
      review: { action: 'confirmed', ref: 'two00000000', at: 10 },
      playlistTrackId: 'ytm:track:two00000000',
    })
    expect(state).toEqual(before)
  })

  it('takes decisions back: unpins, takes a placed song out, or forgets a skip', () => {
    const state = stateWithResults()
    state.results[2] = { outcome: 'review', best: candidate('three000000', 'Three', 'C', 0.7) }
    applyReview(state, 1, { action: 'confirm', ref: 'two00000000' }, 10)
    applyReview(state, 2, { action: 'confirm', ref: 'three000000' }, 11)
    applyReview(state, 0, { action: 'skip' }, 12)

    const placed = planReopen(state, 1)
    expect(placed.effect).toEqual({ type: 'unplace', trackId: 'ytm:track:two00000000' })
    expect(placed.result.review).toBeUndefined()
    expect(placed.result.playlistTrackId).toBeUndefined()
    expect(needsReview(placed.result)).toBe(true)

    const pinned = planReopen(state, 2)
    expect(pinned.effect).toMatchObject({
      type: 'unpin',
      sourceTrackId: 'spotify:track:0000000000000000000003',
      decision: { band: 'suggest', candidate: { ref: 'three000000' } },
    })
    expect(planReopen(state, 0).effect).toEqual({ type: 'none' })
    expect(() => planReopen(state, 3)).toThrow(RangeError)
    // A decided row is reopened before it is decided again.
    expect(() => applyReview(state, 1, { action: 'skip' }, 13)).toThrow(RangeError)

    // A song another row of the playlist has too stays in it.
    state.results[3] = {
      outcome: 'ready',
      playlistTrackId: 'ytm:track:two00000000' as EntityId<'track'>,
    }
    expect(planReopen(state, 1).effect).toEqual({ type: 'none' })
  })

  it('places the song of a video Music mode hides, and takes it out again', () => {
    const video = 'yt:track:videovideov' as EntityId<'track'>
    const state = createImportState('youtube', 'music', {
      name: 'V',
      rows: [{ title: 'Clip', artists: ['A'], trackId: video, kind: 'video' }],
    })
    state.results[0] = {
      outcome: 'review',
      best: candidate('songsongson', 'Clip', 'A', 0.7),
      playlistTrackId: video,
    }
    const effect = applyReview(state, 0, { action: 'confirm', ref: 'songsongson' }, 1)
    expect(effect).toMatchObject({ type: 'place', track: { id: 'ytm:track:songsongson' } })
    const reopened = planReopen(state, 0)
    expect(reopened.effect).toEqual({ type: 'unplace', trackId: 'ytm:track:songsongson' })
    expect(reopened.result.playlistTrackId).toBe(video)
  })

  it('puts failed rows, and unreviewed ones whose search was cut short, back in the queue', () => {
    const state = stateWithResults()
    state.results[3] = { outcome: 'failed', error: 'Network' }
    state.results[2] = { outcome: 'not-found', incomplete: true }
    state.results[1] = {
      outcome: 'review',
      incomplete: true,
      review: { action: 'skipped', at: 1 },
    }
    expect(state.results.map(isRetryable)).toEqual([false, false, true, true])
    expect(retryFailedRows(state)).toBe(2)
    expect(state.results[3]).toBeNull()
    expect(state.results[2]).toBeNull()
    expect(firstPendingRow(state)).toBe(2)
    expect(retryFailedRows(state)).toBe(0)
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
      { ...state, blocked: 'tired' },
    ]
    for (const value of broken) expect(sanitizeImportState(value)).toBeNull()
  })

  it('checks every field of a saved result, since a backup brings it back', () => {
    const state = stateWithResults()
    const withResult = (result: unknown) => ({ ...state, results: [result, null, null, null] })
    const good = state.results[1] as object
    const best = candidate('one00000000', 'One', 'A', 0.95)
    const broken = [
      { ...good, evidence: 5 },
      { ...good, evidence: [1] },
      { ...good, blockers: {} },
      { ...good, blockers: ['tired'] },
      { ...good, error: 4 },
      { ...good, lookup: 'elsewhere' },
      { ...good, noDuration: false },
      { ...good, incomplete: 'yes' },
      { ...good, cached: 1 },
      { ...good, review: { action: 'confirmed', at: 1 } },
      { ...good, review: { action: 'confirmed', ref: 'x', at: 'now' } },
      { ...good, extras: { a: { artwork: { url: 'javascript:alert(1)' } } } },
      { ...good, extras: { a: { artwork: { url: 'http://img.example/a.jpg' } } } },
      { ...good, extras: { a: { album: { name: 'LP', id: 7 } } } },
      { ...good, extras: { a: { album: { id: 'ytm:album:MPREb_x' } } } },
      { ...good, best: { ...best, kind: 'hologram' } },
      { ...good, best: { ...best, durationMs: '3:00' } },
      { ...good, best: { ...best, verdict: { band: 'auto', blockers: {}, matcherVersion: 1 } } },
      { ...good, alternatives: [{ ...best, signals: { isrcVerified: 'yes' } }] },
    ]
    for (const result of broken) {
      expect(sanitizeImportState(withResult(result)), JSON.stringify(result)).toBeNull()
    }
    expect(sanitizeImportState({ ...state, lookups: { 1: { source: 'spotify', isrc: 5 } } })).toBe(
      null,
    )
    const blocked = { ...state, blocked: 'offline' }
    expect(sanitizeImportState(blocked)?.blocked).toBe('offline')
    expect(importBlockOf(blocked)).toBe('offline')
    expect(importBlockOf(state)).toBeUndefined()
    expect(importBlockOf('nonsense')).toBeUndefined()
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
