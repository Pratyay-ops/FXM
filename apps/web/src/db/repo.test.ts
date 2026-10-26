import { type AudioCandidate, createSeededRandom, type EntityId, formatId } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { testRepo, track, tracks } from '../test/library-fixtures'
import { LibraryError, randomUuid } from './repo'
import { DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID, MATCH_TTL_MS, PLAYLISTS_ORDER_ID } from './types'

const ids = (list: { id: string }[]) => list.map((item) => item.id)

async function playlistIds(repo: ReturnType<typeof testRepo>) {
  return ids((await repo.getPlaylistList()).items)
}

async function trackOrder(repo: ReturnType<typeof testRepo>, id: EntityId<'playlist'>) {
  return ids((await repo.getPlaylistView(id))?.rows ?? [])
}

function candidate(ref: string, overrides: Partial<AudioCandidate> = {}): AudioCandidate {
  return {
    source: 'ytm',
    ref,
    kind: 'song',
    title: `Candidate ${ref}`,
    artists: ['Artist'],
    confidence: 0.9,
    evidence: ['title 0.97'],
    ...overrides,
  }
}

describe('a new library', () => {
  it('has Liked songs and Downloads, in that order', async () => {
    const repo = testRepo()
    const { items } = await repo.getPlaylistList()
    expect(items).toMatchObject([
      { id: LIKED_PLAYLIST_ID, system: 'liked', name: 'Liked songs', trackCount: 0 },
      { id: DOWNLOADS_PLAYLIST_ID, system: 'downloads', name: 'Downloads', trackCount: 0 },
    ])
  })

  it('makes random UUIDs, also where crypto.randomUUID is missing', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    expect(randomUuid()).toMatch(uuid)
    const { getRandomValues } = globalThis.crypto
    // An insecure context (plain http) has getRandomValues but no randomUUID.
    vi.stubGlobal('crypto', { getRandomValues: getRandomValues.bind(globalThis.crypto) })
    try {
      expect(randomUuid()).toMatch(uuid)
      expect(randomUuid()).not.toBe(randomUuid())
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('playlists', () => {
  it('creates a playlist with a local ID at the top of the list', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: '  Road trip  ', description: 'Loud' })
    expect(id).toMatch(/^local:playlist:[0-9a-f-]{36}$/u)
    expect(await playlistIds(repo)).toEqual([id, LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID])
    expect((await repo.getPlaylistView(id))?.playlist).toMatchObject({
      name: 'Road trip',
      description: 'Loud',
      trackIds: [],
    })
  })

  it('refuses an empty name', async () => {
    const repo = testRepo()
    await expect(repo.createPlaylist({ name: '   ' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('renames a playlist and changes or clears its description', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Draft', description: 'Old' })
    await repo.updatePlaylist(id, { name: 'Final' })
    expect((await repo.getPlaylistView(id))?.playlist).toMatchObject({
      name: 'Final',
      description: 'Old',
    })
    await repo.updatePlaylist(id, { description: '  ' })
    expect((await repo.getPlaylistView(id))?.playlist.description).toBeUndefined()
  })

  it('duplicates a playlist with its order and dates, right after the original', async () => {
    const repo = testRepo()
    const first = await repo.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    await repo.moveItems(first, [track(3).id], 'top')
    const second = await repo.createPlaylist({ name: 'Other' })
    const copy = await repo.duplicatePlaylist(first)

    expect(await playlistIds(repo)).toEqual([
      second,
      first,
      copy,
      LIKED_PLAYLIST_ID,
      DOWNLOADS_PLAYLIST_ID,
    ])
    const original = await repo.getPlaylistView(first)
    const duplicate = await repo.getPlaylistView(copy)
    expect(duplicate?.playlist.name).toBe('Mix (copy)')
    expect(ids(duplicate?.rows ?? [])).toEqual(ids(original?.rows ?? []))
    expect(duplicate?.rows.map((row) => row.addedAt)).toEqual(
      original?.rows.map((row) => row.addedAt),
    )
  })

  it('duplicates Liked songs as an ordinary playlist', async () => {
    const repo = testRepo()
    await repo.like(track(1))
    await repo.like(track(2))
    const copy = await repo.duplicatePlaylist(LIKED_PLAYLIST_ID)
    const view = await repo.getPlaylistView(copy)
    expect(view?.playlist.system).toBeUndefined()
    expect(ids(view?.rows ?? [])).toEqual([track(2).id, track(1).id])
  })

  it('deletes a playlist and drops it from the list', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Gone' })
    await repo.deletePlaylist(id)
    expect(await repo.getPlaylistView(id)).toBeUndefined()
    expect(await playlistIds(repo)).toEqual([LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID])
  })

  it('protects the built-in playlists from renaming and deleting', async () => {
    const repo = testRepo()
    for (const id of [LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID]) {
      await expect(repo.updatePlaylist(id, { name: 'Mine' })).rejects.toMatchObject({
        code: 'protected',
      })
      await expect(repo.deletePlaylist(id)).rejects.toBeInstanceOf(LibraryError)
    }
    expect(await playlistIds(repo)).toEqual([LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID])
  })

  it('adds tracks at the end, once each, and caches their metadata', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    const result = await repo.addTracks(id, [track(2), track(1), track(3), track(2)])
    expect(result).toEqual({ added: 2, skipped: 2 })
    expect(await trackOrder(repo, id)).toEqual([track(1).id, track(2).id, track(3).id])
    expect(await repo.getTrack(track(3).id)).toEqual(track(3))
  })

  it('treats ytm and yt IDs of one video as the same track', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    const sameVideo = track(1, { id: formatId('yt', 'track', 'video0001'), source: 'yt' })
    expect(await repo.addTracks(id, [sameVideo])).toEqual({ added: 0, skipped: 1 })
  })

  it('adds tracks at the top when asked', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    await repo.addTracks(id, [track(2), track(3)], { position: 'top' })
    expect(await trackOrder(repo, id)).toEqual([track(2).id, track(3).id, track(1).id])
  })

  it('removes tracks and their dates', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    expect(await repo.removeTracks(id, [track(2).id])).toBe(1)
    const view = await repo.getPlaylistView(id)
    expect(ids(view?.rows ?? [])).toEqual([track(1).id, track(3).id])
    expect(Object.keys(view?.playlist.addedAt ?? {})).toEqual([track(1).id, track(3).id])
  })

  it('shows a track whose metadata is missing without failing', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    await repo.db.tracks.clear()
    expect((await repo.getPlaylistView(id))?.rows).toEqual([
      expect.objectContaining({ id: track(1).id, liked: false }),
    ])
  })

  it('lists a playlist with the artwork of its first track', async () => {
    const repo = testRepo()
    const cover = [{ url: 'https://example.com/cover.jpg' }]
    await repo.createPlaylist({ name: 'Mix', tracks: [track(1, { artwork: cover }), track(2)] })
    expect((await repo.getPlaylistList()).items[0]?.artwork).toEqual(cover)
  })
})

