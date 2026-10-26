import { type EntityId, FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import { SpotifyError } from '@fxm/sources/spotify'
import { describe, expect, it, vi } from 'vitest'
import { LIKED_PLAYLIST_ID } from '../../db/types'
import { testRepo, track } from '../../test/library-fixtures'
import {
  accountKeyOf,
  HOME_KEY,
  LIKED_NAME,
  likedCopyId,
  listKey,
  META_KEY,
  playlistCopyId,
} from './ids'
import { readState } from './state'
import { forgetSync, runSpotifySync, type SyncOptions } from './sync'
import { type FakeAccount, fakeAccount, nativeId, spotifyTrack, spotifyTracks } from './testing'

type Repo = ReturnType<typeof testRepo>

const ctx: ProviderContext = {
  fetch: () => Promise.reject(new Error('The sync tests never fetch')),
  platform: 'web',
  capabilities: { youtube: 'full', spotify: 'account', mediaBytes: true, fileSystem: false },
  mode: 'music',
}

const P1 = nativeId('p', 1)
const P2 = nativeId('p', 2)

function sync(account: FakeAccount, repo: Repo, options: Partial<SyncOptions> = {}) {
  return runSpotifySync(account.spotify, repo, { context: () => ctx, ...options })
}

async function likedId(username = 'fixture-user'): Promise<EntityId<'playlist'>> {
  return likedCopyId(await accountKeyOf(username))
}

/** The titles of a playlist's songs, in the saved order. */
async function titles(repo: Repo, id: EntityId<'playlist'>): Promise<string[] | undefined> {
  const view = await repo.getPlaylistView(id)
  return view?.rows.map((row) => row.track?.title ?? row.id)
}

async function playlistNames(repo: Repo): Promise<string[]> {
  return (await repo.getPlaylistList()).items.map((item) => item.name)
}

describe('the first sync', () => {
  it("copies liked songs and every playlist into the library, after the user's playlists", async () => {
    const repo = testRepo()
    const mine = await repo.createPlaylist({ name: 'My own' })
    const account = fakeAccount()
    account.data.playlists[0] = {
      ...(account.data.playlists[0] as (typeof account.data.playlists)[0]),
      artwork: [{ url: 'https://i.scdn.co/image/road-trip', width: 300, height: 300 }],
    }
    const progress = vi.fn()
    const result = await sync(account, repo, { onProgress: progress })

    expect(result).toMatchObject({
      account: await accountKeyOf('fixture-user'),
      displayName: 'Fixture User',
      summary: {
        likedCount: 3,
        playlistCount: 2,
        created: 3,
        updated: 0,
        added: 9,
        removed: 0,
        home: true,
        complete: true,
      },
    })
    expect(await playlistNames(repo)).toEqual([
      'My own',
      'Liked songs',
      'Downloads',
      LIKED_NAME,
      'Road trip',
      'Quiet',
    ])
    expect(await titles(repo, await likedId())).toEqual([
      'Spotify song 1',
      'Spotify song 2',
      'Spotify song 3',
    ])
    const roadTrip = await repo.getPlaylistView(playlistCopyId(P1))
    expect(roadTrip?.playlist).toMatchObject({
      name: 'Road trip',
      description: 'Loud',
      artwork: [{ url: 'https://i.scdn.co/image/road-trip', width: 300, height: 300 }],
    })
    expect(roadTrip?.rows.map((row) => row.id)).toEqual(spotifyTracks(11, 14).map((t) => t.id))
    // FXM's own Liked songs and the user's playlist are left alone.
    expect((await repo.getPlaylistView(LIKED_PLAYLIST_ID))?.rows).toEqual([])
    expect((await repo.getPlaylistView(mine))?.rows).toEqual([])
    expect(progress.mock.calls.map(([step]) => step.step)).toEqual([
      'account',
      'liked',
      'playlists',
      'playlists',
      'playlists',
      'playlists',
      'home',
    ])
    expect(account.calls).toEqual([
      'profile',
      'liked 0',
      'playlists 0',
      `tracks ${P1} 0`,
      `tracks ${P2} 0`,
      'home',
    ])
  })

  it('keeps the personal home and what it did, never the user name', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    const home = (await repo.getSetting(HOME_KEY)) as { shelves: unknown[]; account: string }
    expect(home.shelves).toEqual(account.data.home)
    expect(home.account).toBe(await accountKeyOf('fixture-user'))
    const state = await readState(repo)
    expect(state.meta?.last).toMatchObject({ created: 3, complete: true })
    expect(state.meta?.lastSyncAt).toBe(state.meta?.last?.at)
    expect([...state.lists.keys()].sort()).toEqual(['liked', P1, P2].sort())
    const { settings } = await repo.snapshot()
    expect(JSON.stringify(settings)).not.toContain('fixture-user')
    // The display name only in what Spotify titles a section ("Made for …"), as Home shows it.
    const own = settings.filter((row) => row.key !== HOME_KEY)
    expect(JSON.stringify(own)).not.toContain('Fixture User')
    // Nothing reaches the user's other devices: no `sync.` keys.
    expect((await repo.snapshot()).settings.some((row) => row.key.startsWith('sync.'))).toBe(false)
  })

  it("paces Spotify's further pages", async () => {
    const repo = testRepo()
    const account = fakeAccount({
      liked: spotifyTracks(1, 120).map((t) => ({ track: t })),
    })
    account.data.playlists[0] = { id: P1, name: 'Long', tracks: spotifyTracks(200, 450) }
    const pace = vi.fn(async () => {})
    const result = await sync(account, repo, { pace })
    expect(result.summary.likedCount).toBe(120)
    expect(await titles(repo, playlistCopyId(P1))).toHaveLength(251)
    expect(account.calls.filter((call) => call.startsWith('liked'))).toEqual([
      'liked 0',
      'liked 50',
      'liked 100',
    ])
    expect(account.calls.filter((call) => call.startsWith(`tracks ${P1}`))).toEqual([
      `tracks ${P1} 0`,
      `tracks ${P1} 100`,
      `tracks ${P1} 200`,
    ])
    // Two more liked pages, one per playlist, two more pages of the long playlist.
    expect(pace).toHaveBeenCalledTimes(6)
  })
})

