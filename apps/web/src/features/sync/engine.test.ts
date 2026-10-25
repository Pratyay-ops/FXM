import { formatId, type JsonObject } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { LibraryRepo } from '../../db/repo'
import { DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID } from '../../db/types'
import { testRepo, track, tracks } from '../../test/library-fixtures'
import { createMemoryBaseStore } from './base-store'
import {
  createSyncGist,
  findSyncGists,
  GIST_DESCRIPTION,
  readSyncGist,
  type SyncDeps,
  SyncError,
  syncLibrary,
} from './engine'
import { MANIFEST_FILE, parseManifest, SYNC_FORMAT_VERSION } from './gist-format'
import { createGitHubClient } from './github'
import { keepOtherVersion, listConflicts } from './library-io'
import { createFakeGitHub, type FakeGitHub } from './testing/fake-github'

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'

/** One device: its own library, base store and app settings, on the shared fake GitHub. */
function device(github: FakeGitHub, overrides: Partial<SyncDeps> = {}) {
  const repo = testRepo()
  const bases = createMemoryBaseStore()
  let settings: JsonObject = { catalogMode: 'music', theme: 'dark' }
  const deps: SyncDeps = {
    repo,
    github: createGitHubClient({ token: TOKEN, fetch: github.fetch }),
    bases,
    login: 'octo',
    pause: async () => {},
    appSettings: {
      defaults: { catalogMode: 'music', theme: 'dark' },
      read: () => settings,
      apply: (next) => {
        settings = { ...settings, ...next }
      },
    },
    ...overrides,
  }
  return {
    repo,
    bases,
    deps,
    settings: () => settings,
    setSettings: (next: JsonObject) => {
      settings = { ...settings, ...next }
    },
  }
}

function setup() {
  const github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
  return { github, a: device(github), b: device(github) }
}

async function names(repo: LibraryRepo): Promise<string[]> {
  return (await repo.getPlaylistList()).items.map((item) => item.name)
}

async function playlistByName(repo: LibraryRepo, name: string) {
  const item = (await repo.getPlaylistList()).items.find((entry) => entry.name === name)
  return item === undefined ? undefined : repo.getPlaylistView(item.id)
}

async function likedIds(repo: LibraryRepo) {
  return repo.getOrder(LIKED_PLAYLIST_ID)
}

async function sync(deps: SyncDeps, gistId: string) {
  const report = await syncLibrary(deps, gistId)
  if (report === null) throw new Error('Expected a sync')
  return report
}

async function failure(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SyncError) return error
    throw error
  }
  throw new Error('Expected a SyncError')
}

describe('createSyncGist', () => {
  it('creates a secret gist with this device’s library, and nothing that stays on it', async () => {
    const { github, a } = setup()
    await a.repo.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    await a.repo.like(track(1))
    await a.repo.addDownload(track(2))
    await a.repo.startImport({ kind: 'csv', label: 'list.csv', total: 3 })

    const report = await createSyncGist(a.deps)

    expect(report).toMatchObject({ created: true, pushed: true, pulled: 0 })
    const gist = github.gists.get(report.gistId)
    expect(gist).toMatchObject({ public: false, description: GIST_DESCRIPTION, owner: 'octo' })
    const manifest = parseManifest(gist?.files.get(MANIFEST_FILE))
    expect(manifest.version).toBe(SYNC_FORMAT_VERSION)
    expect(manifest.parts.map((part) => part.table).sort()).toEqual([
      'likes',
      'orders',
      'playlists',
      'tracks',
    ])
    const everything = [...(gist?.files.values() ?? [])].join('\n')
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain('list.csv')
    expect(everything).not.toMatch(/"id":"local:playlist:downloads"/)
    expect((await a.bases.get(report.gistId))?.revision).toBe(manifest.revision)
  })

  it('creates a large library in several requests, the manifest last', async () => {
    const github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
    const a = device(github, { maxRequestBytes: 20_000 })
    await a.repo.createPlaylist({ name: 'Big', tracks: tracks(400) })
    const report = await createSyncGist(a.deps)
    const writes = github.writes()
    expect(writes.length).toBeGreaterThan(2)
    const last = writes.at(-1)?.body as { files: object } | undefined
    expect(Object.keys(last?.files ?? {})).toContain(MANIFEST_FILE)
    const b = device(github)
    await sync(b.deps, report.gistId)
    expect((await playlistByName(b.repo, 'Big'))?.playlist.trackIds).toHaveLength(400)
  })

  it('deletes a half-made gist when a later request fails', async () => {
    const github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
    const a = device(github, { maxRequestBytes: 20_000 })
    await a.repo.createPlaylist({ name: 'Big', tracks: tracks(400) })
    github.failNext('PATCH', '/gists/', 500)
    expect((await failure(createSyncGist(a.deps))).code).toBe('failed')
    expect(github.gists.size).toBe(0)
  })

  it('says so when the token may not create gists', async () => {
    const github = createFakeGitHub({ [TOKEN]: { login: 'octo', canWriteGists: false } })
    expect((await failure(createSyncGist(device(github).deps))).code).toBe('forbidden')
  })
})