describe('likes', () => {
  it('puts new likes at the top of Liked songs', async () => {
    const repo = testRepo()
    await repo.like(track(1))
    await repo.like(track(2))
    expect(await repo.like(track(1))).toBe(false)
    const view = await repo.getPlaylistView(LIKED_PLAYLIST_ID)
    expect(ids(view?.rows ?? [])).toEqual([track(2).id, track(1).id])
    expect(view?.rows.every((row) => row.liked)).toBe(true)
    expect(view?.rows[0]?.addedAt).toBeGreaterThan(view?.rows[1]?.addedAt ?? Infinity)
  })

  it('keeps likedAt while Liked songs has a custom order of its own', async () => {
    const repo = testRepo()
    for (const n of [1, 2, 3]) await repo.like(track(n))
    const before = await repo.getPlaylistView(LIKED_PLAYLIST_ID)
    await repo.moveItems(LIKED_PLAYLIST_ID, [track(1).id], 'top')
    const after = await repo.getPlaylistView(LIKED_PLAYLIST_ID)
    expect(ids(after?.rows ?? [])).toEqual([track(1).id, track(3).id, track(2).id])
    const likedAt = (view: typeof before) =>
      Object.fromEntries((view?.rows ?? []).map((row) => [row.id, row.addedAt]))
    expect(likedAt(after)).toEqual(likedAt(before))
  })

  it('toggles a like and counts it once for ytm and yt IDs', async () => {
    const repo = testRepo()
    const sameVideo = formatId('yt', 'track', 'video0001')
    expect(await repo.toggleLike(track(1))).toBe(true)
    expect(await repo.isLiked(sameVideo)).toBe(true)
    expect(await repo.toggleLike(track(1))).toBe(false)
    expect(await repo.isLiked(track(1).id)).toBe(false)
    expect(await trackOrder(repo, LIKED_PLAYLIST_ID)).toEqual([])
  })

  it('likes tracks added to Liked songs and unlikes the ones removed from it', async () => {
    const repo = testRepo()
    expect(await repo.addTracks(LIKED_PLAYLIST_ID, [track(1), track(2)])).toEqual({
      added: 2,
      skipped: 0,
    })
    expect(await trackOrder(repo, LIKED_PLAYLIST_ID)).toEqual([track(1).id, track(2).id])
    await repo.removeTracks(LIKED_PLAYLIST_ID, [track(1).id])
    expect(await repo.isLiked(track(1).id)).toBe(false)
    expect((await repo.getPlaylistList()).items[0]).toMatchObject({ trackCount: 1 })
  })

  it('marks liked tracks in other lists', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(2) })
    await repo.like(track(2))
    expect((await repo.getPlaylistView(id))?.rows.map((row) => row.liked)).toEqual([false, true])
  })

  // Every like is also scored in the listening affinity (stage 3.1), and every unlike takes its
  // score back: thousands of affinity records, which fake-indexeddb, unlike a browser, deletes
  // and rewrites in time that grows with the table. Hence more than the usual time.
  it('likes and unlikes 2,000 songs at once with one write of Liked songs each', async () => {
    const repo = testRepo()
    await repo.like(track(5000))
    const many = tracks(2000)
    const puts = vi.spyOn(repo.db.playlists, 'put')
    const reads = vi.spyOn(repo.db.likes, 'toArray')

    expect(await repo.addTracks(LIKED_PLAYLIST_ID, many)).toEqual({ added: 2000, skipped: 0 })

    expect(puts).toHaveBeenCalledTimes(1)
    expect(reads).toHaveBeenCalledTimes(1)
    // New likes go to the top, the first one first, above the older like.
    const order = await trackOrder(repo, LIKED_PLAYLIST_ID)
    expect(order.slice(0, 3)).toEqual([track(1).id, track(2).id, track(3).id])
    expect(order.at(-1)).toBe(track(5000).id)
    expect(order).toHaveLength(2001)

    puts.mockClear()
    reads.mockClear()
    const half = many.filter((_, index) => index % 2 === 0).map((item) => item.id)
    expect(await repo.removeTracks(LIKED_PLAYLIST_ID, half)).toBe(1000)

    expect(puts).toHaveBeenCalledTimes(1)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(await trackOrder(repo, LIKED_PLAYLIST_ID)).toEqual([
      ...many.filter((_, index) => index % 2 === 1).map((item) => item.id),
      track(5000).id,
    ])
    expect(await repo.isLiked(track(1).id)).toBe(false)
    expect(await repo.isLiked(track(2).id)).toBe(true)
  }, 120_000)

  it('skips songs already liked when adding several to Liked songs', async () => {
    const repo = testRepo()
    await repo.like(track(2))
    expect(await repo.addTracks(LIKED_PLAYLIST_ID, [track(1), track(2), track(3)])).toEqual({
      added: 2,
      skipped: 1,
    })
    expect(await trackOrder(repo, LIKED_PLAYLIST_ID)).toEqual([
      track(1).id,
      track(3).id,
      track(2).id,
    ])
    expect(await repo.removeTracks(LIKED_PLAYLIST_ID, [track(9).id])).toBe(0)
  })

  it('heals a liked order that lost or kept stale entries', async () => {
    const repo = testRepo()
    await repo.like(track(1))
    await repo.like(track(2))
    const liked = await repo.db.playlists.get(LIKED_PLAYLIST_ID)
    if (!liked) throw new Error('missing')
    await repo.db.playlists.put({ ...liked, trackIds: [track(9).id, track(1).id] })
    expect(await trackOrder(repo, LIKED_PLAYLIST_ID)).toEqual([track(2).id, track(1).id])
  })
})