describe('the next syncs', () => {
  it('read only what changed: nothing, when nothing did', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    const before = await repo.getPlaylistList()
    account.calls.length = 0
    const result = await sync(account, repo)
    expect(account.calls).toEqual(['profile', 'liked 0', 'playlists 0', 'home'])
    expect(result.summary).toMatchObject({
      likedCopy: true,
      likedCount: 3,
      playlistCount: 2,
      created: 0,
      updated: 0,
      added: 0,
      removed: 0,
    })
    expect(await repo.getPlaylistList()).toEqual(before)
  })

  it("neither wait nor write for lists that didn't change", async () => {
    const repo = testRepo()
    // Sixty playlists: listing them takes two pages.
    const account = fakeAccount({
      playlists: Array.from({ length: 60 }, (_, index) => ({
        id: nativeId('p', index + 1),
        name: `Playlist ${index + 1}`,
        tracks: [spotifyTrack(100 + index)],
      })),
    })
    await sync(account, repo)
    account.calls.length = 0
    const writes = vi.spyOn(repo, 'putSettings')
    const pace = vi.fn(async () => {})
    const result = await sync(account, repo, { pace })
    expect(account.calls).toEqual(['profile', 'liked 0', 'playlists 0', 'playlists 50', 'home'])
    // Only before the second page of the list.
    expect(pace).toHaveBeenCalledTimes(1)
    // What the sync did and the home: no list's state is written again.
    expect(writes.mock.calls.flatMap(([values]) => Object.keys(values)).sort()).toEqual(
      [HOME_KEY, META_KEY].sort(),
    )
    expect(result.summary).toMatchObject({ playlistCount: 60, complete: true })
  })

  it("bring in Spotify's changes, keeping the user's", async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    const road = playlistCopyId(P1)
    const liked = await likedId()

    // The user's changes: Road trip's last song to the top, one song taken out, one of their own
    // added, Quiet renamed.
    const s14 = spotifyTrack(14).id
    await repo.moveItems(road, [s14], 'top')
    await repo.removeTracks(road, [spotifyTrack(12).id])
    await repo.addTracks(road, [track(1)])
    await repo.updatePlaylist(playlistCopyId(P2), { name: 'My quiet' })

    // Spotify's changes: a new like, an unlike, Road trip gets a song after 13 and loses 11, and
    // its name and description change; Quiet gets a new description.
    account.data.liked = [spotifyTrack(4), spotifyTrack(1), spotifyTrack(3)].map((t) => ({
      track: t,
    }))
    account.data.playlists[0] = {
      id: P1,
      name: 'Road trip 2026',
      description: 'Louder',
      tracks: [spotifyTrack(12), spotifyTrack(13), spotifyTrack(15), spotifyTrack(14)],
    }
    account.data.playlists[1] = {
      id: P2,
      name: 'Quiet',
      description: 'Now with words',
      tracks: spotifyTracks(21, 22),
    }
    const result = await sync(account, repo)

    expect(await titles(repo, liked)).toEqual([
      'Spotify song 4',
      'Spotify song 1',
      'Spotify song 3',
    ])
    // 14 stays on top where the user put it; 12 stays out; 15 follows 13; 11 went; the user's
    // song stays.
    expect(await titles(repo, road)).toEqual([
      'Spotify song 14',
      'Spotify song 13',
      'Spotify song 15',
      'Song 1',
    ])
    expect((await repo.getPlaylistView(road))?.playlist).toMatchObject({
      name: 'Road trip 2026',
      description: 'Louder',
    })
    expect((await repo.getPlaylistView(playlistCopyId(P2)))?.playlist).toMatchObject({
      name: 'My quiet',
      description: 'Now with words',
    })
    expect(result.summary).toMatchObject({ updated: 3, added: 2, removed: 2 })
  })

  it('read all liked songs again when the count changed deep in the list', async () => {
    const repo = testRepo()
    const account = fakeAccount({ liked: spotifyTracks(1, 80).map((t) => ({ track: t })) })
    await sync(account, repo)
    account.calls.length = 0
    account.data.liked.splice(70, 1)
    await sync(account, repo)
    expect(account.calls.filter((call) => call.startsWith('liked'))).toEqual([
      'liked 0',
      'liked 50',
    ])
    expect(await titles(repo, await likedId())).toHaveLength(79)
  })

  it("count Spotify's items it can't read, so the count still tells changes apart", async () => {
    const repo = testRepo()
    const account = fakeAccount({ likedOthers: 2 })
    await sync(account, repo)
    account.calls.length = 0
    await sync(account, repo)
    expect(account.calls.filter((call) => call.startsWith('liked'))).toEqual(['liked 0'])
  })

  it('leave a copy the user deleted deleted', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    await repo.deletePlaylist(playlistCopyId(P2))
    await repo.deletePlaylist(await likedId())
    account.calls.length = 0
    let result = await sync(account, repo)
    expect(result.summary.dismissed).toBe(2)
    expect(await playlistNames(repo)).not.toContain('Quiet')
    expect(await playlistNames(repo)).not.toContain(LIKED_NAME)
    // Even when Spotify changes it, and without reading it again.
    account.data.playlists[1]?.tracks.push(spotifyTrack(23))
    account.data.liked.unshift({ track: spotifyTrack(5) })
    account.calls.length = 0
    result = await sync(account, repo)
    expect(account.calls).toEqual(['profile', 'playlists 0', 'home'])
    expect(result.summary.dismissed).toBe(2)
    expect(await playlistNames(repo)).not.toContain('Quiet')
  })

  it('stop following a playlist that left the Spotify library, and keep its copy', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    account.data.playlists.splice(1, 1)
    const result = await sync(account, repo)
    expect(result.summary).toMatchObject({ departed: 1, playlistCount: 1 })
    expect(await titles(repo, playlistCopyId(P2))).toEqual(['Spotify song 21', 'Spotify song 22'])
    expect([...(await readState(repo)).lists.keys()].sort()).toEqual(['liked', P1].sort())
    // If it comes back, its copy is adopted again, never made twice.
    account.data.playlists.push({ id: P2, name: 'Quiet', tracks: spotifyTracks(21, 23) })
    await sync(account, repo)
    expect(await titles(repo, playlistCopyId(P2))).toEqual([
      'Spotify song 21',
      'Spotify song 22',
      'Spotify song 23',
    ])
    expect((await playlistNames(repo)).filter((name) => name === 'Quiet')).toHaveLength(1)
  })

  it('adopt a copy that is already there, adding what it lacks and removing nothing', async () => {
    const repo = testRepo()
    // E.g. from a backup, or from another device through library sync.
    await repo.createPlaylist({
      id: playlistCopyId(P1),
      name: 'Road trip (mine)',
      tracks: [spotifyTrack(12), track(1)],
    })
    const account = fakeAccount()
    const result = await sync(account, repo)
    expect(result.summary).toMatchObject({ created: 2, updated: 1 })
    expect(await titles(repo, playlistCopyId(P1))).toEqual([
      'Spotify song 11',
      'Spotify song 12',
      'Spotify song 13',
      'Spotify song 14',
      'Song 1',
    ])
    // Its name stays the user's.
    expect((await repo.getPlaylistView(playlistCopyId(P1)))?.playlist.name).toBe('Road trip (mine)')
    expect((await readState(repo)).lists.get(P1)?.userTouched).toBe(true)
  })

  it("follow another account's library when the browser's login changed", async () => {
    const repo = testRepo()
    const first = fakeAccount()
    await sync(first, repo)
    const second = fakeAccount({
      username: 'second-user',
      displayName: 'Second User',
      liked: [{ track: spotifyTrack(9) }],
      playlists: [
        { id: P2, name: 'Quiet', tracks: spotifyTracks(21, 22) },
        { id: nativeId('p', 3), name: 'Theirs', tracks: [spotifyTrack(41)] },
      ],
    })
    const result = await sync(second, repo)
    expect(result.account).toBe(await accountKeyOf('second-user'))
    // The first account's copies stay, as ordinary playlists; the shared playlist has one copy.
    expect(await playlistNames(repo)).toEqual([
      'Liked songs',
      'Downloads',
      LIKED_NAME,
      'Road trip',
      'Quiet',
      LIKED_NAME,
      'Theirs',
    ])
    expect(await titles(repo, await likedId('second-user'))).toEqual(['Spotify song 9'])
    const state = await readState(repo)
    expect(state.meta?.account).toBe(await accountKeyOf('second-user'))
    expect([...state.lists.keys()].sort()).toEqual(['liked', P2, nativeId('p', 3)].sort())
  })
})

