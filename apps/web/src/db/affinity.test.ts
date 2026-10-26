import {
  AFFINITY_HALF_LIFE_MS,
  type AffinityEntry,
  affinityAt,
  DEFAULT_AFFINITY_WEIGHTS,
  type EntityId,
  formatId,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testRepo, track, tracks } from '../test/library-fixtures'
import { addedAtOf, affinityId, librarySignals } from './affinity'
import { exportLibrary, importLibrary, parseBackup } from './backup'
import type { LibraryRepo } from './repo'
import { DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID, type PlaylistRecord } from './types'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 1, 12)
const { like: LIKE, playlistAdd: ADD } = DEFAULT_AFFINITY_WEIGHTS

/** A test repository, which also hands out its database (`db`). */
type TestRepo = ReturnType<typeof testRepo>

/** A repository whose clock stands still until the test moves it. */
function setup(start = T0) {
  let clock = start
  const repo = testRepo({ now: () => clock })
  return {
    repo,
    now: () => clock,
    set(time: number) {
      clock = time
    },
  }
}

/** Every stored entry's affinity at `now`, by record ID. */
async function scores(repo: TestRepo, now: number) {
  const records = await repo.db.affinity.toArray()
  return Object.fromEntries(
    records.map((record) => {
      const { score, skips } = affinityAt(record, now)
      return [record.id, { score, skips, plays: record.plays }]
    }),
  )
}

/** The stored entry with `id`. */
async function stored(repo: TestRepo, id: string): Promise<AffinityEntry | undefined> {
  return repo.db.affinity.get(id)
}

const trackId = (n: number) =>
  affinityId('track', `youtube:track:video${String(n).padStart(4, '0')}`)
const artistId = (n: number) => affinityId('artist', `artist ${n}`)