describe('Downloads', () => {
  it('is filled by the download manager only, newest first', async () => {
    const repo = testRepo()
    await expect(repo.addTracks(DOWNLOADS_PLAYLIST_ID, [track(1)])).rejects.toMatchObject({
      code: 'protected',
    })
    await expect(repo.removeTracks(DOWNLOADS_PLAYLIST_ID, [track(1).id])).rejects.toMatchObject({
      code: 'protected',
    })
    await repo.addDownload(track(1))
    await repo.addDownload(track(2))
    await repo.addDownload(track(1))
    expect(await trackOrder(repo, DOWNLOADS_PLAYLIST_ID)).toEqual([track(2).id, track(1).id])
    await repo.removeDownload(track(2).id)
    expect(await trackOrder(repo, DOWNLOADS_PLAYLIST_ID)).toEqual([track(1).id])
  })

  it('supports every ordering feature', async () => {
    const repo = testRepo({ random: createSeededRandom(3) })
    for (const n of [1, 2, 3, 4]) await repo.addDownload(track(n))
    await repo.moveItems(DOWNLOADS_PLAYLIST_ID, [track(1).id], 'top')
    expect((await trackOrder(repo, DOWNLOADS_PLAYLIST_ID))[0]).toBe(track(1).id)
    const before = await trackOrder(repo, DOWNLOADS_PLAYLIST_ID)
    expect(await repo.shuffleOrder(DOWNLOADS_PLAYLIST_ID)).toBe(true)
    expect(await trackOrder(repo, DOWNLOADS_PLAYLIST_ID)).not.toEqual(before)
    expect(await repo.undoOrder(DOWNLOADS_PLAYLIST_ID)).toBe(true)
    expect(await trackOrder(repo, DOWNLOADS_PLAYLIST_ID)).toEqual(before)
  })
})

