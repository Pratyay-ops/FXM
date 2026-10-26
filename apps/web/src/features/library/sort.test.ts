import { describe, expect, it } from 'vitest'
import type { PlaylistSummary, TrackRow } from '../../db/repo'
import { track } from '../../test/library-fixtures'
import { addedLabel, artworkUrl, countLabel, playedLabel, totalDuration } from './format'
import { describeSort, directionLabel, sortPlaylists, sortTrackRows } from './sort'
import { dropTarget } from './sortable'

function row(n: number, overrides: Partial<TrackRow> = {}, trackFields = {}): TrackRow {
  return { id: track(n).id, track: track(n, trackFields), liked: false, ...overrides }
}

const titles = (rows: TrackRow[]) => rows.map((item) => item.track?.title ?? '?')

describe('sortTrackRows', () => {
  const rows = [
    row(1, { addedAt: 30 }, { title: 'beta', durationMs: 200, album: { name: 'Zed' } }),
    row(2, { addedAt: 10 }, { title: 'Alpha', durationMs: 300, album: { name: 'Ace' } }),
    row(3, { addedAt: 20 }, { title: 'Gamma 10', durationMs: 100, album: { name: 'Ace' } }),
    row(4, { addedAt: 40 }, { title: 'Gamma 9' }),
  ]

  it('keeps the custom order', () => {
    expect(titles(sortTrackRows(rows, { key: 'custom', direction: 'asc' }))).toEqual([
      'beta',
      'Alpha',
      'Gamma 10',
      'Gamma 9',
    ])
  })

  it('sorts titles ignoring case, with numbers in number order', () => {
    expect(titles(sortTrackRows(rows, { key: 'title', direction: 'asc' }))).toEqual([
      'Alpha',
      'beta',
      'Gamma 9',
      'Gamma 10',
    ])
    expect(titles(sortTrackRows(rows, { key: 'title', direction: 'desc' }))).toEqual([
      'Gamma 10',
      'Gamma 9',
      'beta',
      'Alpha',
    ])
  })

  it('sorts by date added and by duration, unknown durations last either way', () => {
    expect(titles(sortTrackRows(rows, { key: 'added', direction: 'desc' }))).toEqual([
      'Gamma 9',
      'beta',
      'Gamma 10',
      'Alpha',
    ])
    expect(titles(sortTrackRows(rows, { key: 'duration', direction: 'asc' })).slice(-1)).toEqual([
      'Gamma 9',
    ])
    const withoutDuration = rows.map((item, index) =>
      index === 3
        ? { ...item, track: { ...track(4), title: 'Gamma 9', durationMs: undefined } }
        : item,
    ) as TrackRow[]
    expect(titles(sortTrackRows(withoutDuration, { key: 'duration', direction: 'desc' }))).toEqual([
      'Alpha',
      'beta',
      'Gamma 10',
      'Gamma 9',
    ])
  })

  it('sorts by album, then by title, and keeps ties in the custom order', () => {
    expect(titles(sortTrackRows(rows, { key: 'album', direction: 'asc' }))).toEqual([
      'Alpha',
      'Gamma 10',
      'Gamma 9',
      'beta',
    ])
    const ties = [row(5, {}, { title: 'Same' }), row(6, {}, { title: 'Same' })]
    expect(sortTrackRows(ties, { key: 'title', direction: 'desc' }).map((item) => item.id)).toEqual(
      ties.map((item) => item.id),
    )
  })

  it('puts tracks without metadata last', () => {
    const missing: TrackRow = { id: track(9).id, liked: false }
    expect(
      sortTrackRows([missing, rows[0] as TrackRow], { key: 'title', direction: 'asc' })[1],
    ).toBe(missing)
  })
})

describe('sortPlaylists', () => {
  const playlist = (name: string, addedAt: number, trackCount?: number): PlaylistSummary => ({
    id: `local:playlist:${name}` as PlaylistSummary['id'],
    origin: 'local',
    name,
    artwork: [],
    addedAt,
    updatedAt: addedAt,
    ...(trackCount === undefined ? {} : { trackCount }),
  })
  const items = [playlist('b', 2, 5), playlist('A', 3, 1), playlist('c', 1)]

  it('sorts by name, date added and number of songs', () => {
    const names = (view: Parameters<typeof sortPlaylists>[1]) =>
      sortPlaylists(items, view).map((item) => item.name)
    expect(names({ key: 'name', direction: 'asc' })).toEqual(['A', 'b', 'c'])
    expect(names({ key: 'added', direction: 'desc' })).toEqual(['A', 'b', 'c'])
    expect(names({ key: 'tracks', direction: 'desc' })).toEqual(['b', 'A', 'c'])
    expect(names({ key: 'custom', direction: 'asc' })).toEqual(['b', 'A', 'c'])
  })
})

describe('sort labels', () => {
  it('names each direction for its field', () => {
    expect(directionLabel('title', 'asc')).toBe('A to Z')
    expect(directionLabel('added', 'desc')).toBe('Newest first')
    expect(directionLabel('duration', 'asc')).toBe('Shortest first')
    expect(directionLabel('tracks', 'desc')).toBe('Most first')
    expect(
      describeSort([{ key: 'added', label: 'Date added' }], { key: 'added', direction: 'asc' }),
    ).toBe('Sorted by date added, Oldest first')
  })
})

describe('dropTarget', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('drops after the item when moving down, before it when moving up', () => {
    expect(dropTarget(ids, 'a', 'c')).toEqual({ before: 'd' })
    expect(dropTarget(ids, 'a', 'd')).toEqual({ before: null })
    expect(dropTarget(ids, 'd', 'b')).toEqual({ before: 'b' })
  })

  it('changes nothing for a drop in place or on an unknown item', () => {
    expect(dropTarget(ids, 'b', 'b')).toBeNull()
    expect(dropTarget(ids, 'b', 'x')).toBeNull()
  })
})

describe('format', () => {
  it('counts and totals', () => {
    expect(countLabel(1, 'song')).toBe('1 song')
    expect(countLabel(1204, 'song')).toBe('1,204 songs')
    expect(totalDuration([60_000 * 65, undefined])).toBe('1 hr 5 min')
    expect(totalDuration([45 * 60_000])).toBe('45 min')
    expect(totalDuration([20_000])).toBe('under a minute')
    expect(totalDuration([undefined])).toBe('')
  })

  it('says when something was added or played', () => {
    const now = new Date(2026, 9, 25, 15, 0).getTime()
    expect(addedLabel(now - 60_000, now)).toBe('today')
    expect(addedLabel(new Date(2026, 9, 24, 23, 0).getTime(), now)).toBe('yesterday')
    expect(addedLabel(new Date(2026, 9, 21, 9, 0).getTime(), now)).toBe('4 days ago')
    expect(addedLabel(new Date(2026, 8, 1).getTime(), now)).toBe('Sep 1, 2026')
    expect(addedLabel(undefined, now)).toBe('')
    expect(playedLabel(now - 10_000, now)).toBe('just now')
    expect(playedLabel(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(playedLabel(now - 3 * 3_600_000, now)).toBe('3 hours ago')
  })

  it('picks the smallest artwork that is big enough', () => {
    const sizes = [
      { url: 'big', width: 544 },
      { url: 'small', width: 60 },
      { url: 'medium', width: 226 },
    ]
    expect(artworkUrl(sizes, 100)).toBe('medium')
    expect(artworkUrl(sizes, 1000)).toBe('big')
    expect(artworkUrl([], 100)).toBeUndefined()
  })
})
