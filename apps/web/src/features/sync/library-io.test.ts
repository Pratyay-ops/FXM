import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { DOWNLOADS_PLAYLIST_ID, PLAYLISTS_ORDER_ID } from '../../db/types'
import { testRepo, track, tracks } from '../../test/library-fixtures'
import {
  keepBothVersions,
  keepOtherVersion,
  listConflicts,
  mergeIntoLibrary,
  readLibrarySnapshot,
} from './library-io'
import { conflictCopyOf } from './merge'

const settings = { catalogMode: 'music', theme: 'dark' }
const spotify = formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC')
const candidate = {
  source: 'ytm' as const,
  ref: 'song',
  kind: 'song' as const,
  title: 'Song',
  artists: ['Band'],
  confidence: 0.9,
  evidence: ['isrc'],
}

describe('readLibrarySnapshot', () => {
  it('reads what sync carries and leaves out what stays on the device', async () => {
    const repo = testRepo()
    const mix = await repo.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    await repo.shuffleOrder(mix)
    await repo.addDownload(track(4))
    await repo.recordMatch({ sourceTrackId: spotify, mode: 'music', band: 'auto', candidate })
    await repo.pinMatch(spotify, 'all', candidate)
    await repo.startImport({ kind: 'csv', label: 'list.csv', total: 1 })

    const snapshot = await readLibrarySnapshot(repo, settings)

    expect(snapshot.playlists.map((item) => item.name).sort()).toEqual(['Liked songs', 'Mix'])
    expect(snapshot.playlists.every((item) => item.undo === undefined)).toBe(true)
    expect(snapshot.pins.map((item) => item.mode)).toEqual(['all'])
    expect(snapshot.appSettings).toEqual(settings)
  })

  it('reads only the plays since a time, and only the tracks the rest uses', async () => {
    const repo = testRepo()
    await repo.like(track(1))
    await repo.saveTracks([track(2), track(3)])
    await repo.addDownload(track(4))
    for (const [n, playedAt] of [
      [5, 1000],
      [6, 5000],
    ] as const) {
      await repo.recordPlay({
        track: track(n),
        playedAt,
        playedMs: 1,
        completed: true,
        skipped: false,
      })
    }
    const snapshot = await readLibrarySnapshot(repo, settings, {
      historySince: 2000,
      tracks: [track(3).id],
    })
    expect(snapshot.history.map((entry) => entry.trackId)).toEqual([track(6).id])
    // The like's and the play's tracks, and the one asked for; not the rest of the cache.
    expect(snapshot.tracks.map((row) => row.id).sort()).toEqual(
      [track(1).id, track(3).id, track(6).id].sort(),
    )
  })
})

describe('mergeIntoLibrary', () => {
  it('writes the merge and leaves Downloads, engine decisions and imports alone', async () => {
    const repo = testRepo()
    await repo.addDownload(track(4))
    await repo.recordMatch({ sourceTrackId: spotify, mode: 'music', band: 'auto', candidate })
    const job = await repo.startImport({ kind: 'csv', label: 'list.csv', total: 1 })
    const other = testRepo()
    await other.createPlaylist({ name: 'Theirs', tracks: [track(1)] })
    await other.like(track(2))
    const remote = await readLibrarySnapshot(other, settings)

    const merged = await mergeIntoLibrary(repo, {
      remote,
      remoteFromBase: false,
      appSettings: settings,
    })

    expect(merged.changed).toBeGreaterThan(0)
    expect((await repo.getPlaylistList()).items.map((item) => item.name)).toContain('Theirs')
    expect(await repo.isLiked(track(2).id)).toBe(true)
    expect(await repo.getOrder(DOWNLOADS_PLAYLIST_ID)).toEqual([track(4).id])
    expect(await repo.getMatch(spotify, 'music')).toMatchObject({ band: 'auto' })
    expect(await repo.getImport(job.id)).toBeDefined()
  })

  it('keeps an undo order the merge didn’t touch, and drops one it replaced', async () => {
    const repo = testRepo()
    const mix = await repo.createPlaylist({ name: 'Mix', tracks: tracks(4) })
    const road = await repo.createPlaylist({ name: 'Road', tracks: tracks(3) })
    await repo.shuffleOrder(mix)
    await repo.shuffleOrder(road)
    const base = await readLibrarySnapshot(repo, settings)
    const remote = structuredClone(base)
    // On the other device, Mix was renamed and Road reordered.
    const remoteMix = remote.playlists.find((item) => item.id === mix)
    const remoteRoad = remote.playlists.find((item) => item.id === road)
    if (remoteMix === undefined || remoteRoad === undefined) throw new Error('missing')
    remoteMix.name = 'Mix 2'
    remoteMix.updatedAt += 10_000
    remoteRoad.trackIds = [...remoteRoad.trackIds].reverse()
    remoteRoad.updatedAt += 10_000

    await mergeIntoLibrary(repo, { base, remote, remoteFromBase: true, appSettings: settings })

    expect((await repo.getPlaylistView(mix))?.playlist).toMatchObject({ name: 'Mix 2' })
    expect((await repo.getPlaylistView(mix))?.playlist.undo).toBeDefined()
    expect((await repo.getPlaylistView(road))?.playlist.undo).toBeUndefined()
  })

  it('keeps the cover of a local file, which sync doesn’t carry', async () => {
    const repo = testRepo()
    const cover = { url: 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4', width: 128, height: 128 }
    const song = track(1, {
      id: formatId('local', 'track', '0123456789abcdef'),
      source: 'local',
      artwork: [cover],
    })
    await repo.like(song)
    const base = await readLibrarySnapshot(repo, settings)
    // The gist never holds the `data:` URL.
    expect(base.tracks.map((row) => row.track.artwork)).toEqual([[]])
    // Another device with the same folder read the file's tags again.
    const remote = structuredClone(base)
    const [row] = remote.tracks
    if (row === undefined) throw new Error('missing')
    row.track.title = 'Song 1 (Live)'
    row.updatedAt += 10_000

    await mergeIntoLibrary(repo, { base, remote, remoteFromBase: true, appSettings: settings })

    expect(await repo.getTrack(song.id)).toMatchObject({ title: 'Song 1 (Live)', artwork: [cover] })
  })

  it('replaces a play the other side holds differently instead of adding it twice', async () => {
    const repo = testRepo()
    await repo.recordPlay({
      track: track(1),
      playedAt: 5000,
      playedMs: 1000,
      completed: false,
      skipped: true,
    })
    const base = await readLibrarySnapshot(repo, settings)
    const remote = structuredClone(base)
    const [play] = remote.history
    if (play === undefined) throw new Error('missing')
    play.playedMs = 180_000
    play.completed = true

    await mergeIntoLibrary(repo, { base, remote, remoteFromBase: true, appSettings: settings })

    const history = await repo.history()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ playedMs: 180_000, completed: true })
  })

  it('writes nothing when what it would remove is refused', async () => {
    const repo = testRepo()
    await repo.like(track(1))
    await repo.like(track(2))
    const base = await readLibrarySnapshot(repo, settings)
    const remote = { ...base, likes: [] }
    await expect(
      mergeIntoLibrary(repo, {
        base,
        remote,
        remoteFromBase: true,
        appSettings: settings,
        checkRemovals: (removed) => {
          expect(removed).toMatchObject({ likes: 2 })
          throw new Error('Ask first')
        },
      }),
    ).rejects.toThrow('Ask first')
    expect(await repo.isLiked(track(1).id)).toBe(true)
    expect(await repo.isLiked(track(2).id)).toBe(true)
  })

  it('removes a pin removed on the other side, but never the engine’s own decision', async () => {
    const repo = testRepo()
    await repo.pinMatch(spotify, 'music', candidate)
    const base = await readLibrarySnapshot(repo, settings)
    const remote = { ...base, pins: [] }
    await mergeIntoLibrary(repo, { base, remote, remoteFromBase: true, appSettings: settings })
    expect(await repo.getMatch(spotify, 'music')).toBeUndefined()

    // An engine decision is not a pin: a merge without pins leaves it.
    await repo.recordMatch({ sourceTrackId: spotify, mode: 'music', band: 'auto', candidate })
    await mergeIntoLibrary(repo, { base, remote, remoteFromBase: true, appSettings: settings })
    expect(await repo.getMatch(spotify, 'music')).toMatchObject({ userPinned: false })
  })
})

