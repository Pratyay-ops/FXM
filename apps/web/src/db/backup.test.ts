import { createSeededRandom, formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testRepo, track, tracks } from '../test/library-fixtures'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupError,
  backupBlob,
  backupFileName,
  exportLibrary,
  importLibrary,
  type LibraryBackup,
  parseBackup,
} from './backup'
import type { LibraryRepo } from './repo'
import { DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID, PLAYLISTS_ORDER_ID } from './types'

const spotify = formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC')

/** A library with something in every table and a custom order everywhere. */
async function richLibrary(repo: LibraryRepo) {
  const mix = await repo.createPlaylist({ name: 'Mix', description: 'Mine', tracks: tracks(6) })
  const road = await repo.createPlaylist({ name: 'Road trip', tracks: [track(7), track(8)] })
  await repo.moveItems(mix, [track(6).id, track(2).id], 'top')
  await repo.shuffleOrder(road)
  for (const n of [1, 3, 5, 7]) await repo.like(track(n))
  await repo.moveItems(LIKED_PLAYLIST_ID, [track(1).id], 'top')
  for (const n of [2, 4, 6]) await repo.addDownload(track(n))
  await repo.moveItems(DOWNLOADS_PLAYLIST_ID, [track(2).id], 'top')
  await repo.moveItems(PLAYLISTS_ORDER_ID, [LIKED_PLAYLIST_ID, mix], 'bottom')
  await repo.follow({
    id: formatId('ytm', 'artist', 'UC1'),
    source: 'ytm',
    name: 'Band',
    artwork: [],
  })
  await repo.follow({
    id: formatId('ytm', 'album', 'MPREb_1'),
    source: 'ytm',
    name: 'Record',
    artists: [{ name: 'Band' }],
    artwork: [{ url: 'https://example.com/a.jpg', width: 120, height: 120 }],
  })
  await repo.follow({
    id: formatId('ytm', 'playlist', 'PL1'),
    source: 'ytm',
    name: 'Hits',
    artwork: [],
    owner: { name: 'YouTube Music' },
  })
  await repo.recordPlay({ track: track(1), playedMs: 200_000, completed: true, skipped: false })
  await repo.recordPlay({
    track: track(2),
    playedMs: 10_000,
    completed: false,
    skipped: true,
    context: { type: 'playlist', id: mix, title: 'Mix' },
    stream: { source: 'ytm', codec: 'opus', container: 'webm', bitrateKbps: 160, tier: 'high' },
  })
  const candidate = {
    source: 'ytm' as const,
    ref: 'song',
    kind: 'song' as const,
    title: 'Song',
    artists: ['Band'],
    confidence: 0.7,
    evidence: ['title 0.9'],
    signals: { isrcVerified: false, sourceAlbumMatch: true, releaseYear: 1999 },
  }
  await repo.recordMatch({
    sourceTrackId: spotify,
    mode: 'music',
    isrc: 'GBARL9300135',
    band: 'suggest',
    candidate,
    alternatives: [{ ...candidate, ref: 'other' }],
  })
  await repo.pinMatch(spotify, 'all', { ...candidate, ref: 'pinned' })
  const job = await repo.startImport({ kind: 'csv', label: 'Exportify.csv', total: 10 })
  await repo.updateImport(job.id, { done: 4, matched: 3, state: { row: 4 } })
  await repo.db.settings.put({ key: 'reserved', value: { on: true }, updatedAt: 1 })
  return { mix, road }
}

