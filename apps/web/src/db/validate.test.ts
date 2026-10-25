import { describe, expect, it } from 'vitest'
import { track } from '../test/library-fixtures'
import { sanitizeHistoryRecord, sanitizeTrack } from './validate'

describe('the guards for the listening signals’ fields', () => {
  it('keeps a track’s tags trimmed, cut to 100 characters, without empty ones, at most 20', () => {
    const tags = [
      '  Hip-Hop ',
      '',
      7,
      'x'.repeat(101),
      ...Array.from({ length: 30 }, (_, n) => `t${n}`),
    ]
    const clean = sanitizeTrack({ ...track(1), tags })
    expect(clean?.tags?.slice(0, 2)).toEqual(['Hip-Hop', 'x'.repeat(100)])
    expect(clean?.tags).toHaveLength(20)
    expect(clean?.tags).not.toContain('')
    expect(sanitizeTrack({ ...track(1), tags: 'rock' })).not.toHaveProperty('tags')
    expect(sanitizeTrack({ ...track(1), tags: [' '] })).not.toHaveProperty('tags')
  })

  it('keeps a play’s length and import, when they are usable', () => {
    const play = {
      trackId: track(1).id,
      playedAt: 1000,
      playedMs: 5000,
      completed: false,
      skipped: true,
    }
    expect(sanitizeHistoryRecord({ ...play, durationMs: 181_000, importId: 'import-1' })).toEqual({
      ...play,
      durationMs: 181_000,
      importId: 'import-1',
    })
    const bad = sanitizeHistoryRecord({ ...play, durationMs: 0, importId: '' })
    expect(bad).not.toHaveProperty('durationMs')
    expect(bad).not.toHaveProperty('importId')
    expect(sanitizeHistoryRecord({ ...play, durationMs: -1, importId: 'x'.repeat(101) })).toEqual(
      play,
    )
  })
})