describe('ordering', () => {
  it('moves tracks up, down, to the top, to the bottom and before another', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(5) })
    const [a, b, c, d, e] = tracks(5).map((item) => item.id) as EntityId<'track'>[]
    await repo.moveItems(id, [c as string], 'up')
    expect(await trackOrder(repo, id)).toEqual([a, c, b, d, e])
    await repo.moveItems(id, [a as string], 'down')
    expect(await trackOrder(repo, id)).toEqual([c, a, b, d, e])
    await repo.moveItems(id, [e as string, b as string], 'top')
    expect(await trackOrder(repo, id)).toEqual([b, e, c, a, d])
    await repo.moveItems(id, [b as string], 'bottom')
    expect(await trackOrder(repo, id)).toEqual([e, c, a, d, b])
    await repo.moveItems(id, [d as string], { before: c as string })
    expect(await trackOrder(repo, id)).toEqual([e, d, c, a, b])
  })

  it('reports a move that changes nothing', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(2) })
    expect(await repo.moveItems(id, [track(1).id], 'up')).toBe(false)
    await expect(repo.moveItems(formatId('local', 'playlist', 'nope'), [], 'up')).rejects.toThrow(
      LibraryError,
    )
  })

  it('shuffles the saved order with the injected random source and undoes it', async () => {
    const repo = testRepo({ random: createSeededRandom(11) })
    const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(10) })
    const original = await trackOrder(repo, id)

    expect(await repo.shuffleOrder(id)).toBe(true)
    const shuffled = await trackOrder(repo, id)
    expect(shuffled).not.toEqual(original)
    expect([...shuffled].sort()).toEqual([...original].sort())
    expect((await repo.getPlaylistView(id))?.playlist.undo).toEqual({
      action: 'shuffle',
      order: original,
    })

    expect(await repo.undoOrder(id)).toBe(true)
    expect(await trackOrder(repo, id)).toEqual(original)
    expect(await repo.undoOrder(id)).toBe(false)
  })

  it('shuffles the same way for the same seed', async () => {
    const orderAfterShuffle = async (seed: number) => {
      const repo = testRepo({ random: createSeededRandom(seed), uuid: () => 'fixed' })
      const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(8) })
      await repo.shuffleOrder(id)
      return trackOrder(repo, id)
    }
    expect(await orderAfterShuffle(5)).toEqual(await orderAfterShuffle(5))
  })

  it('keeps the undo only until the next change', async () => {
    const repo = testRepo({ random: createSeededRandom(2) })
    const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(4) })
    await repo.shuffleOrder(id)
    await repo.updatePlaylist(id, { name: 'Renamed' })
    expect((await repo.getPlaylistView(id))?.playlist.undo).toBeDefined()
    await repo.moveItems(id, [track(4).id], 'bottom')
    expect((await repo.getPlaylistView(id))?.playlist.undo).toBeUndefined()
    expect(await repo.undoOrder(id)).toBe(false)

    await repo.shuffleOrder(id)
    await repo.addTracks(id, [track(5)])
    expect(await repo.undoOrder(id)).toBe(false)
  })

  it('refuses to shuffle a list that is too short', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    expect(await repo.shuffleOrder(id)).toBe(false)
  })

  it('saves a sorted order as the custom order, with undo', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    const reversed = [track(3).id, track(2).id, track(1).id]
    expect(await repo.setOrder(id, reversed, 'sort')).toBe(true)
    expect(await trackOrder(repo, id)).toEqual(reversed)
    expect(await repo.setOrder(id, reversed, 'sort')).toBe(false)
    expect(await repo.undoOrder(id)).toBe(true)
    expect(await trackOrder(repo, id)).toEqual([track(1).id, track(2).id, track(3).id])
  })

  it('fits a saved order to what the list holds now', async () => {
    const repo = testRepo()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    // A stale view: lacks track 3 and still has track 9.
    await repo.setOrder(id, [track(9).id, track(2).id, track(1).id])
    expect(await trackOrder(repo, id)).toEqual([track(2).id, track(1).id, track(3).id])
  })

  it('reorders 2,000 tracks with one write of one record', async () => {
    const repo = testRepo()
    const many = tracks(2000)
    const id = await repo.createPlaylist({ name: 'Big', tracks: many })
    const puts = vi.spyOn(repo.db.playlists, 'put')
    const selected = many.filter((_, index) => index % 2 === 1).map((item) => item.id)

    await repo.moveItems(id, selected, 'top')

    expect(puts).toHaveBeenCalledTimes(1)
    const order = await trackOrder(repo, id)
    expect(order.slice(0, 1000)).toEqual(selected)
    expect(new Set(order).size).toBe(2000)
  })
})

