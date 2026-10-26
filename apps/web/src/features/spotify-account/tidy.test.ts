import type { ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testRepo } from '../../test/library-fixtures'
import { createAccountChoice, SPOTIFY_ACCOUNT_STORAGE_KEY } from './account-store'
import { SYNC_LOCK } from './locks'
import { runSpotifySync } from './sync'
import { fakeAccount, fakeLocks } from './testing'
import { tidyAfterDisconnect } from './tidy'

const ctx: ProviderContext = {
  fetch: () => Promise.reject(new Error('The tidy-up never fetches')),
  platform: 'web',
  capabilities: { youtube: 'full', spotify: 'account', mediaBytes: true, fileSystem: false },
  mode: 'music',
}

/** A library a sync left its state in. */
async function synced() {
  const repo = testRepo()
  await runSpotifySync(fakeAccount().spotify, repo, { context: () => ctx })
  return repo
}

async function names(repo: ReturnType<typeof testRepo>) {
  return (await repo.getPlaylistList()).items.map((item) => item.name)
}

describe('tidyAfterDisconnect', () => {
  it("forgets the sync's state and home while the account isn't connected, never the copies", async () => {
    const repo = await synced()
    const choice = createAccountChoice({ storage: () => undefined })
    const locks = fakeLocks()
    expect(await tidyAfterDisconnect({ library: repo, choice, locks })).toBe(true)
    expect(await repo.getSettings('spotify-account.')).toEqual(new Map())
    expect(await names(repo)).toContain('Road trip')
    // Nothing left: nothing to do.
    expect(await tidyAfterDisconnect({ library: repo, choice, locks })).toBe(false)
  })

  it('leaves it while the account is connected, or while a tab syncs', async () => {
    const repo = await synced()
    const choice = createAccountChoice({ storage: () => undefined })
    choice.getState().setOptedIn(true)
    expect(await tidyAfterDisconnect({ library: repo, choice })).toBe(false)
    choice.getState().setOptedIn(false)
    const locks = fakeLocks()
    locks.held.add(SYNC_LOCK)
    expect(await tidyAfterDisconnect({ library: repo, choice, locks })).toBe(false)
    expect((await repo.getSettings('spotify-account.')).size).toBeGreaterThan(0)
  })

  it('reads the choice again first: another tab may have connected the account', async () => {
    const repo = await synced()
    const choice = createAccountChoice({ storage: () => localStorage })
    expect(choice.getState().optedIn).toBe(false)
    // Another tab connects; this one hasn't heard yet.
    localStorage.setItem(
      SPOTIFY_ACCOUNT_STORAGE_KEY,
      JSON.stringify({ state: { optedIn: true }, version: 1 }),
    )
    expect(await tidyAfterDisconnect({ library: repo, choice })).toBe(false)
    expect((await repo.getSettings('spotify-account.')).size).toBeGreaterThan(0)
  })
})