describe('settling a conflict', () => {
  async function withConflict() {
    const repo = testRepo()
    const mix = await repo.createPlaylist({ name: 'Mix', tracks: tracks(2) })
    await repo.createPlaylist({ name: 'Other' })
    const record = (await repo.getPlaylistView(mix))?.playlist
    if (record === undefined) throw new Error('missing')
    const copy = conflictCopyOf({
      ...record,
      name: 'Party',
      description: 'From the other device',
      trackIds: [track(3).id],
      addedAt: { [track(3).id]: 7 },
    })
    await repo.db.playlists.put(copy)
    const order = await repo.db.orders.get(PLAYLISTS_ORDER_ID)
    await repo.db.orders.put({
      id: PLAYLISTS_ORDER_ID,
      order: [mix, copy.id, ...(order?.order ?? []).filter((id) => id !== mix)],
      updatedAt: 1,
    })
    return { repo, mix, copy }
  }

  it('lists conflicts whose original is still there', async () => {
    const { repo, mix, copy } = await withConflict()
    expect(await listConflicts(repo)).toEqual([
      { original: { id: mix, name: 'Mix' }, copy: { id: copy.id, name: 'Party (other version)' } },
    ])
    await repo.deletePlaylist(mix)
    expect(await listConflicts(repo)).toEqual([])
  })

  it('keeps the other version in the original playlist', async () => {
    const { repo, mix, copy } = await withConflict()
    expect(await keepOtherVersion(repo, copy.id, 99)).toBe(mix)
    const view = await repo.getPlaylistView(mix)
    expect(view?.playlist).toMatchObject({
      name: 'Party',
      description: 'From the other device',
      trackIds: [track(3).id],
      addedAt: { [track(3).id]: 7 },
      updatedAt: 99,
    })
    expect(await repo.getPlaylistView(copy.id)).toBeUndefined()
    expect(await repo.getOrder(PLAYLISTS_ORDER_ID)).not.toContain(copy.id)
  })

  it('keeps both versions by giving the copy an ID of its own, in its place', async () => {
    const { repo, mix, copy } = await withConflict()
    const id = await keepBothVersions(repo, copy.id, { now: 99, uuid: () => 'fresh' })
    expect(id).toBe(formatId('local', 'playlist', 'fresh'))
    expect((await repo.getPlaylistView(id))?.playlist.name).toBe('Party (other version)')
    expect(await repo.getPlaylistView(copy.id)).toBeUndefined()
    const order = await repo.getOrder(PLAYLISTS_ORDER_ID)
    expect(order.indexOf(id)).toBe(order.indexOf(mix) + 1)
    expect(await listConflicts(repo)).toEqual([])
  })

  it('says when the version is gone already', async () => {
    const { repo, copy } = await withConflict()
    await repo.deletePlaylist(copy.id)
    await expect(keepOtherVersion(repo, copy.id)).rejects.toMatchObject({ code: 'not-found' })
  })
})