describe('the list of playlists', () => {
  it('can be reordered, shuffled, sorted and undone like a playlist', async () => {
    const repo = testRepo({ random: createSeededRandom(9) })
    const a = await repo.createPlaylist({ name: 'A' })
    const b = await repo.createPlaylist({ name: 'B' })
    expect(await playlistIds(repo)).toEqual([b, a, LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID])

    await repo.moveItems(PLAYLISTS_ORDER_ID, [LIKED_PLAYLIST_ID], 'top')
    expect(await playlistIds(repo)).toEqual([LIKED_PLAYLIST_ID, b, a, DOWNLOADS_PLAYLIST_ID])

    await repo.moveItems(PLAYLISTS_ORDER_ID, [a, b], 'bottom')
    expect(await playlistIds(repo)).toEqual([LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID, b, a])

    const before = await playlistIds(repo)
    await repo.shuffleOrder(PLAYLISTS_ORDER_ID)
    expect((await repo.getPlaylistList()).undo?.action).toBe('shuffle')
    await repo.undoOrder(PLAYLISTS_ORDER_ID)
    expect(await playlistIds(repo)).toEqual(before)

    await repo.setOrder(
      PLAYLISTS_ORDER_ID,
      [a, b, DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID],
      'sort',
    )
    expect(await playlistIds(repo)).toEqual([a, b, DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID])
    expect(await repo.getOrder(PLAYLISTS_ORDER_ID)).toEqual([
      a,
      b,
      DOWNLOADS_PLAYLIST_ID,
      LIKED_PLAYLIST_ID,
    ])
  })

  it('lists followed playlists too, newest at the top', async () => {
    const repo = testRepo()
    const remote = formatId('ytm', 'playlist', 'PLx')
    await repo.follow({
      id: remote,
      source: 'ytm',
      name: 'Hits',
      artwork: [],
      owner: { name: 'YouTube Music' },
    })
    expect((await repo.getPlaylistList()).items[0]).toMatchObject({
      id: remote,
      origin: 'followed',
      owner: 'YouTube Music',
    })
    await repo.unfollow(remote)
    expect(await playlistIds(repo)).toEqual([LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID])
  })
})