describe('limits and failures', () => {
  it('stops at the limits and says so', async () => {
    const repo = testRepo()
    const account = fakeAccount({ liked: spotifyTracks(1, 120).map((t) => ({ track: t })) })
    account.data.playlists[0] = { id: P1, name: 'Long', tracks: spotifyTracks(200, 450) }
    account.data.playlists.push({ id: nativeId('p', 3), name: 'Third', tracks: [] })
    const result = await sync(account, repo, {
      limits: { likedSongs: 60, playlists: 2, playlistTracks: 150 },
    })
    expect(result.summary).toMatchObject({ likedCount: 60, playlistCount: 2, complete: false })
    expect(await titles(repo, await likedId())).toHaveLength(60)
    expect(await titles(repo, playlistCopyId(P1))).toHaveLength(150)
    expect(await playlistNames(repo)).not.toContain('Third')
  })

  it('stops following a playlist that left, whatever limit liked songs reached', async () => {
    const repo = testRepo()
    const account = fakeAccount({ liked: spotifyTracks(1, 120).map((t) => ({ track: t })) })
    const limits = { likedSongs: 60 }
    expect((await sync(account, repo, { limits })).summary.complete).toBe(false)
    account.data.playlists.splice(1, 1)
    account.calls.length = 0
    const result = await sync(account, repo, { limits })
    // Liked songs didn't change, and the copy still holds only the first 60.
    expect(account.calls.filter((call) => call.startsWith('liked'))).toEqual(['liked 0'])
    expect(result.summary).toMatchObject({ departed: 1, complete: false, playlistCount: 1 })
    expect([...(await readState(repo)).lists.keys()].sort()).toEqual(['liked', P1].sort())
  })

  it('reads playlists until its budget of requests is spent, and the next sync goes on', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    const P3 = nativeId('p', 3)
    account.data.playlists.push({ id: P3, name: 'Third', tracks: [spotifyTrack(31)] })
    // The profile, liked songs, the list of playlists and one playlist.
    const limits = { requests: 4 }
    let result = await sync(account, repo, { limits })
    expect(result.summary).toMatchObject({ pending: 2, playlistCount: 1, complete: true })
    expect(result.summary.home).toBe(true)
    expect(await playlistNames(repo)).toContain('Road trip')
    expect(await playlistNames(repo)).not.toContain('Quiet')
    // Meanwhile Road trip left the Spotify library: the listing still tells.
    account.data.playlists.splice(0, 1)
    account.calls.length = 0
    result = await sync(account, repo, { limits })
    expect(account.calls).toEqual(['profile', 'liked 0', 'playlists 0', `tracks ${P2} 0`, 'home'])
    expect(result.summary).toMatchObject({ pending: 1, departed: 1, playlistCount: 1 })
    result = await sync(account, repo, { limits })
    expect(result.summary).toMatchObject({ pending: 0, playlistCount: 2 })
    expect(await playlistNames(repo)).toContain('Third')
  })

  it("refuses an account Spotify doesn't name, and writes nothing", async () => {
    const repo = testRepo()
    const account = fakeAccount({ username: undefined })
    const error = await sync(account, repo).catch((e: unknown) => e)
    expect(isFxmError(error, 'Parse')).toBe(true)
    expect(await repo.getSettings('spotify-account.')).toEqual(new Map())
    expect(await playlistNames(repo)).toEqual(['Liked songs', 'Downloads'])
  })

  it('skips a playlist that went away while it ran, and goes on', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    account.failures.set(`tracks ${P1}`, new FxmError('NotFound', 'gone'))
    const result = await sync(account, repo)
    expect(result.summary).toMatchObject({ skipped: 1, playlistCount: 1, complete: false })
    expect(await playlistNames(repo)).toContain('Quiet')
    expect(await playlistNames(repo)).not.toContain('Road trip')
    // Not complete: a playlist it couldn't read isn't taken for one that left.
    expect(result.summary.departed).toBe(0)
  })

  it('skips a playlist Spotify refuses or answers unreadably for, and goes on', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    const P3 = nativeId('p', 3)
    account.data.playlists.push({ id: P3, name: 'Third', tracks: [spotifyTrack(31)] })
    account.failures.set(
      `tracks ${P1}`,
      new SpotifyError('graphql', 'Spotify answered GenericError'),
    )
    account.failures.set(`tracks ${P2}`, new SpotifyError('forbidden', 'HTTP 403'))
    let result = await sync(account, repo)
    expect(result.summary).toMatchObject({ skipped: 2, playlistCount: 1, complete: false })
    expect(result.summary.home).toBe(true)
    expect(await playlistNames(repo)).toContain('Third')
    expect(await playlistNames(repo)).not.toContain('Road trip')
    expect((await readState(repo)).meta?.lastSyncAt).toBe(result.summary.at)
    // Later, one that changed on Spotify can't be read: its copy and its state stay as they were.
    account.failures.clear()
    await sync(account, repo)
    const before = await repo.getSetting(listKey(P1))
    account.data.playlists[0]?.tracks.push(spotifyTrack(15))
    account.failures.set(`tracks ${P1}`, new SpotifyError('bad-response', 'unreadable'))
    result = await sync(account, repo)
    expect(result.summary).toMatchObject({ skipped: 1, playlistCount: 3, complete: false })
    expect(await repo.getSetting(listKey(P1))).toEqual(before)
    expect(await titles(repo, playlistCopyId(P1))).toHaveLength(4)
  })

  it('stops on any other failure, keeping what it did, and goes on next time', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    const failure = new FxmError('Network', 'offline')
    account.failures.set(`tracks ${P2}`, failure)
    await expect(sync(account, repo)).rejects.toBe(failure)
    expect(await playlistNames(repo)).toContain('Road trip')
    expect((await readState(repo)).meta?.lastSyncAt).toBeUndefined()
    account.failures.clear()
    account.calls.length = 0
    const result = await sync(account, repo)
    // Road trip and the liked songs were done already.
    expect(account.calls).toEqual(['profile', 'liked 0', 'playlists 0', `tracks ${P2} 0`, 'home'])
    expect(result.summary).toMatchObject({ created: 1, playlistCount: 2 })
  })

  it("keeps the copies when the home can't be read", async () => {
    const repo = testRepo()
    const account = fakeAccount()
    account.failures.set('home', new FxmError('Unavailable', 'home changed'))
    const result = await sync(account, repo)
    expect(result.summary).toMatchObject({ home: false, created: 3 })
    expect(await repo.getSetting(HOME_KEY)).toBeUndefined()
    expect((await readState(repo)).meta?.lastSyncAt).toBe(result.summary.at)
  })

  it('stops writing its state once its guard says the account was disconnected', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    let connected = true
    // Disconnected while it reads the first playlist.
    const pace = async () => {
      connected = false
    }
    const error = await sync(account, repo, { pace, guard: () => connected }).catch(
      (e: unknown) => e,
    )
    expect((error as Error).name).toBe('AbortError')
    const state = await readState(repo)
    expect([...state.lists.keys()]).toEqual(['liked'])
    expect(state.meta?.lastSyncAt).toBeUndefined()
    expect(await repo.getSetting(HOME_KEY)).toBeUndefined()
  })

  it('stops between two requests when cancelled', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    const controller = new AbortController()
    const reason = new Error('stopped')
    const pace = async () => controller.abort(reason)
    await expect(sync(account, repo, { signal: controller.signal, pace })).rejects.toBe(reason)
    expect(account.calls).toEqual(['profile', 'liked 0', 'playlists 0'])
    expect(await playlistNames(repo)).toContain(LIKED_NAME)
  })
})

