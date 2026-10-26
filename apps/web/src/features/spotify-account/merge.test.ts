import { describe, expect, it } from 'vitest'
import { adoptedBase, listChanges, mergedField, placeNewTracks } from './merge'

describe('listChanges', () => {
  it("brings in Spotify's additions and removals since the last sync", () => {
    expect(listChanges(['a', 'b', 'c'], ['d', 'a', 'c', 'e'], ['a', 'b', 'c'])).toEqual({
      added: ['d', 'e'],
      removed: ['b'],
    })
  })

  it("keeps the user's own changes to the copy", () => {
    // The user took b out and added x: b stays out while Spotify keeps it, x stays in.
    expect(listChanges(['a', 'b'], ['a', 'b', 'c'], ['a', 'x'])).toEqual({
      added: ['c'],
      removed: [],
    })
    // Spotify removed a song the user had taken out already: nothing to do.
    expect(listChanges(['a', 'b'], ['a'], ['a'])).toEqual({ added: [], removed: [] })
    // Spotify added a song the user had added already: nothing to do.
    expect(listChanges(['a'], ['a', 'x'], ['a', 'x'])).toEqual({ added: [], removed: [] })
  })

  it('adds a song once, however often Spotify lists it', () => {
    expect(listChanges([], ['a', 'a', 'b'], [])).toEqual({ added: ['a', 'b'], removed: [] })
  })
})

describe('adoptedBase', () => {
  it('counts only what both hold as synced, so nothing of the copy is removed', () => {
    const base = adoptedBase(['a', 'b', 'c'], ['b', 'x'])
    expect(base).toEqual(['b'])
    expect(listChanges(base, ['a', 'b', 'c'], ['b', 'x'])).toEqual({
      added: ['a', 'c'],
      removed: [],
    })
  })
})

describe('placeNewTracks', () => {
  it('puts each new song right after the one Spotify has before it', () => {
    expect(
      placeNewTracks(['a', 'b', 'c'], ['a', 'n1', 'b', 'c', 'n2'], new Set(['n1', 'n2'])),
    ).toEqual(['a', 'n1', 'b', 'c', 'n2'])
  })

  it("keeps the user's order and follows it with the new songs", () => {
    // The user moved c to the top; n follows c wherever it is.
    expect(placeNewTracks(['c', 'a', 'b'], ['a', 'b', 'c', 'n'], new Set(['n']))).toEqual([
      'c',
      'n',
      'a',
      'b',
    ])
  })

  it('puts songs Spotify has first at the top, in its order (new likes)', () => {
    expect(placeNewTracks(['a', 'b'], ['n1', 'n2', 'a', 'b'], new Set(['n1', 'n2']))).toEqual([
      'n1',
      'n2',
      'a',
      'b',
    ])
  })

  it('keeps runs of new songs together, in Spotify order, after their anchor', () => {
    expect(
      placeNewTracks(['a', 'b'], ['a', 'n1', 'n2', 'gone', 'n3', 'b'], new Set(['n1', 'n2', 'n3'])),
    ).toEqual(['a', 'n1', 'n2', 'n3', 'b'])
  })

  it('places the new songs whether or not the list holds them already', () => {
    expect(placeNewTracks(['a', 'n'], ['n', 'a'], new Set(['n']))).toEqual(['n', 'a'])
    expect(placeNewTracks([], ['n1', 'n2'], new Set(['n1', 'n2']))).toEqual(['n1', 'n2'])
  })

  it('handles 10,000 songs at once', () => {
    const local = Array.from({ length: 10_000 }, (_, i) => `l${i}`)
    const added = Array.from({ length: 10_000 }, (_, i) => `n${i}`)
    const remote = local.flatMap((id, i) => [id, added[i] as string])
    const started = performance.now()
    const placed = placeNewTracks(local, remote, new Set(added))
    expect(performance.now() - started).toBeLessThan(500)
    expect(placed).toEqual(remote)
  })
})

describe('mergedField', () => {
  it("takes Spotify's change unless the user changed the field too", () => {
    expect(mergedField('Old', 'New', 'Old', false)).toBe('New')
    expect(mergedField('Old', 'New', 'Mine', false)).toBe('Mine')
    expect(mergedField('Old', 'Old', 'Mine', false)).toBe('Mine')
    expect(mergedField(undefined, 'Added', undefined, false)).toBe('Added')
    expect(mergedField<string | undefined>('Gone', undefined, 'Gone', false)).toBeUndefined()
  })

  it("keeps an adopted copy's own value", () => {
    expect(mergedField(undefined, 'Spotify', 'Copy', true)).toBe('Copy')
  })
})