describe('follows', () => {
  it('follows artists and saves albums, most recent first', async () => {
    const repo = testRepo()
    const artist = formatId('ytm', 'artist', 'UC1')
    const album = formatId('ytm', 'album', 'MPREb_1')
    await repo.follow({ id: artist, source: 'ytm', name: 'Band', artwork: [] })
    await repo.follow({
      id: album,
      source: 'ytm',
      name: 'Record',
      artists: [{ name: 'Band', id: artist }],
      artwork: [],
    })
    await repo.follow({
      id: formatId('ytm', 'artist', 'UC2'),
      source: 'ytm',
      name: 'Duo',
      artwork: [],
    })
    expect((await repo.listFollows('artist')).map((follow) => follow.name)).toEqual(['Duo', 'Band'])
    expect(await repo.listFollows('album')).toMatchObject([
      { id: album, kind: 'album', artists: [{ name: 'Band' }] },
    ])
    expect(await repo.isFollowing(formatId('yt', 'artist', 'UC1'))).toBe(true)
    await repo.unfollow(artist)
    expect(await repo.isFollowing(artist)).toBe(false)
  })

  it('refuses to follow a playlist of this library', async () => {
    const repo = testRepo()
    await expect(
      repo.follow({ id: LIKED_PLAYLIST_ID, source: 'local', name: 'Liked songs', artwork: [] }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('history', () => {
  it('lists recently played tracks once each, most recent first', async () => {
    const repo = testRepo()
    const play = (n: number, playedAt: number) =>
      repo.recordPlay({
        track: track(n),
        playedAt,
        playedMs: 30_000,
        completed: false,
        skipped: true,
        context: { type: 'library', id: LIKED_PLAYLIST_ID, title: 'Liked songs' },
        stream: { source: 'ytm', codec: 'opus', bitrateKbps: 160, tier: 'high' },
      })
    await play(1, 1000)
    await play(2, 2000)
    await play(1, 3000)
    const recent = await repo.recentlyPlayed()
    expect(recent.map((row) => [row.id, row.playedAt])).toEqual([
      [track(1).id, 3000],
      [track(2).id, 2000],
    ])
    expect(recent[0]?.track?.title).toBe('Song 1')
    expect(await repo.history()).toHaveLength(3)
    expect((await repo.history())[0]).toMatchObject({
      skipped: true,
      stream: { codec: 'opus' },
      context: { type: 'library', id: LIKED_PLAYLIST_ID },
    })
    expect(await repo.recentlyPlayed(1)).toHaveLength(1)
    await repo.clearHistory()
    expect(await repo.recentlyPlayed()).toEqual([])
  })

  it('tells when the history starts, which only forgetting or older plays change', async () => {
    const repo = testRepo()
    const play = (n: number, playedAt: number) =>
      repo.recordPlay({
        track: track(n),
        playedAt,
        playedMs: 1000,
        completed: false,
        skipped: false,
      })
    expect(await repo.historyStart()).toBeUndefined()
    await play(1, 5000)
    await play(2, 9000)
    expect(await repo.historyStart()).toBe(5000)
    await play(3, 2000)
    expect(await repo.historyStart()).toBe(2000)
    await repo.clearHistory()
    expect(await repo.historyStart()).toBeUndefined()
  })
})

describe('match cache', () => {
  const spotify = formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC')

  it('keys decisions by source track and catalog mode', async () => {
    const repo = testRepo()
    await repo.recordMatch({
      sourceTrackId: spotify,
      mode: 'music',
      band: 'auto',
      candidate: candidate('a'),
    })
    await repo.recordMatch({
      sourceTrackId: spotify,
      mode: 'all',
      band: 'auto',
      candidate: candidate('v', { kind: 'music-video' }),
    })
    expect((await repo.getConfirmedMatch(spotify, 'music'))?.ref).toBe('a')
    expect((await repo.getConfirmedMatch(spotify, 'all'))?.ref).toBe('v')
  })

  it('stores a Suggest guess but never as confirmed', async () => {
    const repo = testRepo()
    await repo.recordMatch({
      sourceTrackId: spotify,
      mode: 'music',
      band: 'suggest',
      candidate: candidate('guess'),
      alternatives: [candidate('other')],
      evidence: ['re-recording guard'],
      signals: { isrcVerified: false, sourceAlbumMatch: false, releaseYear: 2016 },
    })
    expect(await repo.getMatch(spotify, 'music')).toMatchObject({
      band: 'suggest',
      userPinned: false,
      candidate: { ref: 'guess' },
      evidence: ['re-recording guard'],
      signals: { releaseYear: 2016 },
    })
    expect(await repo.getConfirmedMatch(spotify, 'music')).toBeUndefined()
  })

  it('lets a pin win over every later engine decision', async () => {
    const repo = testRepo()
    await repo.recordMatch({
      sourceTrackId: spotify,
      mode: 'music',
      band: 'suggest',
      candidate: candidate('guess'),
    })
    await repo.pinMatch(spotify, 'music', candidate('mine'))
    expect(
      await repo.recordMatch({
        sourceTrackId: spotify,
        mode: 'music',
        band: 'auto',
        candidate: candidate('engine'),
      }),
    ).toBe(false)
    expect(await repo.forgetMatch(spotify, 'music')).toBe(false)
    const record = await repo.getMatch(spotify, 'music')
    expect(record).toMatchObject({ userPinned: true, candidate: { ref: 'mine' } })
    expect(record?.alternatives.map((other) => other.ref)).toEqual(['guess'])
    expect((await repo.getConfirmedMatch(spotify, 'music'))?.ref).toBe('mine')

    await repo.unpinMatch(spotify, 'music')
    expect(await repo.getMatch(spotify, 'music')).toBeUndefined()
  })

  it('keeps engine decisions about 30 days, and pins for good', async () => {
    let clock = 1_000_000
    const repo = testRepo({ now: () => clock })
    const pinned = formatId('spotify', 'track', 'pinnedpinnedpinnedpinn')
    await repo.recordMatch({
      sourceTrackId: spotify,
      mode: 'music',
      band: 'auto',
      candidate: candidate('a'),
    })
    await repo.pinMatch(pinned, 'music', candidate('p'))

    clock += MATCH_TTL_MS + 1
    expect(await repo.getMatch(spotify, 'music')).toBeUndefined()
    expect(await repo.getConfirmedMatch(spotify, 'music')).toBeUndefined()
    expect(await repo.getMatch(pinned, 'music')).toBeDefined()

    expect(await repo.pruneMatchCache()).toBe(1)
    expect(await repo.db.matchCache.count()).toBe(1)
    expect(await repo.getConfirmedMatch(pinned, 'music')).toMatchObject({ ref: 'p' })
  })

  it('forgets an engine decision for Smart Replace', async () => {
    const repo = testRepo()
    await repo.recordMatch({
      sourceTrackId: spotify,
      mode: 'music',
      band: 'auto',
      candidate: candidate('a'),
    })
    expect(await repo.forgetMatch(spotify, 'music')).toBe(true)
    expect(await repo.getMatch(spotify, 'music')).toBeUndefined()
  })

  it('has no confirmed audio for a None decision', async () => {
    const repo = testRepo()
    await repo.recordMatch({
      sourceTrackId: spotify,
      mode: 'music',
      band: 'none',
      alternatives: [candidate('x')],
    })
    expect(await repo.getMatch(spotify, 'music')).toMatchObject({ band: 'none' })
    expect(await repo.getConfirmedMatch(spotify, 'music')).toBeUndefined()
  })
})

describe('import progress', () => {
  it('saves progress as an import goes, so it can resume', async () => {
    const repo = testRepo({ uuid: () => 'import-1' })
    const started = await repo.startImport({ kind: 'csv', label: 'Exportify.csv', total: 120 })
    expect(started).toMatchObject({ id: 'import-1', status: 'running', done: 0 })

    await repo.updateImport('import-1', {
      done: 40,
      matched: 35,
      needsReview: 4,
      failed: 1,
      state: { row: 40 },
    })
    await repo.updateImport('import-1', { status: 'paused' })
    expect(await repo.getImport('import-1')).toMatchObject({
      status: 'paused',
      done: 40,
      matched: 35,
      state: { row: 40 },
    })
    expect(await repo.listImports()).toHaveLength(1)
    await expect(repo.updateImport('nope', { done: 1 })).rejects.toMatchObject({
      code: 'not-found',
    })
    await repo.deleteImport('import-1')
    expect(await repo.getImport('import-1')).toBeUndefined()
  })
})

describe('clearLibrary', () => {
  it('empties everything but brings back the built-in playlists', async () => {
    const repo = testRepo()
    await repo.like(track(1))
    await repo.createPlaylist({ name: 'Mix' })
    await repo.clearLibrary()
    expect(await playlistIds(repo)).toEqual([LIKED_PLAYLIST_ID, DOWNLOADS_PLAYLIST_ID])
    expect(await repo.db.tracks.count()).toBe(0)
  })
})