describe("answers it can't read", () => {
  it('never makes empty copies of lists Spotify counts songs in, nor remembers them', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    account.blank.add('liked')
    account.blank.add(`tracks ${P1}`)
    const result = await sync(account, repo)
    expect(result.summary).toMatchObject({
      skipped: 2,
      complete: false,
      likedCopy: false,
      playlistCount: 1,
    })
    expect(await playlistNames(repo)).not.toContain(LIKED_NAME)
    expect(await playlistNames(repo)).not.toContain('Road trip')
    expect([...(await readState(repo)).lists.keys()]).toEqual([P2])
    // Once Spotify answers readably, they are copied.
    account.blank.clear()
    const next = await sync(account, repo)
    expect(next.summary).toMatchObject({ created: 2, complete: true, likedCopy: true })
  })

  it('leaves a copy as it was, taking nothing out, and reads no further page', async () => {
    const repo = testRepo()
    const account = fakeAccount({ liked: spotifyTracks(1, 120).map((t) => ({ track: t })) })
    await sync(account, repo)
    const before = await readState(repo)
    // Both lists changed on Spotify, but answer with nothing the provider can read.
    account.data.liked.unshift({ track: spotifyTrack(200) })
    account.data.playlists[0]?.tracks.push(spotifyTrack(15))
    account.blank.add('liked')
    account.blank.add(`tracks ${P1}`)
    account.calls.length = 0
    const result = await sync(account, repo)
    expect(result.summary).toMatchObject({
      skipped: 2,
      removed: 0,
      complete: false,
      likedCopy: true,
      likedCount: 120,
    })
    expect(await titles(repo, await likedId())).toHaveLength(120)
    expect(await titles(repo, playlistCopyId(P1))).toHaveLength(4)
    const after = await readState(repo)
    expect(after.lists.get('liked')).toEqual(before.lists.get('liked'))
    expect(after.lists.get(P1)).toEqual(before.lists.get(P1))
    expect(account.calls.filter((call) => call.startsWith('liked'))).toEqual(['liked 0'])
    expect(account.calls.filter((call) => call.startsWith(`tracks ${P1}`))).toEqual([
      `tracks ${P1} 0`,
    ])
  })

  it('keeps following its playlists when their list reads empty, though Spotify counts some', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    account.blank.add('playlists')
    const result = await sync(account, repo)
    expect(result.summary).toMatchObject({ departed: 0, complete: false, playlistCount: 2 })
    expect([...(await readState(repo)).lists.keys()].sort()).toEqual(['liked', P1, P2].sort())
  })
})

