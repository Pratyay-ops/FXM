import { type AudioCandidate, entityKey, formatId } from '@fxm/core'
import { Dexie } from 'dexie'
import { describe, expect, it } from 'vitest'
import { track } from '../test/library-fixtures'
import {
  type MatchCacheRecordV1,
  openDatabase,
  SCHEMA_V1,
  SCHEMA_VERSION,
  TABLE_NAMES,
  upgradeMatchRecord,
} from './database'
import { createLibraryRepo } from './repo'
import { DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID, PLAYLISTS_ORDER_ID } from './types'

let names = 0
const uniqueName = () => `fxm-migration-${++names}-${Math.random()}`

const song: AudioCandidate = {
  source: 'ytm',
  ref: 'songId',
  kind: 'song',
  title: 'Creep',
  artists: ['Radiohead'],
  confidence: 0.95,
  evidence: ['isrc'],
  signals: { isrcVerified: true, sourceAlbumMatch: true, releaseYear: 1993 },
}
const video: AudioCandidate = {
  ...song,
  ref: 'videoId',
  kind: 'music-video',
  evidence: ['title 0.9'],
}
const spotifyA = formatId('spotify', 'track', 'aaaaaaaaaaaaaaaaaaaaaa')
const spotifyB = formatId('spotify', 'track', 'bbbbbbbbbbbbbbbbbbbbbb')
const spotifyC = formatId('spotify', 'track', 'cccccccccccccccccccccc')

/** Writes a library the way version 1 of the app did, then closes it. */
async function writeVersion1(name: string) {
  const v1 = new Dexie(name)
  v1.version(1).stores(SCHEMA_V1)
  const playlist = formatId('local', 'playlist', 'mine')
  await v1.table('tracks').bulkPut([
    { id: track(1).id, track: track(1), updatedAt: 1 },
    { id: track(2).id, track: track(2), updatedAt: 2 },
  ])
  await v1.table('likes').put({ key: entityKey(track(1).id), trackId: track(1).id, likedAt: 5 })
  await v1.table('playlists').bulkPut([
    {
      id: LIKED_PLAYLIST_ID,
      system: 'liked',
      name: 'Liked songs',
      createdAt: 0,
      updatedAt: 5,
      trackIds: [track(1).id],
      addedAt: {},
    },
    {
      id: DOWNLOADS_PLAYLIST_ID,
      system: 'downloads',
      name: 'Downloads',
      createdAt: 0,
      updatedAt: 0,
      trackIds: [],
      addedAt: {},
    },
    {
      id: playlist,
      name: 'Mine',
      createdAt: 3,
      updatedAt: 4,
      trackIds: [track(2).id, track(1).id],
      addedAt: { [track(2).id]: 3, [track(1).id]: 4 },
    },
  ])
  await v1.table('orders').put({
    id: PLAYLISTS_ORDER_ID,
    order: [playlist, LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID],
    updatedAt: 4,
  })
  await v1.table('history').add({
    trackId: track(2).id,
    playedAt: 10,
    playedMs: 1000,
    completed: false,
    skipped: true,
  })
  const decisions: MatchCacheRecordV1[] = [
    {
      key: entityKey(spotifyA),
      sourceTrackId: spotifyA,
      candidate: song,
      alternatives: [video],
      band: 'auto',
      decidedAt: 100,
      userOverride: false,
    },
    {
      key: entityKey(spotifyB),
      sourceTrackId: spotifyB,
      candidate: video,
      alternatives: [],
      band: 'suggest',
      decidedAt: 200,
      userOverride: true,
    },
    {
      key: entityKey(spotifyC),
      sourceTrackId: spotifyC,
      candidate: song,
      alternatives: [],
      band: 'suggest',
      decidedAt: 300,
      userOverride: false,
    },
  ]
  await v1.table('matchCache').bulkPut([...decisions, { key: 'garbage', band: 'auto' }])
  v1.close()
  return playlist
}

