import { describe, expect, it } from 'vitest'
import { LIKED_PLAYLIST_ID } from '../../db/types'
import {
  COPY_SUFFIX,
  conflictCopyOf,
  conflictOriginalOf,
  type MergeInput,
  mergeSnapshots,
  nameBeforeCopy,
} from './merge'
import type { SyncSnapshot } from './snapshot'
import {
  follow,
  like,
  liked,
  order,
  P,
  pin,
  play,
  playlist,
  snap,
  T,
  trackRecord,
} from './testing/snapshots'

/** A three-way merge whose gist descends from the base. */
function merge(
  base: SyncSnapshot | undefined,
  local: SyncSnapshot,
  remote: SyncSnapshot,
  remoteFromBase = true,
) {
  const input: MergeInput = { base, local, remote, remoteFromBase }
  return mergeSnapshots(input)
}

const named = (snapshot: SyncSnapshot, name: string) =>
  snapshot.playlists.find((item) => item.name === name)

describe('mergeSnapshots: records with keys', () => {
  it('changes nothing when both sides are equal', () => {
    const library = snap({ likes: [like(1)], playlists: [playlist('Mix', [1, 2])] })
    const result = merge(library, library, library)
    expect(result.snapshot).toEqual(library)
    expect(result.copies).toEqual([])
    expect(result.notices).toEqual([])
  })

  it('takes a change made on either side', () => {
    const base = snap({ likes: [like(1)] })
    const changedHere = snap({ likes: [like(1), like(2)] })
    const changedThere = snap({ likes: [like(1), like(3)] })
    expect(merge(base, changedHere, base).snapshot.likes).toEqual([like(1), like(2)])
    expect(merge(base, base, changedThere).snapshot.likes).toEqual([like(1), like(3)])
    expect(merge(base, changedHere, changedThere).snapshot.likes).toEqual([
      like(1),
      like(2),
      like(3),
    ])
  })

  it('keeps a deletion made on one side, from either side', () => {
    const base = snap({ likes: [like(1), like(2)], follows: [follow('Band')] })
    const unlikedHere = snap({ likes: [like(1)], follows: [follow('Band')] })
    const unfollowedThere = snap({ likes: [like(1), like(2)] })
    // Unliked here: the gist still has it unchanged, so it stays unliked.
    expect(merge(base, unlikedHere, base).snapshot.likes).toEqual([like(1)])
    // Unfollowed on the other device: gone here too.
    expect(merge(base, base, unfollowedThere).snapshot.follows).toEqual([])
  })

  it('keeps a record the other side deleted when it changed here meanwhile', () => {
    const base = snap({ likes: [like(1, 1000)] })
    const relikedHere = snap({ likes: [like(1, 5000)] })
    const unlikedThere = snap({ likes: [] })
    expect(merge(base, relikedHere, unlikedThere).snapshot.likes).toEqual([like(1, 5000)])
    // And the other way round: re-liked there after an unlike here.
    expect(merge(base, unlikedThere, relikedHere).snapshot.likes).toEqual([like(1, 5000)])
  })

  it('infers no deletion from a gist that does not descend from the base', () => {
    const base = snap({ likes: [like(1), like(2)] })
    const remote = snap({ likes: [like(1)] })
    // The gist lacks like 2, but it was not made from this base: maybe overwritten.
    expect(merge(base, base, remote, false).snapshot.likes).toEqual([like(1), like(2)])
    // A deletion made here still counts.
    expect(merge(base, remote, base, false).snapshot.likes).toEqual([like(1)])
  })

  it('applies the backup import rules when both sides changed a record', () => {
    const base = snap({
      tracks: [trackRecord(1, 1000)],
      likes: [like(1, 1000)],
      pins: [pin('a', 'old', 1000)],
    })
    const local = snap({
      tracks: [trackRecord(1, 3000)],
      likes: [like(1, 2000)],
      pins: [pin('a', 'mine', 2000)],
    })
    const remote = snap({
      tracks: [trackRecord(1, 2000)],
      likes: [like(1, 3000)],
      pins: [pin('a', 'theirs', 3000)],
    })
    const { snapshot } = merge(base, local, remote)
    // The most recently saved metadata wins…
    expect(snapshot.tracks).toEqual([trackRecord(1, 3000)])
    // …a like here stays…
    expect(snapshot.likes).toEqual([like(1, 2000)])
    // …and of two pins the newer decision wins.
    expect(snapshot.pins.map((item) => item.candidate?.ref)).toEqual(['theirs'])
  })

  it('never deletes cached tracks', () => {
    const base = snap({ tracks: [trackRecord(1), trackRecord(2)] })
    const remote = snap({ tracks: [trackRecord(1)] })
    expect(merge(base, base, remote).snapshot.tracks).toEqual([trackRecord(1), trackRecord(2)])
    expect(merge(base, remote, base).snapshot.tracks).toEqual([trackRecord(1), trackRecord(2)])
  })

  it('carries a cleared history, and keeps plays made since on the other side', () => {
    const base = snap({ history: [play(1, 10), play(2, 20)] })
    const cleared = snap({ history: [] })
    const playedMore = snap({ history: [play(1, 10), play(2, 20), play(3, 30)] })
    expect(merge(base, cleared, playedMore).snapshot.history).toEqual([play(3, 30)])
    expect(merge(base, playedMore, cleared).snapshot.history).toEqual([play(3, 30)])
  })

  it('removes a pin the other device removed, and takes one it made', () => {
    const base = snap({ pins: [pin('a', 'x')] })
    expect(merge(base, base, snap()).snapshot.pins).toEqual([])
    expect(
      merge(base, base, snap({ pins: [pin('a', 'x'), pin('b', 'y')] })).snapshot.pins,
    ).toHaveLength(2)
  })
})

