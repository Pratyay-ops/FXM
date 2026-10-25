import { describe, expect, it } from 'vitest'
import {
  applyModeFilter,
  CATALOG_MODE_LABELS,
  CATALOG_MODES,
  type CatalogMode,
  DEFAULT_CATALOG_MODE,
  isCatalogMode,
  isVideoKind,
  type ModeVerdict,
  modePolicy,
} from './mode'
import type { TrackKind } from './model'

const KINDS = ['song', 'music-video', 'video', 'episode'] as const satisfies readonly TrackKind[]

describe('modePolicy', () => {
  const table: ReadonlyArray<readonly [TrackKind, CatalogMode, ModeVerdict]> = [
    ['song', 'music', 'playable'],
    ['music-video', 'music', 'needs-song-match'],
    ['video', 'music', 'hidden'],
    ['episode', 'music', 'hidden'],
    ['song', 'all', 'playable'],
    ['music-video', 'all', 'playable'],
    ['video', 'all', 'playable'],
    ['episode', 'all', 'hidden'],
  ]

  it.each(table)('a %s in %s mode is %s', (kind, mode, verdict) => {
    expect(modePolicy({ kind }, mode)).toBe(verdict)
  })

  it('covers every kind in every mode', () => {
    expect(table).toHaveLength(KINDS.length * CATALOG_MODES.length)
    for (const kind of KINDS) {
      for (const mode of CATALOG_MODES) {
        expect(table.some(([k, m]) => k === kind && m === mode)).toBe(true)
      }
    }
  })

  it('fails closed on bad data', () => {
    expect(modePolicy({ kind: 'podcast' as TrackKind }, 'all')).toBe('hidden')
    expect(modePolicy({ kind: 'video' }, 'everything' as CatalogMode)).toBe('hidden')
    expect(modePolicy({ kind: 'song' }, 'everything' as CatalogMode)).toBe('playable')
    expect(modePolicy({ kind: 'music-video' }, 'everything' as CatalogMode)).toBe(
      'needs-song-match',
    )
  })
})

describe('applyModeFilter', () => {
  const items = [
    { kind: 'video', ref: 'a' },
    { kind: 'song', ref: 'b' },
    { kind: 'episode', ref: 'c' },
    { kind: 'music-video', ref: 'd' },
    { kind: 'song', ref: 'e' },
    { kind: 'video', ref: 'f' },
  ] as const

  it('keeps songs and music videos awaiting a match in Music mode, in order', () => {
    expect(applyModeFilter(items, 'music').map((item) => item.ref)).toEqual(['b', 'd', 'e'])
  })

  it('keeps everything but episodes in Music + Video mode, in order', () => {
    expect(applyModeFilter(items, 'all').map((item) => item.ref)).toEqual(['a', 'b', 'd', 'e', 'f'])
  })

  it('returns a new array and keeps the item type', () => {
    const input = [{ kind: 'song' as const, title: 'x' }]
    const output = applyModeFilter(input, 'music')
    expect(output).not.toBe(input)
    expect(output[0]?.title).toBe('x')
  })

  it('handles an empty list', () => {
    expect(applyModeFilter([], 'music')).toEqual([])
  })
})

describe('isVideoKind', () => {
  it.each([
    ['song', false],
    ['music-video', true],
    ['video', true],
    ['episode', false],
  ] as const)('%s is a video: %s', (kind, expected) => {
    expect(isVideoKind(kind)).toBe(expected)
  })
})

describe('catalog modes', () => {
  it('labels the modes for the UI', () => {
    expect(CATALOG_MODE_LABELS).toEqual({ music: 'Music', all: 'Music + Video' })
    expect(Object.isFrozen(CATALOG_MODE_LABELS)).toBe(true)
  })

  it('starts in Music mode', () => {
    expect(DEFAULT_CATALOG_MODE).toBe('music')
  })

  it.each([
    ['music', true],
    ['all', true],
    ['video', false],
    ['Music', false],
    ['', false],
    [undefined, false],
    [1, false],
  ])('isCatalogMode(%j) is %s', (value, expected) => {
    expect(isCatalogMode(value)).toBe(expected)
  })
})