describe('library backup', () => {
  it('round-trips: export, wipe, import gives the same library, orders included', async () => {
    const repo = testRepo({ random: createSeededRandom(4) })
    const { mix, road } = await richLibrary(repo)
    const before = await exportLibrary(repo, {
      appSettings: { catalogMode: 'all', theme: 'light' },
    })
    const ordersBefore = {
      playlists: await repo.getOrder(PLAYLISTS_ORDER_ID),
      mix: await repo.getOrder(mix),
      road: await repo.getOrder(road),
      liked: await repo.getOrder(LIKED_PLAYLIST_ID),
      downloads: await repo.getOrder(DOWNLOADS_PLAYLIST_ID),
    }
    const file = JSON.stringify(before)

    // A different device, or this one after its site data was cleared.
    const restored = testRepo()
    const parsed = parseBackup(file)
    expect(parsed.skipped).toBe(0)
    await importLibrary(restored, parsed, 'replace')

    const after = await exportLibrary(restored)
    expect(after.tables).toEqual(before.tables)
    expect(parsed.backup.appSettings).toEqual({ catalogMode: 'all', theme: 'light' })
    expect({
      playlists: await restored.getOrder(PLAYLISTS_ORDER_ID),
      mix: await restored.getOrder(mix),
      road: await restored.getOrder(road),
      liked: await restored.getOrder(LIKED_PLAYLIST_ID),
      downloads: await restored.getOrder(DOWNLOADS_PLAYLIST_ID),
    }).toEqual(ordersBefore)
    // The shuffle's undo survives too.
    expect(await restored.undoOrder(road)).toBe(true)
  })

  it('round-trips after wiping the same library', async () => {
    const repo = testRepo({ random: createSeededRandom(8) })
    await richLibrary(repo)
    const before = await exportLibrary(repo)
    await repo.clearLibrary()
    expect((await exportLibrary(repo)).tables).not.toEqual(before.tables)

    await importLibrary(repo, parseBackup(JSON.stringify(before)), 'replace')

    expect((await exportLibrary(repo)).tables).toEqual(before.tables)
  })

  it('describes itself and gets a dated file name', async () => {
    const backup = await exportLibrary(testRepo(), { now: new Date('2026-10-25T10:00:00Z') })
    expect(backup).toMatchObject({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '2026-10-25T10:00:00.000Z',
      app: { name: 'FXM' },
      schemaVersion: 2,
    })
    expect(backupFileName(new Date(2026, 9, 5))).toBe('fxm-library-2026-10-05.json')
    expect(backupBlob(backup).type).toBe('application/json')
  })

  it('replaces: the library becomes exactly the backup', async () => {
    const source = testRepo()
    const kept = await source.createPlaylist({ name: 'Kept', tracks: [track(1)] })
    const backup = await exportLibrary(source)

    const target = testRepo()
    await target.createPlaylist({ name: 'Local only' })
    await target.like(track(9))
    await importLibrary(target, parseBackup(JSON.stringify(backup)), 'replace')

    const names = (await target.getPlaylistList()).items.map((item) => item.name)
    expect(names).toEqual(['Kept', 'Liked songs', 'Downloads'])
    expect(await target.isLiked(track(9).id)).toBe(false)
    expect((await target.getPlaylistView(kept))?.rows.map((row) => row.id)).toEqual([track(1).id])
  })

  it('merges: keeps everything here and adds the backup on top', async () => {
    const backupRepo = testRepo()
    const shared = await backupRepo.createPlaylist({ name: 'Shared', tracks: tracks(3) })
    const onlyThere = await backupRepo.createPlaylist({ name: 'Only there' })
    await backupRepo.like(track(1))
    await backupRepo.recordPlay({
      track: track(1),
      playedAt: 500,
      playedMs: 1,
      completed: false,
      skipped: false,
    })
    await backupRepo.recordMatch({
      sourceTrackId: spotify,
      mode: 'music',
      band: 'auto',
      candidate: {
        source: 'ytm',
        ref: 'engine',
        kind: 'song',
        title: 'Song',
        artists: [],
        confidence: 0.95,
        evidence: [],
      },
    })
    const backup = await exportLibrary(backupRepo)

    // This device has the shared playlist too (as if restored earlier), edited since.
    const here = testRepo()
    await importLibrary(here, parseBackup(JSON.stringify(backup)), 'replace')
    await here.deletePlaylist(onlyThere)
    await here.addTracks(shared, [track(4)])
    await here.moveItems(shared, [track(4).id], 'top')
    await here.like(track(2))
    await here.pinMatch(spotify, 'music', {
      source: 'ytm',
      ref: 'mine',
      kind: 'song',
      title: 'Song',
      artists: [],
      confidence: 1,
      evidence: [],
    })
    const onlyHere = await here.createPlaylist({ name: 'Only here' })

    await importLibrary(here, parseBackup(JSON.stringify(backup)), 'merge')

    const list = (await here.getPlaylistList()).items.map((item) => item.name)
    expect(list).toEqual(['Only here', 'Shared', 'Liked songs', 'Downloads', 'Only there'])
    expect(await here.getOrder(shared)).toEqual([track(4).id, ...tracks(3).map((t) => t.id)])
    expect(await here.isLiked(track(1).id)).toBe(true)
    expect(await here.isLiked(track(2).id)).toBe(true)
    expect(await here.history()).toHaveLength(1)
    expect((await here.getConfirmedMatch(spotify, 'music'))?.ref).toBe('mine')
    expect(await here.getPlaylistView(onlyHere)).toBeDefined()
  })

  it('merges a playlist edited in both places with the newer edit leading', async () => {
    let clock = 1000
    const repo = testRepo({ now: () => ++clock, uuid: () => 'same' })
    const id = await repo.createPlaylist({ name: 'Old name', tracks: tracks(2) })
    const backup = await exportLibrary(repo)

    const later = JSON.parse(JSON.stringify(backup)) as LibraryBackup
    const playlist = later.tables.playlists.find((row) => row.id === id)
    if (!playlist) throw new Error('missing')
    Object.assign(playlist, {
      name: 'New name',
      updatedAt: 9999,
      trackIds: [track(3).id, track(2).id],
      addedAt: { [track(3).id]: 9000, [track(2).id]: 1 },
    })

    await importLibrary(repo, parseBackup(JSON.stringify(later)), 'merge')

    const view = await repo.getPlaylistView(id)
    expect(view?.playlist.name).toBe('New name')
    expect(view?.rows.map((row) => row.id)).toEqual([track(3).id, track(2).id, track(1).id])
    expect(view?.playlist.addedAt[track(2).id]).toBe(1)
  })

  it('refuses files that are not FXM backups or come from a newer FXM', () => {
    const fail = (text: string) => {
      try {
        parseBackup(text)
      } catch (error) {
        return error instanceof BackupError ? error.code : 'other'
      }
      return 'parsed'
    }
    expect(fail('{nope')).toBe('not-json')
    expect(fail('[]')).toBe('not-a-backup')
    expect(fail(JSON.stringify({ format: 'something-else', version: 1, tables: {} }))).toBe(
      'not-a-backup',
    )
    expect(fail(JSON.stringify({ format: BACKUP_FORMAT, version: 0, tables: {} }))).toBe(
      'not-a-backup',
    )
    expect(fail(JSON.stringify({ format: BACKUP_FORMAT, version: 2, tables: {} }))).toBe('too-new')
    expect(fail(JSON.stringify({ format: BACKUP_FORMAT, version: 1, tables: {} }))).toBe('parsed')
  })

  it('drops invalid records, counts them and never trusts derived fields', async () => {
    const id = formatId('local', 'playlist', 'p1')
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      tables: {
        tracks: [
          { id: track(1).id, track: track(1), updatedAt: 1 },
          { id: 'bad', track: { title: 'No id' } },
          {
            track: track(2, {
              artwork: [{ url: 'javascript:alert(1)' }, { url: 'https://x.dev/a.png' }],
            }),
            updatedAt: 2,
          },
        ],
        likes: [{ key: 'forged', trackId: track(1).id, likedAt: 3 }, { trackId: 42 }],
        playlists: [
          {
            id,
            system: 'downloads',
            name: 'x'.repeat(500),
            trackIds: [track(1).id, track(1).id, 'nope', track(2).id],
            addedAt: { [track(1).id]: 5, PROTO: { polluted: true }, nope: 7 },
          },
          { id: LIKED_PLAYLIST_ID, name: 'Renamed likes', trackIds: [] },
          { id: formatId('ytm', 'playlist', 'PL1'), name: 'Not local', trackIds: [] },
        ],
        orders: [{ id: 'other', order: [] }],
        history: [{ trackId: track(1).id, playedAt: -5 }],
        matchCache: [
          {
            sourceTrackId: spotify,
            mode: 'music',
            band: 'auto',
            userPinned: true,
            key: 'forged',
            alternatives: [],
            evidence: [],
          },
        ],
      },
    }).replace('"PROTO"', '"__proto__"')

    const { backup, skipped, summary } = parseBackup(text)

    // A track without an ID, a like without a track, a playlist of another source, an order
    // that isn't the playlists list, and a play at a negative time.
    expect(skipped).toBe(5)
    expect(backup.tables.tracks.map((row) => row.id)).toEqual([track(1).id, track(2).id])
    expect(backup.tables.tracks[1]?.track.artwork).toEqual([{ url: 'https://x.dev/a.png' }])
    expect(backup.tables.likes).toEqual([
      { key: 'youtube:track:video0001', trackId: track(1).id, likedAt: 3 },
    ])
    const [playlist, liked] = backup.tables.playlists
    expect(playlist?.system).toBeUndefined()
    expect(playlist?.name).toHaveLength(100)
    expect(playlist?.trackIds).toEqual([track(1).id, track(2).id])
    expect(playlist?.addedAt).toEqual({ [track(1).id]: 5 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(liked).toMatchObject({ system: 'liked', name: 'Liked songs' })
    // A pin needs a candidate; the key is recomputed.
    expect(backup.tables.matchCache[0]).toMatchObject({
      key: `${spotify}|music`,
      userPinned: false,
    })
    expect(summary).toEqual({ playlists: 1, likes: 1, follows: 0, plays: 0, tracks: 2 })

    const repo = testRepo()
    await importLibrary(repo, { backup, skipped, summary }, 'replace')
    expect((await repo.getPlaylistList()).items.map((item) => item.id)).toEqual([
      id,
      LIKED_PLAYLIST_ID,
      DOWNLOADS_PLAYLIST_ID,
    ])
  })

  it('leaves the library alone when an import fails halfway', async () => {
    const repo = testRepo()
    await repo.createPlaylist({ name: 'Precious', tracks: [track(1)] })
    const before = await exportLibrary(repo)
    const parsed = parseBackup(JSON.stringify(await exportLibrary(testRepo())))
    // A record IndexedDB can't store makes the write fail after the tables were cleared.
    parsed.backup.tables.playlists.push({ id: () => 0 } as never)

    await expect(importLibrary(repo, parsed, 'replace')).rejects.toThrow()

    expect((await exportLibrary(repo)).tables).toEqual(before.tables)
  })
})