describe('mergeSnapshots: playlists', () => {
  it('combines songs added on both sides where each was added', () => {
    const base = snap({ playlists: [playlist('Mix', [1, 2, 3])] })
    // Here a song went to the top, there one went to the end.
    const local = snap({ playlists: [playlist('Mix', [9, 1, 2, 3], { updatedAt: 2000 })] })
    const remote = snap({ playlists: [playlist('Mix', [1, 2, 3, 8], { updatedAt: 3000 })] })
    const { snapshot, copies } = merge(base, local, remote)
    expect(named(snapshot, 'Mix')?.trackIds).toEqual([9, 1, 2, 3, 8].map(T))
    expect(named(snapshot, 'Mix')?.updatedAt).toBe(3000)
    expect(copies).toEqual([])
  })

  it('combines a removal on one side with an addition on the other', () => {
    const base = snap({ playlists: [playlist('Mix', [1, 2, 3])] })
    const local = snap({ playlists: [playlist('Mix', [1, 3], { updatedAt: 2000 })] })
    const remote = snap({ playlists: [playlist('Mix', [1, 2, 3, 4], { updatedAt: 3000 })] })
    expect(named(merge(base, local, remote).snapshot, 'Mix')?.trackIds).toEqual([1, 3, 4].map(T))
  })

  it('combines a rename on one side with a reorder on the other', () => {
    const base = snap({ playlists: [playlist('Mix', [1, 2, 3])] })
    const local = snap({
      playlists: [playlist('Mix', [1, 2, 3], { name: 'Road trip', updatedAt: 2000 })],
    })
    const remote = snap({ playlists: [playlist('Mix', [3, 2, 1], { updatedAt: 3000 })] })
    const { snapshot, copies } = merge(base, local, remote)
    expect(snapshot.playlists.find((item) => item.id === P('Mix'))).toMatchObject({
      name: 'Road trip',
      trackIds: [3, 2, 1].map(T),
    })
    expect(copies).toEqual([])
  })

  it('keeps both versions when both sides renamed it', () => {
    const base = snap({ playlists: [playlist('Mix', [1, 2])] })
    const local = snap({ playlists: [playlist('Mix', [1, 2], { name: 'Mine', updatedAt: 3000 })] })
    const theirs = playlist('Mix', [1, 2, 5], { name: 'Theirs', updatedAt: 2000 })
    const remote = snap({ playlists: [theirs] })
    const { snapshot, copies } = merge(base, local, remote)
    // This device's version stays where it was…
    expect(snapshot.playlists.find((item) => item.id === P('Mix'))).toMatchObject({
      name: 'Mine',
      trackIds: [1, 2].map(T),
    })
    // …and the other is kept whole as a copy.
    const copy = conflictCopyOf(theirs)
    expect(copies).toEqual([
      { originalId: P('Mix'), copyId: copy.id, name: `Theirs${COPY_SUFFIX}` },
    ])
    expect(snapshot.playlists.find((item) => item.id === copy.id)).toMatchObject({
      name: 'Theirs (other version)',
      trackIds: [1, 2, 5].map(T),
    })
  })

  it('keeps both versions when both sides reordered it differently', () => {
    const base = snap({ playlists: [playlist('Mix', [1, 2, 3])] })
    const local = snap({ playlists: [playlist('Mix', [3, 1, 2], { updatedAt: 2000 })] })
    const remote = snap({ playlists: [playlist('Mix', [2, 3, 1], { updatedAt: 3000 })] })
    const { snapshot, copies } = merge(base, local, remote)
    expect(snapshot.playlists.find((item) => item.id === P('Mix'))?.trackIds).toEqual(
      [3, 1, 2].map(T),
    )
    expect(copies).toHaveLength(1)
  })

  it('lets the newer order of Liked songs lead, without a copy', () => {
    const base = snap({ playlists: [liked([1, 2, 3])] })
    // A new like goes to the top.
    const local = snap({ playlists: [liked([4, 3, 1, 2], 2000)] })
    const remote = snap({ playlists: [liked([2, 3, 1], 3000)] })
    const { snapshot, copies } = merge(base, local, remote)
    expect(snapshot.playlists.find((item) => item.id === LIKED_PLAYLIST_ID)?.trackIds).toEqual(
      [4, 2, 3, 1].map(T),
    )
    expect(copies).toEqual([])
  })

  it('makes the same copy again for the same conflict, so a retried sync adds none', () => {
    const base = snap({ playlists: [playlist('Mix', [1])] })
    const local = snap({ playlists: [playlist('Mix', [1], { name: 'Mine', updatedAt: 2000 })] })
    const remote = snap({ playlists: [playlist('Mix', [1], { name: 'Theirs', updatedAt: 3000 })] })
    const first = merge(base, local, remote)
    // The push failed: the library holds the copy, the base is the old one.
    const second = merge(base, first.snapshot, remote)
    expect(second.copies).toEqual([])
    expect(second.snapshot.playlists).toHaveLength(first.snapshot.playlists.length)
  })

  it('keeps a playlist deleted on another device when it changed here, with a notice', () => {
    const base = snap({ playlists: [playlist('Mix', [1])] })
    const local = snap({ playlists: [playlist('Mix', [1, 2], { updatedAt: 2000 })] })
    const { snapshot, notices } = merge(base, local, snap())
    expect(named(snapshot, 'Mix')?.trackIds).toEqual([1, 2].map(T))
    expect(notices).toEqual([{ kind: 'kept-here', playlistId: P('Mix'), name: 'Mix' }])
  })

  it('brings back a playlist deleted here when it changed on another device', () => {
    const base = snap({ playlists: [playlist('Mix', [1])] })
    const remote = snap({ playlists: [playlist('Mix', [1, 2], { updatedAt: 2000 })] })
    const { snapshot, notices } = merge(base, snap(), remote)
    expect(named(snapshot, 'Mix')?.trackIds).toEqual([1, 2].map(T))
    expect(notices).toEqual([{ kind: 'restored', playlistId: P('Mix'), name: 'Mix' }])
  })

  it('deletes a playlist deleted on one side and unchanged on the other', () => {
    const base = snap({ playlists: [playlist('Mix', [1])] })
    expect(named(merge(base, snap(), base).snapshot, 'Mix')).toBeUndefined()
    expect(named(merge(base, base, snap()).snapshot, 'Mix')).toBeUndefined()
    // Not when the gist doesn't descend from the base.
    expect(named(merge(base, base, snap(), false).snapshot, 'Mix')).toBeDefined()
  })

  it('never deletes Liked songs', () => {
    const base = snap({ playlists: [liked([1])] })
    const remote = { ...snap(), playlists: [] }
    expect(merge(base, base, remote).snapshot.playlists.map((item) => item.id)).toContain(
      LIKED_PLAYLIST_ID,
    )
  })
})