describe('syncLibrary', () => {
  it('brings the library to another device, keeping what stays on each device', async () => {
    const { a, b } = setup()
    const mix = await a.repo.createPlaylist({ name: 'Mix', tracks: tracks(4) })
    await a.repo.moveItems(mix, [track(4).id], 'top')
    await a.repo.like(track(2))
    await a.repo.follow({
      id: formatId('ytm', 'artist', 'UC1'),
      source: 'ytm',
      name: 'Band',
      artwork: [],
    })
    await a.repo.recordPlay({ track: track(3), playedMs: 1000, completed: true, skipped: false })
    await a.repo.addDownload(track(1))
    a.setSettings({ theme: 'light' })
    const { gistId } = await createSyncGist(a.deps)

    await b.repo.addDownload(track(9))
    const report = await sync(b.deps, gistId)

    expect(report.pulled).toBeGreaterThan(0)
    expect(report.copies).toEqual([])
    const view = await playlistByName(b.repo, 'Mix')
    expect(view?.playlist.trackIds).toEqual([4, 1, 2, 3].map((n) => track(n).id))
    expect(await likedIds(b.repo)).toEqual([track(2).id])
    expect((await b.repo.listFollows('artist')).map((item) => item.name)).toEqual(['Band'])
    expect((await b.repo.history()).map((entry) => entry.trackId)).toEqual([track(3).id])
    expect(b.settings()).toMatchObject({ theme: 'light' })
    // Downloads stay each device's own.
    expect(await b.repo.getOrder(DOWNLOADS_PLAYLIST_ID)).toEqual([track(9).id])
  })

  it('merges two libraries without losing anything on either side', async () => {
    const { a, b } = setup()
    await a.repo.createPlaylist({ name: 'From A', tracks: [track(1)] })
    await a.repo.like(track(1))
    const { gistId } = await createSyncGist(a.deps)
    await b.repo.createPlaylist({ name: 'From B', tracks: [track(2)] })
    await b.repo.like(track(2))

    const joined = await sync(b.deps, gistId)
    expect(joined.pushed).toBe(true)
    await sync(a.deps, gistId)

    for (const repo of [a.repo, b.repo]) {
      expect((await names(repo)).sort()).toEqual(['Downloads', 'From A', 'From B', 'Liked songs'])
      expect((await likedIds(repo)).sort()).toEqual([track(1).id, track(2).id].sort())
    }
  })

  it('carries deletions to the other device, and never brings them back', async () => {
    const { a, b } = setup()
    const one = await a.repo.createPlaylist({ name: 'One' })
    await a.repo.createPlaylist({ name: 'Two' })
    await a.repo.like(track(1))
    await a.repo.like(track(2))
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)

    await a.repo.deletePlaylist(one)
    await a.repo.unlike(track(1).id)
    await sync(a.deps, gistId)
    await sync(b.deps, gistId)
    await sync(a.deps, gistId)

    for (const repo of [a.repo, b.repo]) {
      expect(await names(repo)).not.toContain('One')
      expect(await names(repo)).toContain('Two')
      expect(await likedIds(repo)).toEqual([track(2).id])
    }
  })

  it('keeps both versions when two devices renamed a playlist, until the user picks one', async () => {
    const { a, b } = setup()
    const mix = await a.repo.createPlaylist({ name: 'Mix', tracks: tracks(2) })
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)

    await a.repo.updatePlaylist(mix, { name: 'A name' })
    await sync(a.deps, gistId)
    await b.repo.updatePlaylist(mix, { name: 'B name' })
    const report = await sync(b.deps, gistId)

    expect(report.copies).toHaveLength(1)
    expect((await names(b.repo)).sort()).toEqual([
      'A name (other version)',
      'B name',
      'Downloads',
      'Liked songs',
    ])
    await sync(a.deps, gistId)
    expect((await names(a.repo)).sort()).toEqual((await names(b.repo)).sort())
    const [conflict] = await listConflicts(a.repo)
    expect(conflict).toMatchObject({ original: { id: mix, name: 'B name' } })

    // A keeps the other version; both devices settle on it.
    await keepOtherVersion(a.repo, conflict?.copy.id ?? mix)
    await sync(a.deps, gistId)
    await sync(b.deps, gistId)
    for (const repo of [a.repo, b.repo]) {
      expect((await names(repo)).sort()).toEqual(['A name', 'Downloads', 'Liked songs'])
      expect(await listConflicts(repo)).toEqual([])
    }
  })

  it('keeps a playlist deleted on another device but changed here, with a notice', async () => {
    const { a, b } = setup()
    const mix = await a.repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)

    await a.repo.deletePlaylist(mix)
    await sync(a.deps, gistId)
    await b.repo.addTracks(mix, [track(2)])
    const kept = await sync(b.deps, gistId)

    expect(kept.notices).toEqual([{ kind: 'kept-here', playlistId: mix, name: 'Mix' }])
    expect((await b.repo.getPlaylistView(mix))?.playlist.trackIds).toHaveLength(2)
    // The device that deleted it gets it back.
    await sync(a.deps, gistId)
    expect((await a.repo.getPlaylistView(mix))?.playlist.trackIds).toHaveLength(2)
  })

  it('brings back a playlist deleted here when another device changed it, with a notice', async () => {
    const { a, b } = setup()
    const mix = await a.repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)

    await a.repo.addTracks(mix, [track(2)])
    await sync(a.deps, gistId)
    await b.repo.deletePlaylist(mix)
    const restored = await sync(b.deps, gistId)

    expect(restored.notices).toEqual([{ kind: 'restored', playlistId: mix, name: 'Mix' }])
    expect((await b.repo.getPlaylistView(mix))?.playlist.trackIds).toHaveLength(2)
  })

  it('asks GitHub only whether the gist changed when nothing did', async () => {
    const { github, a } = setup()
    await a.repo.like(track(1))
    const { gistId } = await createSyncGist(a.deps)
    const before = github.requests.length

    const report = await sync(a.deps, gistId)

    expect(report).toMatchObject({ pushed: false, pulled: 0 })
    const requests = github.requests.slice(before)
    expect(requests.map((request) => request.method)).toEqual(['GET'])
    expect(requests[0]?.headers['if-none-match']).toBeDefined()
    // A sync that a change here started contacts GitHub only when something changed.
    expect(await syncLibrary(a.deps, gistId, { skipIfUnchanged: true })).toBeNull()
    expect(github.requests.length).toBe(before + 1)
  })

  it('uploads only the parts that changed', async () => {
    const { github, a } = setup()
    await a.repo.createPlaylist({ name: 'Mix', tracks: tracks(1500) })
    const { gistId } = await createSyncGist(a.deps)
    const trackParts = parseManifest(
      github.gists.get(gistId)?.files.get(MANIFEST_FILE),
    ).parts.filter((part) => part.table === 'tracks')
    expect(trackParts.length).toBeGreaterThan(4)

    await a.repo.like(track(1))
    const before = github.requests.length
    await sync(a.deps, gistId)

    const patch = github.requests.slice(before).find((request) => request.method === 'PATCH')
    const body = patch?.body as { files: Record<string, unknown> } | undefined
    const uploaded = Object.entries(body?.files ?? {})
      .filter(([, file]) => file !== null)
      .map(([name]) => name)
    // A like refreshes its track's metadata: one part of the track cache goes up, not all.
    expect(uploaded.filter((name) => name.startsWith('fxm-tracks-'))).toHaveLength(1)
    expect(uploaded.filter((name) => name.startsWith('fxm-playlists-'))).toHaveLength(1)
    expect(uploaded).toContain(MANIFEST_FILE)
  })

  it('merges again when another device pushes while this one syncs', async () => {
    const { github, a, b } = setup()
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)
    await a.repo.like(track(7))
    await b.repo.like(track(8))
    // B pushes right after A read the gist, before A's last check.
    let reads = 0
    const remove = github.hook(async (request) => {
      if (request.method !== 'GET' || request.headers['if-none-match'] === undefined)
        return undefined
      reads++
      if (reads !== 2) return undefined
      remove()
      await sync(b.deps, gistId)
      return undefined
    })

    const report = await sync(a.deps, gistId)
    await sync(b.deps, gistId)

    expect(report.pushed).toBe(true)
    for (const repo of [a.repo, b.repo]) {
      expect((await likedIds(repo)).sort()).toEqual([track(7).id, track(8).id].sort())
    }
  })

  it('loses nothing when another device’s push lands just before this one’s', async () => {
    const { github, a, b } = setup()
    // So that this push overwrites the other one instead of being refused (see the next test).
    github.ignoresMissingDeletes = true
    await a.repo.createPlaylist({ name: 'Mix' })
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)
    await a.repo.follow({
      id: formatId('ytm', 'artist', 'UC1'),
      source: 'ytm',
      name: 'Band',
      artwork: [],
    })
    await b.repo.like(track(9))
    // B's whole sync runs after A's last check and before A's upload: A overwrites it.
    const remove = github.hook(async (request) => {
      if (request.method !== 'PATCH') return undefined
      remove()
      await sync(b.deps, gistId)
      return undefined
    })
    await sync(a.deps, gistId)

    // The gist is readable, and B's like comes back with B's next sync.
    expect((await readSyncGist(a.deps.github, gistId, 'octo')).snapshot.follows).toHaveLength(1)
    await sync(b.deps, gistId)
    await sync(a.deps, gistId)
    for (const repo of [a.repo, b.repo]) {
      expect(await likedIds(repo)).toEqual([track(9).id])
      expect(await repo.listFollows('artist')).toHaveLength(1)
    }
  })

  it('reads and merges again when GitHub refuses an upload that raced another push', async () => {
    const { github, a, b } = setup()
    await a.repo.createPlaylist({ name: 'Mix' })
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)
    await a.repo.like(track(7))
    await b.repo.like(track(8))
    const remove = github.hook(async (request) => {
      if (request.method !== 'PATCH') return undefined
      remove()
      await sync(b.deps, gistId)
      return undefined
    })

    const report = await sync(a.deps, gistId)
    await sync(b.deps, gistId)

    expect(report.pushed).toBe(true)
    for (const repo of [a.repo, b.repo]) {
      expect((await likedIds(repo)).sort()).toEqual([track(7).id, track(8).id].sort())
    }
  })

  it('makes no second copy when a sync is retried after a failed upload', async () => {
    const { github, a, b } = setup()
    const mix = await a.repo.createPlaylist({ name: 'Mix' })
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)
    await a.repo.updatePlaylist(mix, { name: 'A name' })
    await sync(a.deps, gistId)
    await b.repo.updatePlaylist(mix, { name: 'B name' })

    github.dropNext('PATCH', '/gists/')
    expect((await failure(syncLibrary(b.deps, gistId))).code).toBe('network')
    const retried = await sync(b.deps, gistId)

    expect(retried.copies).toEqual([])
    expect((await names(b.repo)).filter((name) => name.includes('other version'))).toHaveLength(1)
  })

  it('takes no action on a read older than the last push', async () => {
    const { github, a } = setup()
    await a.repo.like(track(1))
    const { gistId } = await createSyncGist(a.deps)
    const gist = github.gists.get(gistId)
    const old = new Map(gist?.files)
    await a.repo.like(track(2))
    await sync(a.deps, gistId)
    // GitHub serves the gist as it was before that push.
    const remove = github.hook((request) => {
      if (request.method !== 'GET') return undefined
      remove()
      const files = Object.fromEntries(
        [...old].map(([name, content]) => [name, { filename: name, content }]),
      )
      return new Response(JSON.stringify({ id: gistId, owner: { login: 'octo' }, files }), {
        status: 200,
        headers: { etag: 'W/"old"' },
      })
    })
    const before = github.writes().length
    const report = await sync(a.deps, gistId)
    expect(report).toMatchObject({ pushed: false, pulled: 0 })
    expect(github.writes().length).toBe(before)
    expect((await likedIds(a.repo)).sort()).toEqual([track(1).id, track(2).id].sort())
  })

  it('refuses gists it must not touch, leaving the library as it is', async () => {
    const { github, a } = setup()
    await a.repo.like(track(1))
    const { gistId } = await createSyncGist(a.deps)
    const manifest = JSON.parse(github.gists.get(gistId)?.files.get(MANIFEST_FILE) ?? '{}')

    github.editGist(gistId, { [MANIFEST_FILE]: JSON.stringify({ ...manifest, version: 99 }) })
    expect((await failure(syncLibrary(a.deps, gistId))).code).toBe('too-new')

    // A newer revision whose part was edited outside FXM.
    const part = manifest.parts[0].file as string
    github.editGist(gistId, {
      [MANIFEST_FILE]: JSON.stringify({ ...manifest, revision: 'abcdefabcdefabcd' }),
      [part]: '{"broken":true}',
    })
    expect((await failure(syncLibrary(a.deps, gistId))).code).toBe('corrupt')

    const other = github.putGist('someone', { [MANIFEST_FILE]: JSON.stringify(manifest) })
    expect((await failure(syncLibrary(a.deps, other.id))).code).toBe('not-owner')

    github.gists.delete(gistId)
    expect((await failure(syncLibrary(a.deps, gistId))).code).toBe('gone')
    expect(await likedIds(a.repo)).toEqual([track(1).id])
  })

  it('reports GitHub’s rate limit with the time to wait', async () => {
    const { github, a } = setup()
    const { gistId } = await createSyncGist(a.deps)
    github.failNext('GET', '/gists/', 429, { message: 'slow down' }, { 'retry-after': '120' })
    const error = await failure(syncLibrary(a.deps, gistId))
    expect(error.code).toBe('rate-limited')
    expect(error.retryAfterMs).toBe(120_000)
  })
})

