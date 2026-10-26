import { FxmError, type NetworkCapabilities } from '@fxm/core'
import { SpotifyError } from '@fxm/sources/spotify'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../app/app'
import { routes } from '../../app/routes'
import { getLibrary } from '../../db/repo'
import { INITIAL_CONNECTION, useConnection } from '../connect/connection'
import { appSources } from '../search/sources-context'
import { createAccountChoice, SPOTIFY_ACCOUNT_STORAGE_KEY } from './account-store'
import { type AccountAccess, SpotifyAccountProvider } from './context'
import { LIKED_NAME } from './ids'
import { type AccountRuntime, createAccountRuntime } from './runtime'
import { failureText, progressText, syncedText, whenText } from './spotify-account-settings'
import { type FakeServices, fakeLocks, fakeServices } from './testing'

const FULL: NetworkCapabilities = {
  youtube: 'full',
  spotify: 'account',
  mediaBytes: true,
  fileSystem: false,
}

afterEach(() => {
  useConnection.setState(INITIAL_CONNECTION, true)
  appSources.setSpotifyEnabled(true)
})

/** The tier the page sees, as FXM Connect's detection would set it. */
function tier(capabilities: NetworkCapabilities, platform: 'web' | 'desktop' = 'web') {
  useConnection.setState({ phase: 'ready', capabilities, platform })
}

function setup({ optedIn = false } = {}) {
  const fake: FakeServices = fakeServices(getLibrary())
  const choice = createAccountChoice()
  if (optedIn) choice.getState().setOptedIn(true)
  let runtime: AccountRuntime | undefined
  const access: AccountAccess = {
    choice,
    async load() {
      if (runtime === undefined) {
        runtime = createAccountRuntime({
          services: fake.services,
          choice,
          locks: fakeLocks(),
          pace: async () => {},
          every: () => () => {},
        })
        runtime.start()
      }
      return runtime
    },
    current: () => runtime,
    library: getLibrary,
  }
  const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
  const user = userEvent.setup()
  render(
    <SpotifyAccountProvider access={access}>
      <App router={router} />
    </SpotifyAccountProvider>,
  )
  return { fake, choice, user, router, runtime: () => runtime }
}

async function section() {
  const heading = await screen.findByRole('heading', { name: 'Spotify account', level: 2 })
  return within(heading.closest('section') as HTMLElement)
}