describe('mergeSnapshots: the first sync, without a base', () => {
  it('merges as a backup import does: the newer playlist leads, the other’s songs follow', () => {
    const local = snap({ playlists: [playlist('Mix', [1, 2], { updatedAt: 2000 })] })
    const remote = snap({ playlists: [playlist('Mix', [2, 3], { updatedAt: 3000 })] })
    const { snapshot, copies } = merge(undefined, local, remote)
    expect(named(snapshot, 'Mix')?.trackIds).toEqual([2, 3, 1].map(T))
    expect(copies).toEqual([])
  })

  it('keeps both versions of a playlist whose names differ', () => {
    const local = snap({ playlists: [playlist('Mix', [1])] })
    const remote = snap({ playlists: [{ ...playlist('Mix', [1]), name: 'Party' }] })
    const { snapshot, copies } = merge(undefined, local, remote)
    expect(copies).toHaveLength(1)
    expect(snapshot.playlists.map((item) => item.name).sort()).toEqual([
      'Liked songs',
      'Mix',
      'Party (other version)',
    ])
  })

  it('adds everything only one side has, and keeps both sides’ likes, follows and plays', () => {
    const local = snap({ likes: [like(1, 1000)], history: [play(1, 10)], follows: [follow('A')] })
    const remote = snap({
      likes: [like(1, 5000), like(2)],
      history: [play(1, 10), play(2, 20)],
      follows: [follow('B')],
      playlists: [playlist('Theirs', [2])],
    })
    const { snapshot } = merge(undefined, local, remote)
    expect(snapshot.likes).toEqual([like(1, 1000), like(2)])
    expect(snapshot.history).toEqual([play(1, 10), play(2, 20)])
    expect(snapshot.follows.map((item) => item.name)).toEqual(['A', 'B'])
    expect(named(snapshot, 'Theirs')).toBeDefined()
  })
})