describe('what sync carries', () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = Date.UTC(2026, 9, 26, 12)

  function clocked(github: FakeGitHub, now: () => number) {
    return device(github, { now })
  }

  async function gistTracks(github: FakeGitHub, gistId: string) {
    return (
      await readSyncGist(
        createGitHubClient({ token: TOKEN, fetch: github.fetch }),
        gistId,
        'octo',
        { now: NOW },
      )
    ).snapshot
  }

  it('syncs the plays of the last 90 days, and never touches older ones', async () => {
    const github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
    const a = clocked(github, () => NOW)
    const b = clocked(github, () => NOW)
    const play = (n: number, playedAt: number) => ({
      track: track(n),
      playedAt,
      playedMs: 1000,
      completed: true,
      skipped: false,
    })
    await a.repo.recordPlay(play(1, NOW - 200 * DAY))
    await a.repo.recordPlay(play(2, NOW - DAY))
    const { gistId } = await createSyncGist(a.deps)
    const carried = await gistTracks(github, gistId)
    expect(carried.history.map((entry) => entry.trackId)).toEqual([track(2).id])

    await b.repo.recordPlay(play(3, NOW - 300 * DAY))
    await sync(b.deps, gistId)
    expect((await b.repo.history()).map((entry) => entry.trackId).sort()).toEqual(
      [track(2).id, track(3).id].sort(),
    )

    // Clearing the history on one device clears the synced plays on the other, not its older ones.
    await a.repo.clearHistory()
    await sync(a.deps, gistId)
    await sync(b.deps, gistId)
    expect((await b.repo.history()).map((entry) => entry.trackId)).toEqual([track(3).id])
  })

  it('never takes a play near the start of the window for a deletion', async () => {
    const github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
    let aNow = NOW
    const a = clocked(github, () => aNow)
    const b = clocked(github, () => NOW)
    await a.repo.recordPlay({
      track: track(1),
      playedAt: NOW - 88 * DAY,
      playedMs: 1,
      completed: true,
      skipped: false,
    })
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)
    // A's clock runs three days ahead: the play falls out of its window, and its next push lacks it.
    aNow = NOW + 3 * DAY
    await a.repo.like(track(5))
    await sync(a.deps, gistId)
    await sync(b.deps, gistId)
    expect((await b.repo.history()).map((entry) => entry.trackId)).toEqual([track(1).id])
    expect(await a.repo.history()).toHaveLength(1)
  })

  it('carries only the track metadata the library uses', async () => {
    const github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
    const a = clocked(github, () => NOW)
    await a.repo.saveTracks([track(50)])
    await a.repo.like(track(1))
    const { gistId } = await createSyncGist(a.deps)
    expect((await gistTracks(github, gistId)).tracks.map((row) => row.id)).toEqual([track(1).id])
  })

  it('lets new plays wait for a sync that pushes anyway', async () => {
    const github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
    const a = clocked(github, () => NOW)
    const b = clocked(github, () => NOW)
    const { gistId } = await createSyncGist(a.deps)
    await sync(b.deps, gistId)
    await a.repo.recordPlay({
      track: track(4),
      playedAt: NOW - 1000,
      playedMs: 1,
      completed: true,
      skipped: false,
    })
    const writes = github.writes().length

    const waited = await syncLibrary(a.deps, gistId, { pushBackground: false })
    expect(waited).toMatchObject({ pushed: false, deferred: true })
    expect(github.writes().length).toBe(writes)

    // An edit pushes, and takes the play along.
    await a.repo.like(track(9))
    expect(await syncLibrary(a.deps, gistId, { pushBackground: false })).toMatchObject({
      pushed: true,
    })
    await sync(b.deps, gistId)
    expect((await b.repo.history()).map((entry) => entry.trackId)).toEqual([track(4).id])
  })

  it('keeps at most two generations of parts in the gist', async () => {
    const { github, a } = setup()
    await a.repo.createPlaylist({ name: 'Mix', tracks: tracks(30) })
    const { gistId } = await createSyncGist(a.deps)
    for (let n = 31; n < 41; n++) {
      await a.repo.like(track(n))
      await sync(a.deps, gistId)
    }
    const gist = github.gists.get(gistId)
    const manifest = parseManifest(gist?.files.get(MANIFEST_FILE))
    expect(gist?.files.size).toBeLessThanOrEqual(2 * manifest.parts.length + 1)
    expect((await a.bases.get(gistId))?.files.sort()).toEqual(
      [...(gist?.files.keys() ?? [])].sort(),
    )
  })
})

describe('finding a sync gist', () => {
  it('finds the account’s sync gists, newest first, and reads one', async () => {
    const { github, a } = setup()
    github.putGist('octo', { 'notes.md': 'hello' })
    await a.repo.like(track(1))
    const { gistId } = await createSyncGist(a.deps)
    const found = await findSyncGists(a.deps.github)
    expect(found.map((gist) => gist.id)).toEqual([gistId])
    const read = await readSyncGist(a.deps.github, gistId, 'octo')
    expect(read.snapshot.likes).toHaveLength(1)
    expect((await failure(readSyncGist(a.deps.github, gistId, 'someone'))).code).toBe('not-owner')
  })

  it('finds none when the token can’t list secret gists', async () => {
    const { github, a } = setup()
    await createSyncGist(a.deps)
    github.listsSecretGists = false
    expect(await findSyncGists(a.deps.github)).toEqual([])
  })

  it('tells a gist that isn’t a sync gist', async () => {
    const { github, a } = setup()
    const notes = github.putGist('octo', { 'notes.md': 'hello' })
    expect((await failure(readSyncGist(a.deps.github, notes.id, 'octo'))).code).toBe(
      'not-sync-gist',
    )
  })
})
