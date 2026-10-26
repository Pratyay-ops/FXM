import { FxmError, type ProviderContext } from '@fxm/core'
import { ConnectBridgeError } from '@fxm/platform'
import { SpotifyError } from '@fxm/sources/spotify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testRepo } from '../../test/library-fixtures'
import { createAccountChoice } from './account-store'
import { HOME_FRESH_MS } from './home'
import { HOME_KEY, LIKED_NAME, playlistCopyId } from './ids'
import {
  type AccountRuntime,
  createAccountRuntime,
  failureOfError,
  phaseOfError,
  SYNC_EVERY_MS,
  SYNC_LOCK,
} from './runtime'
import { readState } from './state'
import { fakeLocks, fakeServices, nativeId, spotifyTrack } from './testing'

type Repo = ReturnType<typeof testRepo>

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function setup(options: { optedIn?: boolean; now?: () => number } = {}) {
  const repo = testRepo()
  const fake = fakeServices(repo)
  const choice = createAccountChoice({ storage: () => undefined })
  if (options.optedIn) choice.getState().setOptedIn(true)
  const locks = fakeLocks()
  const ticks: (() => void)[] = []
  const runtime = createAccountRuntime({
    services: fake.services,
    choice,
    locks,
    pace: async () => {},
    every: (check) => {
      ticks.push(check)
      return () => {}
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { repo, fake, choice, locks, runtime, ticks }
}

function start(runtime: AccountRuntime) {
  stops.push(runtime.start())
}

/** Waits until the runtime settles: no check or sync left in flight. */
async function settled(runtime: AccountRuntime) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await runtime.whenIdle()
}

async function playlistNames(repo: Repo) {
  return (await repo.getPlaylistList()).items.map((item) => item.name)
}

const homeCtx: ProviderContext = {
  fetch: () => Promise.reject(new Error('Home never fetches here')),
  platform: 'web',
  capabilities: { youtube: 'full', spotify: 'account', mediaBytes: true, fileSystem: false },
  mode: 'music',
}

describe('before the user connects', () => {
  it('does nothing and asks nothing', async () => {
    const { fake, runtime, ticks } = setup()
    start(runtime)
    for (const tick of ticks) tick()
    await settled(runtime)
    expect(runtime.store.getState()).toMatchObject({ phase: 'off', syncing: false })
    expect(fake.account.calls).toEqual([])
    expect(fake.switches).toEqual([])
    expect(await runtime.forHome.status(homeCtx)).toEqual({ connected: false })
    expect(await runtime.forHome.sections(homeCtx)).toEqual([])
    expect(fake.account.calls).toEqual([])
  })
})

describe('connect', () => {
  it('turns the account on, checks the login and runs the first sync', async () => {
    const { repo, fake, choice, runtime } = setup()
    start(runtime)
    await runtime.connect()
    await settled(runtime)
    expect(choice.getState().optedIn).toBe(true)
    expect(fake.switches).toEqual(['connect'])
    expect(runtime.store.getState()).toMatchObject({
      phase: 'connected',
      displayName: 'Fixture User',
      syncing: false,
    })
    expect(await playlistNames(repo)).toEqual([
      'Liked songs',
      'Downloads',
      LIKED_NAME,
      'Road trip',
      'Quiet',
    ])
    expect(fake.account.calls[0]).toBe('status')
  })

  it("waits for FXM Connect's Spotify login, and syncs once it is turned on", async () => {
    const { repo, fake, runtime } = setup()
    fake.setCapabilities('anonymous')
    start(runtime)
    await runtime.connect()
    expect(runtime.store.getState().phase).toBe('needs-login')
    expect(fake.account.calls).toEqual([])
    // The user turns on "Use my Spotify login from this browser": FXM Connect announces it.
    fake.setCapabilities('account')
    await vi.waitFor(async () => expect(await playlistNames(repo)).toContain('Road trip'))
    await settled(runtime)
    expect(runtime.store.getState().phase).toBe('connected')
  })

  it('says when the browser has no Spotify login, and tries again when asked', async () => {
    const { repo, fake, runtime } = setup()
    fake.loggedIn = false
    start(runtime)
    await runtime.connect()
    expect(runtime.store.getState().phase).toBe('logged-out')
    expect(await playlistNames(repo)).not.toContain('Road trip')
    fake.loggedIn = true
    await runtime.recheck()
    await settled(runtime)
    expect(runtime.store.getState().phase).toBe('connected')
    expect(await playlistNames(repo)).toContain('Road trip')
    expect(fake.switches).toEqual(['connect', 'connect'])
    // Try again detects FXM Connect again first: its options may have just changed.
    expect(fake.refreshes).toEqual(['refresh'])
  })

  it('says when the check itself failed, and checks again on Try again', async () => {
    const { fake, runtime } = setup()
    start(runtime)
    fake.loggedIn = new SpotifyError('network', 'FXM Connect did not answer in time')
    await runtime.connect()
    expect(runtime.store.getState()).toMatchObject({
      phase: 'unverified',
      failure: { kind: 'network' },
    })
    fake.loggedIn = true
    await runtime.recheck()
    await settled(runtime)
    expect(runtime.store.getState().phase).toBe('connected')
    expect(runtime.store.getState().failure).toBeUndefined()
  })

  it("drops a failed check's reason once a check gets any answer", async () => {
    const { fake, runtime } = setup()
    start(runtime)
    fake.loggedIn = new SpotifyError('network', 'FXM Connect did not answer in time')
    await runtime.connect()
    expect(runtime.store.getState().failure).toEqual({ kind: 'network' })
    // Meanwhile the user turned FXM Connect's Spotify login off: Settings says only that.
    fake.setCapabilities('anonymous')
    await runtime.recheck()
    expect(runtime.store.getState().phase).toBe('needs-login')
    expect(runtime.store.getState().failure).toBeUndefined()
    // And a check that finds no login drops it too.
    fake.loggedIn = new SpotifyError('network', 'again')
    fake.setCapabilities('account')
    await runtime.recheck()
    expect(runtime.store.getState().phase).toBe('unverified')
    fake.loggedIn = false
    await runtime.recheck()
    expect(runtime.store.getState()).toMatchObject({ phase: 'logged-out' })
    expect(runtime.store.getState().failure).toBeUndefined()
  })

  it("tells FXM Connect's refusals apart", async () => {
    const { fake, runtime } = setup()
    start(runtime)
    fake.loggedIn = new SpotifyError('login-required', 'refused', {
      cause: new ConnectBridgeError('private-tab'),
    })
    await runtime.connect()
    expect(runtime.store.getState().phase).toBe('private')
    fake.loggedIn = new SpotifyError('login-required', 'refused', {
      cause: new ConnectBridgeError('login-disabled'),
    })
    await runtime.recheck()
    expect(runtime.store.getState().phase).toBe('needs-login')
  })

  it('says when Spotify is off or out of reach, and when the app has no login yet', async () => {
    const { fake, runtime } = setup()
    start(runtime)
    fake.setEnabled(false)
    await runtime.connect()
    expect(runtime.store.getState().phase).toBe('unreachable')
    fake.setCapabilities('unreachable')
    fake.setEnabled(true)
    await runtime.recheck()
    expect(runtime.store.getState().phase).toBe('unreachable')
    fake.setCapabilities('anonymous', 'desktop')
    await runtime.recheck()
    expect(runtime.store.getState().phase).toBe('unsupported')
    expect(fake.account.calls).toEqual([])
  })
})

describe('when it syncs', () => {
  it('syncs when the app opens and the last sync is old, and not again while it is fresh', async () => {
    let now = Date.UTC(2026, 9, 26, 12)
    const { fake, runtime, ticks } = setup({ optedIn: true, now: () => now })
    start(runtime)
    await vi.waitFor(() => expect(fake.account.calls).toContain('home'))
    await settled(runtime)
    fake.account.calls.length = 0
    now += SYNC_EVERY_MS - 1
    for (const tick of ticks) tick()
    await settled(runtime)
    expect(fake.account.calls).toEqual([])
    now += 1
    for (const tick of ticks) tick()
    await vi.waitFor(() => expect(fake.account.calls).toContain('home'))
    await settled(runtime)
    expect(fake.switches).toEqual(['connect'])
  })

  it('leaves the sync to the tab that holds the lock', async () => {
    const { repo, locks, runtime } = setup({ optedIn: true })
    locks.held.add(SYNC_LOCK)
    await runtime.syncNow()
    expect(runtime.store.getState().syncingElsewhere).toBe(true)
    expect(await playlistNames(repo)).not.toContain('Road trip')
    locks.held.delete(SYNC_LOCK)
    await runtime.syncNow()
    expect(runtime.store.getState().syncingElsewhere).toBe(false)
    expect(await playlistNames(repo)).toContain('Road trip')
  })

  it('reports a failed sync until the next one, and a login that ended', async () => {
    const { fake, runtime } = setup({ optedIn: true })
    start(runtime)
    await settled(runtime)
    expect(runtime.store.getState().phase).toBe('connected')
    fake.account.failures.set('liked', new FxmError('Network', 'offline'))
    await runtime.syncNow()
    expect(runtime.store.getState()).toMatchObject({
      phase: 'connected',
      failure: { kind: 'network' },
    })
    fake.account.failures.set('liked', new SpotifyError('login-required', 'logged out'))
    await runtime.syncNow()
    expect(runtime.store.getState().phase).toBe('logged-out')
    fake.account.failures.clear()
    await runtime.recheck()
    await settled(runtime)
    await runtime.syncNow()
    expect(runtime.store.getState()).toMatchObject({ phase: 'connected', syncing: false })
    expect(runtime.store.getState().failure).toBeUndefined()
    expect(runtime.store.getState().progress).toBeUndefined()
  })
})

describe('disconnect', () => {
  it('forgets the token and what it followed at once, and keeps the copies', async () => {
    const { repo, fake, choice, runtime } = setup()
    start(runtime)
    await runtime.connect()
    await settled(runtime)
    expect(await runtime.disconnect()).toEqual({ removed: 0, kept: 3 })
    expect(choice.getState().optedIn).toBe(false)
    expect(fake.switches).toEqual(['connect', 'disconnect'])
    expect(runtime.store.getState().phase).toBe('off')
    expect((await readState(repo)).meta).toBeUndefined()
    expect(await repo.getSetting(HOME_KEY)).toBeUndefined()
    expect(await playlistNames(repo)).toContain('Road trip')
    expect(await runtime.forHome.status(homeCtx)).toEqual({ connected: false })
  })

  it('removes the untouched copies when asked', async () => {
    const { repo, runtime } = setup()
    start(runtime)
    await runtime.connect()
    await settled(runtime)
    await repo.addTracks(playlistCopyId(nativeId('p', 2)), [spotifyTrack(99)])
    expect(await runtime.disconnect({ removeCopies: true })).toEqual({ removed: 2, kept: 1 })
    expect(await playlistNames(repo)).toEqual(['Liked songs', 'Downloads', 'Quiet'])
  })

  it('stops a running sync', async () => {
    const { repo, fake, runtime } = setup({ optedIn: true })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = createAccountRuntime({
      services: fake.services,
      choice: createAccountChoice({ storage: () => undefined }),
      pace: async (signal) => {
        await gate
        signal?.throwIfAborted()
      },
      locks: fakeLocks(),
      every: () => () => {},
    })
    await slow.connect()
    // The first sync, started by Connect, waits at its first pause.
    const syncing = slow.syncNow()
    await vi.waitFor(() => expect(slow.store.getState().syncing).toBe(true))
    const disconnecting = slow.disconnect()
    release()
    await syncing
    await disconnecting
    expect(slow.store.getState()).toMatchObject({ phase: 'off', syncing: false })
    expect(runtime).toBeDefined()
    expect((await readState(repo)).lists.size).toBe(0)
  })

  it('follows a Disconnect in another tab', async () => {
    const { fake, choice, runtime } = setup({ optedIn: true })
    start(runtime)
    await settled(runtime)
    // Another tab's Disconnect reaches this one through the stored choice.
    choice.setState({ optedIn: false })
    expect(fake.switches).toEqual(['connect', 'disconnect'])
    expect(runtime.store.getState().phase).toBe('off')
    choice.setState({ optedIn: true })
    expect(fake.switches).toEqual(['connect', 'disconnect', 'connect'])
    await settled(runtime)
    expect(runtime.store.getState().phase).toBe('connected')
  })
})

describe("Home's view", () => {
  it("serves the synced home while it is fresh, then Spotify's, then the kept one", async () => {
    let now = Date.UTC(2026, 9, 26, 12)
    const { repo, fake, runtime } = setup({ now: () => now })
    start(runtime)
    await runtime.connect()
    await settled(runtime)
    fake.account.calls.length = 0
    const titles = async () => (await runtime.forHome.sections(homeCtx)).map((shelf) => shelf.title)
    expect(await titles()).toEqual(['Made for Fixture User'])
    expect(fake.account.calls).toEqual([])
    // Stale: Spotify's home is read again, and kept.
    now += HOME_FRESH_MS
    fake.account.data.home = [
      {
        id: 'spotify:section:new',
        title: 'Jump back in',
        items: [{ type: 'track', track: spotifyTrack(5) }],
      },
    ]
    expect(await titles()).toEqual(['Jump back in'])
    expect(fake.account.calls).toEqual(['home', 'profile'])
    expect(await repo.getSetting(HOME_KEY)).toMatchObject({ at: now })
    // Spotify fails: the kept home, for up to a week.
    now += HOME_FRESH_MS
    fake.account.failures.set('home', new FxmError('Network', 'offline'))
    expect(await titles()).toEqual(['Jump back in'])
    now += 8 * 24 * 60 * 60_000
    expect(await titles()).toEqual([])
  })

  it("doesn't keep the home of another login", async () => {
    const { repo, fake, runtime } = setup({ now: () => Date.UTC(2026, 9, 26, 12) })
    start(runtime)
    await runtime.connect()
    await settled(runtime)
    await repo.putSettings({ [HOME_KEY]: undefined })
    fake.account.data.username = 'someone-else'
    fake.account.data.home = []
    expect(await runtime.forHome.sections(homeCtx)).toEqual([])
    expect(await repo.getSetting(HOME_KEY)).toBeUndefined()
  })

  it('says whether the account is connected', async () => {
    const { fake, runtime } = setup({ optedIn: true })
    expect(await runtime.forHome.status(homeCtx)).toEqual({
      connected: true,
      displayName: 'Fixture User',
    })
    fake.loggedIn = false
    expect(await runtime.forHome.status(homeCtx)).toEqual({ connected: false })
  })
})

describe('errors', () => {
  it('map to where the account stands, or why a sync failed', () => {
    expect(phaseOfError(new SpotifyError('login-required', 'x'))).toBe('logged-out')
    expect(phaseOfError(new SpotifyError('account-unsupported', 'x'))).toBe('needs-login')
    expect(phaseOfError(new SpotifyError('disabled', 'x'))).toBe('unreachable')
    expect(phaseOfError(new FxmError('Network', 'x'))).toBeUndefined()
    const now = 1000
    expect(failureOfError(new SpotifyError('paused', 'x', { retryAfterMs: 500 }), now)).toEqual({
      kind: 'rate-limited',
      retryAt: 1500,
    })
    expect(failureOfError(new SpotifyError('operation-broken', 'x'), now)).toEqual({
      kind: 'changed',
    })
    expect(failureOfError(new SpotifyError('secret-rejected', 'x'), now)).toEqual({
      kind: 'secret',
    })
    expect(failureOfError(new SpotifyError('network', 'x'), now)).toEqual({ kind: 'network' })
    expect(failureOfError(new Error('x'), now)).toEqual({ kind: 'other' })
  })
})