describe('mergeSnapshots: the list of playlists', () => {
  it('takes a reorder made on one side and places the other side’s new playlists', () => {
    const base = snap({ order: order([P('a'), P('b'), P('c')]) })
    const local = snap({ order: order([P('c'), P('a'), P('b')], 2000) })
    const remote = snap({ order: order([P('a'), P('n'), P('b'), P('c')], 3000) })
    expect(merge(base, local, remote).snapshot.order?.order).toEqual([
      P('c'),
      P('a'),
      P('n'),
      P('b'),
    ])
  })

  it('takes the gist’s order record whole when only it changed', () => {
    const base = snap({ order: order([P('a'), P('b')], 1000) })
    const remote = snap({ order: order([P('a'), P('b')], 2000) })
    expect(merge(base, base, remote).snapshot.order).toEqual(order([P('a'), P('b')], 2000))
  })

  it('puts a conflict copy right after its original', () => {
    const base = snap({ playlists: [playlist('Mix', [1])], order: order([P('Mix'), P('x')]) })
    const local = snap({
      playlists: [playlist('Mix', [1], { name: 'Mine', updatedAt: 2000 })],
      order: order([P('Mix'), P('x')]),
    })
    const remote = snap({
      playlists: [playlist('Mix', [1], { name: 'Theirs', updatedAt: 3000 })],
      order: order([P('Mix'), P('x')]),
    })
    const { snapshot, copies } = merge(base, local, remote)
    expect(snapshot.order?.order).toEqual([P('Mix'), copies[0]?.copyId, P('x')])
  })

  it('keeps this device’s order on a first sync, with the gist’s other playlists after it', () => {
    const local = snap({ order: order([P('b'), P('a')]) })
    const remote = snap({ order: order([P('a'), P('c'), P('b')], 5000) })
    expect(merge(undefined, local, remote).snapshot.order?.order).toEqual([P('b'), P('a'), P('c')])
  })
})

describe('mergeSnapshots: app settings', () => {
  it('takes a setting changed on one side and keeps this device’s choice when both changed', () => {
    const base = snap({ appSettings: { catalogMode: 'music', theme: 'dark' } })
    const local = snap({ appSettings: { catalogMode: 'all', theme: 'dark' } })
    const remote = snap({ appSettings: { catalogMode: 'music', theme: 'light' } })
    expect(merge(base, local, remote).snapshot.appSettings).toEqual({
      catalogMode: 'all',
      theme: 'light',
    })
    const both = snap({ appSettings: { catalogMode: 'music', theme: 'system' } })
    expect(merge(base, both, remote).snapshot.appSettings.theme).toBe('system')
  })

  it('keeps a setting from a newer FXM that this device does not know', () => {
    const base = snap({ appSettings: { theme: 'dark', spotify: true } })
    const local = snap({ appSettings: { theme: 'dark' } })
    expect(merge(base, local, base).snapshot.appSettings).toEqual({ theme: 'dark', spotify: true })
  })
})

describe('conflict copies', () => {
  it('derive their ID from the original, and lead back to it', () => {
    const version = playlist('Mix', [1, 2])
    const copy = conflictCopyOf(version)
    expect(copy.id).toMatch(/^local:playlist:pl-Mix~[0-9a-f]{10}$/)
    expect(conflictOriginalOf(copy.id)).toBe(P('Mix'))
    expect(conflictOriginalOf(conflictCopyOf(copy).id)).toBe(copy.id)
    expect(conflictOriginalOf(P('Mix'))).toBeUndefined()
    expect(conflictCopyOf(version).id).toBe(copy.id)
    expect(conflictCopyOf({ ...version, trackIds: [T(3)] }).id).not.toBe(copy.id)
  })

  it('keep their names within the length limit, and give the name back', () => {
    const long = conflictCopyOf(playlist('x'.repeat(100), [1]))
    expect(long.name.length).toBeLessThanOrEqual(100)
    expect(long.name.endsWith(COPY_SUFFIX)).toBe(true)
    expect(nameBeforeCopy('Mix (other version)')).toBe('Mix')
    expect(nameBeforeCopy('Mix')).toBe('Mix')
  })
})
