import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { testRepo, track } from '../../test/library-fixtures'
import { createMemoryBaseStore } from './base-store'
import {
  confirmConnect,
  disconnectSync,
  prepareConnect,
  resetSyncEnvironment,
  setSyncEnvironment,
} from './controller'
import { createSyncGist, type SyncDeps, syncLibrary } from './engine'
import { createGitHubClient } from './github'
import { useSyncStore } from './sync-store'
import { createFakeGitHub, type FakeGitHub } from './testing/fake-github'

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'
const DAY = 24 * 60 * 60 * 1000

let github: FakeGitHub
let bases: ReturnType<typeof createMemoryBaseStore>

beforeEach(() => {
  github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
  bases = createMemoryBaseStore()
  setSyncEnvironment({ fetch: github.fetch, bases: () => bases })
})

afterEach(() => {
  resetSyncEnvironment()
  useSyncStore.setState(useSyncStore.getInitialState(), true)
})

function otherDevice(): SyncDeps {
  return {
    repo: testRepo(),
    github: createGitHubClient({ token: TOKEN, fetch: github.fetch }),
    bases: createMemoryBaseStore(),
    login: 'octo',
    appSettings: { read: () => ({}), apply: () => {} },
  }
}

const names = async () => (await getLibrary().getPlaylistList()).items.map((item) => item.name)

describe('setting sync up', () => {
  it('joins a gist this device synced with before as a first sync, keeping everything', async () => {
    const library = getLibrary()
    await library.createPlaylist({ name: 'One', tracks: [track(1)] })
    await library.createPlaylist({ name: 'Two', tracks: [track(2)] })
    await confirmConnect(await prepareConnect({ token: TOKEN }))
    const gistId = useSyncStore.getState().gistId ?? ''
    // Sync goes off here while this device still remembers the gist (an older FXM kept it).
    useSyncStore.getState().disconnect()
    expect(await bases.get(gistId)).toBeDefined()
    // Meanwhile another device deletes One.
    const other = otherDevice()
    await syncLibrary(other, gistId)
    const one = (await other.repo.getPlaylistList()).items.find((item) => item.name === 'One')
    if (one === undefined) throw new Error('missing')
    await other.repo.deletePlaylist(one.id)
    await syncLibrary(other, gistId)

    const plan = await prepareConnect({ token: TOKEN })
    expect(plan.gist?.id).toBe(gistId)
    await confirmConnect(plan)
    // "FXM merges the two and removes nothing."
    expect(await names()).toEqual(expect.arrayContaining(['One', 'Two']))
  })

  it('counts the plays sync carries, as the gist counts them', async () => {
    const library = getLibrary()
    for (const [n, ago] of [
      [1, 200 * DAY],
      [2, DAY],
    ] as const) {
      await library.recordPlay({
        track: track(n),
        playedAt: Date.now() - ago,
        playedMs: 1,
        completed: true,
        skipped: false,
      })
    }
    const plan = await prepareConnect({ token: TOKEN })
    expect(plan.local.plays).toBe(1)
    expect(plan.localHasData).toBe(true)
  })

  it('reports a found gist it can’t read, so the user can rewrite it', async () => {
    const other = otherDevice()
    await other.repo.like(track(1))
    const { gistId } = await createSyncGist(other)
    github.editGist(gistId, {
      'fxm-library-sync.json': JSON.stringify({ format: 'fxm-library-sync', version: 99 }),
    })
    const plan = await prepareConnect({ token: TOKEN })
    expect(plan.gist).toBeUndefined()
    expect(plan.unreadable).toMatchObject({ id: gistId, code: 'too-new' })
  })
})

describe('turning sync off', () => {
  it('forgets what this device knew of the gist, and leaves the gist alone', async () => {
    await getLibrary().like(track(1))
    await confirmConnect(await prepareConnect({ token: TOKEN }))
    expect(bases.bases.size).toBe(1)
    await disconnectSync()
    expect(useSyncStore.getState().token).toBeUndefined()
    expect(bases.bases.size).toBe(0)
    expect(github.gists.size).toBe(1)
    expect(await getLibrary().isLiked(track(1).id)).toBe(true)
  })
})