describe('library database', () => {
  it('creates the newest schema with the built-in playlists', async () => {
    const db = openDatabase(uniqueName())
    await db.open()
    expect(db.verno).toBe(SCHEMA_VERSION)
    expect(db.tables.map((table) => table.name).sort()).toEqual([...TABLE_NAMES].sort())
    expect((await db.playlists.toArray()).map((playlist) => playlist.system).sort()).toEqual([
      'downloads',
      'liked',
    ])
    expect(await db.orders.get(PLAYLISTS_ORDER_ID)).toMatchObject({
      order: [LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID],
    })
    db.close()
  })

  it('upgrades a version 1 library without losing anything', async () => {
    const name = uniqueName()
    const playlist = await writeVersion1(name)

    const db = openDatabase(name)
    const repo = createLibraryRepo(db, { now: () => 1000 })
    await db.open()

    expect(db.verno).toBe(2)
    expect(await db.tracks.count()).toBe(2)
    expect(await repo.isLiked(track(1).id)).toBe(true)
    expect((await repo.getPlaylistList()).items.map((item) => item.id)).toEqual([
      playlist,
      LIKED_PLAYLIST_ID,
      DOWNLOADS_PLAYLIST_ID,
    ])
    expect((await repo.getPlaylistView(playlist))?.rows.map((row) => row.id)).toEqual([
      track(2).id,
      track(1).id,
    ])
    expect(await repo.history()).toMatchObject([{ trackId: track(2).id, skipped: true }])
    expect(await db.importProgress.count()).toBe(0)
    db.close()
  })

  it('rewrites version 1 match decisions per catalog mode, with pins', async () => {
    const name = uniqueName()
    await writeVersion1(name)
    const db = openDatabase(name)
    await db.open()

    const rows = await db.matchCache.orderBy('decidedAt').toArray()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      key: `${entityKey(spotifyA)}|music`,
      sourceKey: entityKey(spotifyA),
      sourceTrackId: spotifyA,
      mode: 'music',
      band: 'auto',
      candidate: song,
      alternatives: [video],
      signals: song.signals,
      evidence: ['isrc'],
      userPinned: false,
      decidedAt: 100,
    })
    // A video only plays in Music + Video; the user's override becomes a pin.
    expect(rows[1]).toMatchObject({
      key: `${entityKey(spotifyB)}|all`,
      mode: 'all',
      userPinned: true,
    })
    // A Suggest guess stays unconfirmed.
    expect(rows[2]).toMatchObject({ band: 'suggest', userPinned: false })

    const repo = createLibraryRepo(db, { now: () => 400 })
    expect((await repo.getConfirmedMatch(spotifyA, 'music'))?.ref).toBe('songId')
    expect((await repo.getConfirmedMatch(spotifyB, 'all'))?.ref).toBe('videoId')
    expect(await repo.getConfirmedMatch(spotifyC, 'music')).toBeUndefined()
    expect(await db.matchCache.where('sourceKey').equals(entityKey(spotifyB)).count()).toBe(1)
    db.close()
  })

  it('drops unusable version 1 decisions', () => {
    expect(upgradeMatchRecord(null)).toBeNull()
    expect(upgradeMatchRecord({ sourceTrackId: 'nope', band: 'auto' })).toBeNull()
    expect(upgradeMatchRecord({ sourceTrackId: spotifyA, band: 'maybe' })).toBeNull()
    // An override without a candidate pins nothing.
    expect(
      upgradeMatchRecord({ sourceTrackId: spotifyA, band: 'none', userOverride: true }),
    ).toMatchObject({ mode: 'music', userPinned: false, alternatives: [], evidence: [] })
  })

  it('brings back a built-in playlist that went missing, on the next open', async () => {
    const name = uniqueName()
    const first = openDatabase(name)
    await first.playlists.delete(DOWNLOADS_PLAYLIST_ID)
    await first.playlists.update(LIKED_PLAYLIST_ID, (record) => {
      delete record.system
    })
    first.close()

    const db = openDatabase(name)
    expect(await db.playlists.get(DOWNLOADS_PLAYLIST_ID)).toMatchObject({ system: 'downloads' })
    expect(await db.playlists.get(LIKED_PLAYLIST_ID)).toMatchObject({ system: 'liked' })
    db.close()
  })
})