describe('Settings → Spotify account', () => {
  it('connects only after the notice, then syncs and says what it synced', async () => {
    tier(FULL)
    const { fake, choice, user, runtime } = setup()
    const account = await section()
    expect(account.getByText(/^Off\. Connect your Spotify account/)).toBeInTheDocument()

    // The notice first; Cancel changes nothing.
    await user.click(account.getByRole('button', { name: 'Connect your account' }))
    let dialog = await screen.findByRole('alertdialog', { name: 'Connect your Spotify account?' })
    expect(dialog).toHaveTextContent(
      'Spotify’s User Guidelines forbid accessing Spotify by automated means, and Spotify may suspend or terminate an account that breaks them.',
    )
    expect(dialog).toHaveTextContent('No case is known of an account suspended')
    expect(dialog).toHaveTextContent('never changes anything in your Spotify account')
    expect(dialog).toHaveTextContent('The token stays in FXM’s memory and is never saved')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(choice.getState().optedIn).toBe(false)
    expect(fake.account.calls).toEqual([])
    expect(runtime()).toBeUndefined()

    await user.click(account.getByRole('button', { name: 'Connect your account' }))
    dialog = await screen.findByRole('alertdialog', { name: 'Connect your Spotify account?' })
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))
    expect(choice.getState().optedIn).toBe(true)
    expect(await account.findByText(/^Connected as/)).toHaveTextContent(
      'Connected as Fixture User.',
    )
    expect(
      await account.findByText(`Last synced just now: ${LIKED_NAME} (3 songs) and 2 playlists.`),
    ).toBeInTheDocument()
    expect(account.getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
    expect(account.getByRole('link', { name: 'Open your playlists' })).toHaveAttribute(
      'href',
      '/library?tab=playlists',
    )
    // Only the choice is stored: no token, nothing about the account.
    expect(JSON.parse(localStorage.getItem(SPOTIFY_ACCOUNT_STORAGE_KEY) ?? '{}')).toEqual({
      state: { optedIn: true },
      version: 1,
    })
  })

  it('points to FXM Connect where Spotify is out of reach, and offers nothing to connect', async () => {
    tier({ youtube: 'simple', spotify: 'unreachable', mediaBytes: false, fileSystem: false })
    setup()
    const account = await section()
    expect(account.getByRole('link', { name: 'Get FXM Connect' })).toHaveAttribute(
      'href',
      '/connect',
    )
    expect(account.queryByRole('button', { name: 'Connect your account' })).toBeNull()
  })

  it('asks to switch Spotify on first', async () => {
    tier(FULL)
    appSources.setSpotifyEnabled(false)
    setup()
    const account = await section()
    expect(account.getByText('Switch Spotify on, above, to connect your account.')).toBeVisible()
    expect(account.queryByRole('button', { name: 'Connect your account' })).toBeNull()
  })

  it("says the desktop app's login comes later", async () => {
    tier({ ...FULL, spotify: 'anonymous' }, 'desktop')
    setup()
    const account = await section()
    expect(account.getByText(/^The desktop app gets its own Spotify login later/)).toBeVisible()
  })

  it("guides through FXM Connect's login switch, then syncs", async () => {
    tier({ ...FULL, spotify: 'anonymous' })
    const { fake, user } = setup({ optedIn: true })
    fake.setCapabilities('anonymous')
    const account = await section()
    expect(
      await account.findByText(/turn on “Use my Spotify login from this browser”/),
    ).toBeVisible()
    fake.setCapabilities('account')
    tier(FULL)
    await user.click(account.getByRole('button', { name: 'Try again' }))
    expect(await account.findByText(/^Connected as/)).toHaveTextContent(
      'Connected as Fixture User.',
    )
  })

  it('explains a missing login, cookies included, and tries again', async () => {
    tier(FULL)
    const { fake, user } = setup({ optedIn: true })
    fake.loggedIn = false
    const account = await section()
    const text = await account.findByText(/^FXM Connect got no Spotify login from this browser/)
    expect(text).toHaveTextContent('third-party cookies')
    expect(account.getByRole('link', { name: /open\.spotify\.com/ })).toHaveAttribute(
      'href',
      'https://open.spotify.com/',
    )
    fake.loggedIn = true
    await user.click(account.getByRole('button', { name: 'Try again' }))
    expect(await account.findByText(/^Connected as/)).toHaveTextContent(
      'Connected as Fixture User.',
    )
  })

  it('says why a sync failed, until the status says what to do instead', async () => {
    tier(FULL)
    const { fake, user } = setup({ optedIn: true })
    const account = await section()
    await account.findByText(/^Last synced/)
    fake.account.failures.set('liked', new FxmError('Network', 'offline'))
    await user.click(account.getByRole('button', { name: 'Sync now' }))
    expect(
      await account.findByText(
        "FXM couldn't reach Spotify. Check your connection, then select Sync now.",
      ),
    ).toBeVisible()
    // The next sync finds the login gone: only that, and its way out, stay on screen.
    fake.account.failures.set('liked', new SpotifyError('login-required', 'logged out'))
    await user.click(account.getByRole('button', { name: 'Sync now' }))
    expect(
      await account.findByText(/^FXM Connect got no Spotify login from this browser/),
    ).toBeVisible()
    expect(account.queryByText(/couldn't reach Spotify/)).toBeNull()
    expect(account.queryByRole('button', { name: 'Sync now' })).toBeNull()
    expect(account.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  it('says when the login check itself failed, and points to Try again', async () => {
    tier(FULL)
    const { fake, user } = setup({ optedIn: true })
    fake.loggedIn = new SpotifyError('network', 'FXM Connect did not answer in time')
    const account = await section()
    expect(
      await account.findByText('FXM couldn’t check your Spotify login just now.'),
    ).toBeVisible()
    expect(
      account.getByText(
        "FXM couldn't reach Spotify. Check your connection, then select Try again.",
      ),
    ).toBeVisible()
    expect(account.queryByRole('button', { name: 'Sync now' })).toBeNull()
    fake.loggedIn = true
    await user.click(account.getByRole('button', { name: 'Try again' }))
    expect(await account.findByText(/^Connected as/)).toHaveTextContent(
      'Connected as Fixture User.',
    )
    expect(account.queryByText(/couldn't reach Spotify/)).toBeNull()
  })

  it('disconnects, keeping the copies unless asked, and forgets what it followed', async () => {
    tier(FULL)
    const { fake, choice, user } = setup({ optedIn: true })
    const account = await section()
    await account.findByText(/^Last synced/)
    await user.click(account.getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Disconnect your Spotify account?',
    })
    expect(dialog).toHaveTextContent('Your library keeps the 3 playlists it synced')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'Also remove the synced playlists you haven’t changed',
      }),
    )
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    expect(await account.findByText('Disconnected. FXM removed 3 synced playlists.')).toBeVisible()
    expect(choice.getState().optedIn).toBe(false)
    expect(fake.switches.at(-1)).toBe('disconnect')
    expect(account.getByRole('button', { name: 'Connect your account' })).toBeVisible()
    const names = (await getLibrary().getPlaylistList()).items.map((item) => item.name)
    expect(names).toEqual(['Liked songs', 'Downloads'])
  })
})

describe('words', () => {
  it('say when, how far and what went wrong', () => {
    const now = Date.UTC(2026, 9, 26, 12)
    expect(whenText(now - 20_000, now)).toBe('just now')
    expect(whenText(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(whenText(now - 60 * 60_000, now)).toBe('1 hour ago')
    expect(whenText(now - 3 * 24 * 60 * 60_000, now)).toMatch(/^at \d\d:\d\d on 23 Oct$/)
    expect(progressText({ step: 'playlists', done: 2, total: 12 })).toBe(
      'Syncing your playlists: 3 of 12…',
    )
    expect(progressText({ step: 'liked' })).toBe('Syncing your liked songs…')
    expect(failureText({ kind: 'changed' }, 'Sync now')).toMatch(/An update of FXM will fix it/)
    // Each names the button that is on screen.
    expect(failureText({ kind: 'network' }, 'Sync now')).toMatch(/then select Sync now\.$/)
    expect(failureText({ kind: 'network' }, 'Try again')).toMatch(/then select Try again\.$/)
    expect(failureText({ kind: 'other' }, 'Sync now')).toBe('The sync failed. Try again later.')
    expect(failureText({ kind: 'other' }, 'Try again')).toBeUndefined()
  })

  it('say what the last sync left, and what follows', () => {
    const now = Date.UTC(2026, 9, 26, 12)
    const last = {
      at: now,
      likedCopy: true,
      likedCount: 1234,
      playlistCount: 90,
      created: 0,
      updated: 0,
      added: 0,
      removed: 0,
      dismissed: 0,
      departed: 0,
      skipped: 0,
      pending: 0,
      home: true,
      complete: true,
    }
    const meta = { account: 'abcdefghijklmnopqrstuv', lastSyncAt: now }
    expect(syncedText({ ...meta, last }, now)).toBe(
      `Last synced just now: ${LIKED_NAME} (1,234 songs) and 90 playlists.`,
    )
    expect(syncedText({ ...meta, last: { ...last, pending: 410, complete: false } }, now)).toBe(
      `Last synced just now: ${LIKED_NAME} (1,234 songs) and 90 playlists. 410 playlists wait for the next sync. Some of it was too large to copy, or could not be read.`,
    )
    expect(
      syncedText(
        { ...meta, last: { ...last, likedCopy: false, playlistCount: 0, pending: 1 } },
        now,
      ),
    ).toBe('Last synced just now: nothing to copy. 1 playlist waits for the next sync.')
    expect(syncedText({ account: meta.account }, now)).toBeUndefined()
  })
})