describe('the listening affinity in the library', () => {
  it('grows with a like and forgets it when the like is taken back', async () => {
    const { repo, set } = setup()
    await repo.like(track(1))
    expect(await scores(repo, T0)).toEqual({
      [trackId(1)]: { score: LIKE, skips: 0, plays: 0 },
      [artistId(1)]: { score: LIKE, skips: 0, plays: 0 },
    })
    expect(await stored(repo, trackId(1))).toMatchObject({
      kind: 'track',
      label: 'Song 1',
      ids: [track(1).id],
      at: T0,
    })

    set(T0 + 40 * DAY)
    expect(await repo.unlike(track(1).id)).toBe(true)
    expect(await repo.db.affinity.count()).toBe(0)
    expect(await repo.unlike(track(1).id)).toBe(false)
  })

  it('follows a like toggled on and off', async () => {
    const { repo } = setup()
    expect(await repo.toggleLike(track(1))).toBe(true)
    expect((await stored(repo, trackId(1)))?.score).toBe(LIKE)
    expect(await repo.toggleLike(track(1))).toBe(false)
    expect(await stored(repo, trackId(1))).toBeUndefined()
  })

  it('scores tracks added to playlists, and takes removals back', async () => {
    const { repo, set } = setup()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1), track(2)] })
    set(T0 + DAY)
    await repo.addTracks(id, [track(2), track(3)])
    expect(await scores(repo, T0 + DAY)).toMatchObject({
      [trackId(1)]: { score: expect.closeTo(ADD * 2 ** (-1 / 14), 9) },
      [trackId(3)]: { score: ADD },
    })
    set(T0 + 2 * DAY)
    expect(await repo.removeTracks(id, [track(1).id, track(9).id])).toBe(1)
    expect(await stored(repo, trackId(1))).toBeUndefined()
    expect(await stored(repo, artistId(1))).toBeUndefined()
    expect(await stored(repo, trackId(2))).toBeDefined()
  })

  it('likes tracks added to Liked songs, and unlikes the ones removed from it', async () => {
    const { repo } = setup()
    expect(await repo.addTracks(LIKED_PLAYLIST_ID, [track(1), track(2)])).toEqual({
      added: 2,
      skipped: 0,
    })
    expect(await scores(repo, T0)).toMatchObject({
      [trackId(1)]: { score: LIKE },
      [trackId(2)]: { score: LIKE },
    })
    expect(await repo.removeTracks(LIKED_PLAYLIST_ID, [track(1).id])).toBe(1)
    expect(await stored(repo, trackId(1))).toBeUndefined()
    expect(await stored(repo, trackId(2))).toBeDefined()
  })

  it('forgets what a deleted playlist added, and counts a copy like any playlist', async () => {
    const { repo, set } = setup()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    set(T0 + DAY)
    const copy = await repo.duplicatePlaylist(id)
    // Both adds count from the day the track was first added.
    expect(await stored(repo, trackId(1))).toMatchObject({ at: T0, score: 2 * ADD })
    await repo.deletePlaylist(id)
    // The copy keeps the date the track was first added.
    expect((await scores(repo, T0))[trackId(1)]?.score).toBeCloseTo(ADD, 9)
    await repo.deletePlaylist(copy)
    expect(await repo.db.affinity.count()).toBe(0)
  })

  it('counts a download like a playlist add, until the download is deleted', async () => {
    const { repo } = setup()
    await repo.addDownload(track(1))
    await repo.addDownload(track(1))
    expect((await stored(repo, trackId(1)))?.score).toBe(ADD)
    await repo.removeDownload(track(1).id)
    expect(await stored(repo, trackId(1))).toBeUndefined()
  })

  it('forgets the downloads deleted in one batch, and only those', async () => {
    const { repo } = setup()
    for (const n of [1, 2, 3]) await repo.addDownload(track(n))
    expect(await repo.removeDownloads([track(1).id, track(2).id, track(9).id])).toBe(2)
    expect(await stored(repo, trackId(1))).toBeUndefined()
    expect(await stored(repo, artistId(2))).toBeUndefined()
    expect((await stored(repo, trackId(3)))?.score).toBe(ADD)
    expect(await repo.removeDownloads([])).toBe(0)
  })

  it('scores plays by the share played, and skips by the share left', async () => {
    const { repo } = setup()
    const song = track(1, { durationMs: 200_000 })
    await repo.recordPlay({ track: song, playedMs: 200_000, completed: true, skipped: false })
    await repo.recordPlay({
      track: song,
      playedAt: T0 - 1000,
      playedMs: 10_000,
      durationMs: 200_000,
      completed: false,
      skipped: true,
    })
    const entry = await stored(repo, trackId(1))
    expect(entry).toMatchObject({ plays: 2, lastPlayedAt: T0, at: T0 })
    // The skip came a second earlier, so it has faded a little by the time of the last play.
    const fade = 2 ** (-1000 / AFFINITY_HALF_LIFE_MS)
    expect(entry?.score).toBeCloseTo(1 + 0.05 * fade, 12)
    expect(entry?.skips).toBeCloseTo(0.95 * fade, 12)
    expect((await repo.history())[0]).toMatchObject({ durationMs: 200_000, skipped: true })
  })

  it('keys artists by name across sources, and scores tags', async () => {
    const { repo } = setup()
    const ytm: Track = track(1, {
      artists: [{ id: formatId('ytm', 'artist', 'UC1'), name: 'Band' }],
      tags: ['Hip-Hop'],
    })
    const spotify: Track = {
      ...track(2),
      id: formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC'),
      source: 'spotify',
      artists: [{ id: formatId('spotify', 'artist', 'band'), name: 'BAND' }],
      tags: ['hip hop'],
    }
    await repo.like(ytm)
    await repo.like(spotify)
    expect(await stored(repo, affinityId('artist', 'band'))).toMatchObject({
      score: 2 * LIKE,
      ids: ['spotify:artist:band', 'ytm:artist:UC1'],
    })
    expect(await stored(repo, affinityId('tag', 'hip hop'))).toMatchObject({ score: 2 * LIKE })
  })

  it('shares one entry between the two YouTube spellings of a track', async () => {
    const { repo } = setup()
    const ytm = track(1)
    const yt: Track = { ...ytm, id: formatId('yt', 'track', 'video0001'), source: 'yt' }
    await repo.like(ytm)
    await repo.recordPlay({ track: yt, playedMs: 181_000, completed: true, skipped: false })
    expect(await stored(repo, trackId(1))).toMatchObject({ score: LIKE + 1, plays: 1 })
  })

  it('reads the top entries now, and single entries by key', async () => {
    const { repo, set } = setup()
    await repo.like(track(1))
    set(T0 + 20 * DAY)
    for (const at of [1, 2, 3]) {
      await repo.recordPlay({
        track: track(2),
        playedAt: T0 + 20 * DAY - at,
        playedMs: 182_000,
        completed: true,
        skipped: false,
      })
    }
    const top = await repo.topAffinity('track')
    expect(top.map(({ entry }) => entry.label)).toEqual(['Song 2', 'Song 1'])
    expect(top[0]?.score).toBeCloseTo(3, 6)
    expect(top[1]?.score).toBeCloseTo(LIKE * 2 ** (-20 / 14), 9)
    expect((await repo.topAffinity('track', 1)).map(({ entry }) => entry.label)).toEqual(['Song 2'])
    expect(await repo.topAffinity('track', 0)).toEqual([])
    expect(await repo.topAffinity('tag')).toEqual([])

    set(T0 + 34 * DAY)
    const [song1, missing] = await repo.getAffinity('track', [
      'youtube:track:video0001',
      'youtube:track:video0404',
    ])
    expect(song1?.score).toBeCloseTo(LIKE * 2 ** (-34 / 14), 9)
    expect(missing).toBeUndefined()
    expect((await repo.getAffinity('artist', ['artist 2']))[0]?.entry.plays).toBe(3)
  })

  it('leaves out of the top entries those without affinity', async () => {
    const { repo } = setup()
    await repo.recordPlay({ track: track(1), playedMs: 0, completed: false, skipped: true })
    expect(await repo.db.affinity.count()).toBe(2)
    expect(await repo.topAffinity('track')).toEqual([])
  })

  it('forgets every play when the history is cleared, and keeps likes and playlists', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    await repo.createPlaylist({ name: 'Mix', tracks: [track(2)] })
    await repo.recordPlay({ track: track(1), playedMs: 181_000, completed: true, skipped: false })
    await repo.recordPlay({ track: track(3), playedMs: 1000, completed: false, skipped: true })
    await repo.clearHistory()
    expect(await scores(repo, T0)).toEqual({
      [trackId(1)]: { score: LIKE, skips: 0, plays: 0 },
      [artistId(1)]: { score: LIKE, skips: 0, plays: 0 },
      [trackId(2)]: { score: ADD, skips: 0, plays: 0 },
      [artistId(2)]: { score: ADD, skips: 0, plays: 0 },
    })
  })

  it('rebuilds exactly what the changes added up to one by one', async () => {
    const { repo, set } = setup()
    // The same metadata every time: see the next test for what happens when it changes.
    const song = (n: number) => track(n, n % 2 === 0 ? { tags: ['Ambient', `mood ${n}`] } : {})
    const mix = await repo.createPlaylist({ name: 'Mix', tracks: [1, 2, 3, 4, 5].map(song) })
    set(T0 + DAY)
    await repo.like(song(2))
    await repo.like(song(3))
    await repo.removeTracks(mix, [song(3).id])
    set(T0 + 3 * DAY)
    for (const [index, n] of [1, 2, 2, 6].entries()) {
      await repo.recordPlay({
        track: song(n),
        playedAt: T0 + 2 * DAY + index,
        playedMs: n * 20_000,
        completed: n === 2,
        skipped: n !== 2,
      })
    }
    await repo.unlike(song(2).id)
    const copy = await repo.duplicatePlaylist(LIKED_PLAYLIST_ID)
    set(T0 + 9 * DAY)
    await repo.addTracks(copy, [song(7)])
    await repo.deletePlaylist(mix)
    await repo.addDownload(song(8))
    await repo.addDownload(song(9))
    await repo.removeDownload(song(8).id)
    const now = T0 + 30 * DAY
    const incremental = await scores(repo, now)

    expect(await repo.rebuildAffinity()).toBe(Object.keys(incremental).length)

    const rebuilt = await scores(repo, now)
    expect(Object.keys(rebuilt).sort()).toEqual(Object.keys(incremental).sort())
    for (const [id, value] of Object.entries(incremental)) {
      expect(rebuilt[id]?.score, id).toBeCloseTo(value.score, 9)
      expect(rebuilt[id]?.skips, id).toBeCloseTo(value.skips, 9)
      expect(rebuilt[id]?.plays, id).toBe(value.plays)
    }
  })
})

