/**
 * Live checks against api.github.com, about ten requests. They run only with `FXM_LIVE=1` and a
 * token in `FXM_GITHUB_TOKEN` (a fine-grained token with the Gists permission, preferably of a
 * test account):
 *
 * ```sh
 * FXM_LIVE=1 FXM_GITHUB_TOKEN=github_pat_… scripts/run.sh pnpm vitest run apps/web/src/features/sync/live.test.ts
 * ```
 *
 * They create one secret gist and delete it at the end, and print nothing of the token.
 */

import type { Fetch } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testRepo, track, tracks } from '../../test/library-fixtures'
import { createMemoryBaseStore } from './base-store'
import { createSyncGist, readSyncGist, type SyncDeps, syncLibrary } from './engine'
import { createGitHubClient } from './github'

/** Node's environment, read without Node's types (the web app type-checks for the browser). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const token = env?.FXM_GITHUB_TOKEN ?? ''
const live = env?.FXM_LIVE === '1' && token !== ''

describe.skipIf(!live)('GitHub gist sync, live', { timeout: 60_000 }, () => {
  it('creates a sync gist, syncs a second device, pushes a change and reads it back', async () => {
    const fetch = globalThis.fetch.bind(globalThis) as Fetch
    const github = createGitHubClient({ token, fetch })
    const { login } = await github.getUser()
    const device = (): SyncDeps => ({
      repo: testRepo(),
      github,
      bases: createMemoryBaseStore(),
      login,
      appSettings: { read: () => ({ theme: 'dark' }), apply: () => {} },
    })
    const a = device()
    const b = device()
    await a.repo.createPlaylist({ name: 'FXM live test', tracks: tracks(3) })
    const created = await createSyncGist(a)
    try {
      const read = await github.getGist(created.gistId)
      expect(read.notModified).toBe(false)
      if (!read.notModified) expect(read.gist.public).toBe(false)

      const joined = await syncLibrary(b, created.gistId)
      expect(joined?.pulled).toBeGreaterThan(0)
      const names = (await b.repo.getPlaylistList()).items.map((item) => item.name)
      expect(names).toContain('FXM live test')

      await a.repo.like(track(1))
      expect(await syncLibrary(a, created.gistId)).toMatchObject({ pushed: true })
      // Nothing changed since: GitHub answers the conditional read with 304.
      expect(await syncLibrary(a, created.gistId)).toMatchObject({ pushed: false, pulled: 0 })

      const found = await readSyncGist(github, created.gistId, login)
      expect(found.snapshot.likes.map((row) => row.trackId)).toEqual([track(1).id])
    } finally {
      await github.deleteGist(created.gistId)
    }
  })
})