describe('forgetSync', () => {
  it('stops following the account and keeps every copy', async () => {
    const repo = testRepo()
    await sync(fakeAccount(), repo)
    expect(await forgetSync(repo)).toEqual({ removed: 0, kept: 3 })
    expect(await repo.getSettings('spotify-account.')).toEqual(new Map())
    expect(await repo.getSetting(META_KEY)).toBeUndefined()
    expect(await playlistNames(repo)).toContain('Road trip')
  })

  it('removes, when asked, only the copies nobody changed', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    await repo.addTracks(playlistCopyId(P1), [track(1)])
    expect(await forgetSync(repo, { removeCopies: true })).toEqual({ removed: 2, kept: 1 })
    expect(await playlistNames(repo)).toEqual(['Liked songs', 'Downloads', 'Road trip'])
  })

  it('never removes a copy the sync found already there', async () => {
    const repo = testRepo()
    await repo.createPlaylist({
      id: playlistCopyId(P2),
      name: 'Quiet',
      tracks: spotifyTracks(21, 22),
    })
    await sync(fakeAccount(), repo)
    expect((await readState(repo)).lists.get(P2)?.userTouched).toBe(true)
    expect(await forgetSync(repo, { removeCopies: true })).toEqual({ removed: 2, kept: 1 })
    expect(await playlistNames(repo)).toContain('Quiet')
  })

  it('keeps a copy the user changed while a sync ran, even before it got there', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    account.data.playlists[0]?.tracks.push(spotifyTrack(15))
    // The user adds a song to Road trip's copy after the sync began, before it gets there.
    let edited = false
    const pace = async () => {
      if (edited) return
      edited = true
      await repo.addTracks(playlistCopyId(P1), [track(1)])
    }
    await sync(account, repo, { pace })
    expect((await readState(repo)).lists.get(P1)?.userTouched).toBe(true)
    expect(await forgetSync(repo, { removeCopies: true })).toEqual({ removed: 2, kept: 1 })
    expect(await playlistNames(repo)).toContain('Road trip')
  })

  it('lets a later sync adopt the copies it kept, so none is made twice', async () => {
    const repo = testRepo()
    const account = fakeAccount()
    await sync(account, repo)
    await forgetSync(repo)
    const result = await sync(account, repo)
    expect(result.summary.created).toBe(0)
    expect(await playlistNames(repo)).toEqual([
      'Liked songs',
      'Downloads',
      LIKED_NAME,
      'Road trip',
      'Quiet',
    ])
    expect(await repo.getSetting(listKey(P1))).toMatchObject({ userTouched: true })
  })
})