describe('metadata that changes', () => {
  it('scores each change with the metadata cached then, until a rebuild', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    // The track comes back with tags, e.g. from another source.
    await repo.recordPlay({
      track: track(1, { tags: ['jazz'] }),
      playedMs: 181_000,
      completed: true,
      skipped: false,
    })
    expect((await stored(repo, affinityId('tag', 'jazz')))?.score).toBe(1)
    await repo.rebuildAffinity()
    expect((await stored(repo, affinityId('tag', 'jazz')))?.score).toBe(LIKE + 1)
  })
})

describe('recordPlays: the event API for plays', () => {
  it('records a batch in one go, with the tracks and their signals', async () => {
    const { repo } = setup()
    const ids = await repo.recordPlays([
      {
        track: track(1),
        playedAt: T0 - 2 * DAY,
        playedMs: 181_000,
        completed: true,
        skipped: false,
      },
      { track: track(2), playedAt: T0 - DAY, playedMs: 5_000, completed: false, skipped: true },
    ])
    expect(ids).toHaveLength(2)
    expect(await repo.getTrack(track(2).id)).toEqual(track(2))
    expect((await repo.history()).map((entry) => entry.id)).toEqual(ids)
    expect(await repo.db.affinity.count()).toBe(4)
    expect(await repo.recordPlays([])).toEqual([])
  })

  it('records a play only once, also when an import runs again', async () => {
    const { repo } = setup()
    const play = {
      track: track(1),
      playedAt: T0 - DAY,
      playedMs: 60_000,
      completed: false,
      skipped: false,
      importId: 'import-1',
    }
    const [first] = await repo.recordPlays([play, { ...play }])
    const yt: Track = { ...track(1), id: formatId('yt', 'track', 'video0001'), source: 'yt' }
    // The same video under its other prefix is the same play.
    expect(await repo.recordPlays([{ ...play, track: yt }])).toEqual([first])
    const again = await repo.recordPlays([play, { ...play, playedAt: T0 - DAY + 1 }])
    expect(again[0]).toBe(first)
    expect(again[1]).not.toBe(first)
    expect(await repo.history()).toHaveLength(2)
    expect((await repo.history())[0]).toMatchObject({ importId: 'import-1' })
    expect((await stored(repo, trackId(1)))?.plays).toBe(2)
  })

  it('keeps every spelling of a track it caches', async () => {
    const { repo } = setup()
    const yt: Track = { ...track(1), id: formatId('yt', 'track', 'video0001'), source: 'yt' }
    await repo.recordPlays([
      { track: track(1), playedMs: 1000, completed: false, skipped: false },
      { track: yt, playedAt: T0 - 5, playedMs: 1000, completed: false, skipped: false },
    ])
    expect(await repo.getTrack(track(1).id)).toBeDefined()
    expect(await repo.getTrack(yt.id)).toBeDefined()
  })

  it('counts a start after now as now, and takes the track’s own length over a useless one', async () => {
    const { repo } = setup()
    await repo.recordPlay({
      track: track(1),
      playedAt: T0 + DAY,
      playedMs: -5,
      durationMs: Number.NaN,
      completed: false,
      skipped: false,
    })
    const { durationMs: _length, ...noLength } = track(2)
    await repo.recordPlay({ track: noLength, playedMs: 1, completed: false, skipped: false })
    const [first, second] = await repo.history()
    expect(first).toMatchObject({ playedAt: T0, playedMs: 0, durationMs: 181_000 })
    expect(second).not.toHaveProperty('durationMs')
  })

  it.each([
    ['a start that is not a number', { playedAt: Number.NaN }],
    ['a negative start', { playedAt: -1 }],
    ['a time played that is not a number', { playedMs: Number.POSITIVE_INFINITY }],
    ['an invalid track ID', { track: { ...track(1), id: 'nope' as EntityId<'track'> } }],
  ])('refuses a play with %s, and records nothing of its batch', async (_name, patch) => {
    const { repo } = setup()
    const good = { track: track(2), playedMs: 1000, completed: false, skipped: false }
    await expect(repo.recordPlays([good, { ...good, ...patch }])).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(await repo.history()).toEqual([])
    expect(await repo.db.affinity.count()).toBe(0)
  })
})

describe('librarySignals', () => {
  const at = T0
  const playlist = (overrides: Partial<PlaylistRecord>): PlaylistRecord => ({
    id: formatId('local', 'playlist', 'mine'),
    name: 'Mine',
    createdAt: at - DAY,
    updatedAt: at,
    trackIds: [],
    addedAt: {},
    ...overrides,
  })

  it('stands for plays, likes and playlist entries, but not Liked songs’ own entries', () => {
    const signals = librarySignals({
      history: [
        { trackId: track(1).id, playedAt: at, playedMs: 1, completed: false, skipped: true },
      ],
      likes: [{ key: 'youtube:track:video0002', trackId: track(2).id, likedAt: at }],
      playlists: [
        playlist({ trackIds: [track(3).id], addedAt: { [track(3).id]: at } }),
        playlist({ id: LIKED_PLAYLIST_ID, system: 'liked', trackIds: [track(2).id] }),
        playlist({ id: DOWNLOADS_PLAYLIST_ID, system: 'downloads', trackIds: [track(4).id] }),
      ],
      tracks: new Map([[track(1).id, track(1)]]),
    })
    expect(signals.map((signal) => `${signal.type} ${signal.track.id}`)).toEqual([
      `play ${track(1).id}`,
      `like ${track(2).id}`,
      `playlist-add ${track(3).id}`,
      `playlist-add ${track(4).id}`,
    ])
    expect(signals[0]?.track).toEqual(track(1))
    // A track missing from the cache still counts for itself.
    expect(signals[1]?.track).toEqual({ id: track(2).id, title: '', artists: [] })
  })

  it('dates a playlist entry without a date of its own by the playlist’s creation', () => {
    const record = playlist({
      trackIds: [track(1).id, track(2).id],
      addedAt: { [track(1).id]: at },
    })
    expect(addedAtOf(record, track(1).id)).toBe(at)
    expect(addedAtOf(record, track(2).id)).toBe(at - DAY)
  })
})

describe('backups and the affinity', () => {
  async function library(repo: LibraryRepo) {
    await repo.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    await repo.like(track(4, { tags: ['jazz'] }))
    await repo.recordPlay({ track: track(1), playedMs: 181_000, completed: true, skipped: false })
  }

  it('leaves the affinity out of a backup and rebuilds it on import', async () => {
    const source = setup()
    await library(source.repo)
    const backup = await exportLibrary(source.repo)
    expect(backup.tables).not.toHaveProperty('affinity')

    const target = setup()
    await target.repo.like(track(9))
    await importLibrary(target.repo, parseBackup(JSON.stringify(backup)), 'replace')
    expect(await scores(target.repo, T0)).toEqual(await scores(source.repo, T0))
  })

  it('rebuilds the affinity of a merged library from both sides', async () => {
    const source = setup()
    await library(source.repo)
    const backup = await exportLibrary(source.repo)

    const target = setup()
    await target.repo.like(track(9))
    await importLibrary(target.repo, parseBackup(JSON.stringify(backup)), 'merge')
    const merged = await scores(target.repo, T0)
    expect(merged[trackId(9)]).toEqual({ score: LIKE, skips: 0, plays: 0 })
    expect(merged[affinityId('tag', 'jazz')]).toEqual({ score: LIKE, skips: 0, plays: 0 })
    expect(merged[trackId(1)]?.plays).toBe(1)
  })
})
