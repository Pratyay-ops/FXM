import type { NetworkCapabilities } from '@fxm/core'
import { createAndroidSpotifyLogin } from '@fxm/platform'
import {
  createFakeFxmSpotifyLogin,
  type FakeFxmSpotifyLoginOptions,
  fxmSpotifyLoginError,
} from '@fxm/platform/testing'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../app/app'
import { routes } from '../../app/routes'
import { getLibrary } from '../../db/repo'
import { INITIAL_CONNECTION, useConnection } from '../connect/connection'
import { appSources } from '../search/sources-context'
import { createSyncStore } from '../sync/sync-store'
import { createAccountChoice } from './account-store'
import { type AccountAccess, SpotifyAccountProvider } from './context'
import { type AccountRuntime, createAccountRuntime } from './runtime'
import { LOGIN_FAILED, LOGIN_UNAVAILABLE, LOGOUT_FAILED } from './spotify-account-settings'
import { fakeLocks, fakeServices } from './testing'

// Settings → Spotify account in the Android app (stage 6.5), which logs in through a window of
// its own. The web's section is in spotify-account-settings.test.tsx.

const ANDROID: NetworkCapabilities = {
  youtube: 'full',
  spotify: 'account',
  mediaBytes: true,
  fileSystem: true,
}

afterEach(() => {
  useConnection.setState(INITIAL_CONNECTION, true)
  appSources.setSpotifyEnabled(true)
})

function setup({ optedIn = false, plugin = {} as FakeFxmSpotifyLoginOptions } = {}) {
  useConnection.setState({ phase: 'ready', capabilities: ANDROID, platform: 'android' })
  const fake = fakeServices(getLibrary())
  fake.setCapabilities('account', 'android')
  const login = createFakeFxmSpotifyLogin(plugin)
  const choice = createAccountChoice()
  if (optedIn) choice.getState().setOptedIn(true)
  let runtime: AccountRuntime | undefined
  const access: AccountAccess = {
    choice,
    async load() {
      if (runtime === undefined) {
        runtime = createAccountRuntime({
          services: { ...fake.services, loginWindow: createAndroidSpotifyLogin({ plugin: login }) },
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
    // Library sync's settings of their own, so the app's sync never starts here.
    librarySync: createSyncStore({ storage: () => undefined }),
  }
  const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
  const user = userEvent.setup()
  render(
    <SpotifyAccountProvider access={access}>
      <App router={router} />
    </SpotifyAccountProvider>,
  )
  return { fake, login, choice, user }
}

async function section() {
  const heading = await screen.findByRole('heading', { name: 'Spotify account', level: 2 })
  return within(heading.closest('section') as HTMLElement)
}

describe('Settings → Spotify account in the Android app', () => {
  it('says what its own login window does before connecting, then logs in through it', async () => {
    const { login, choice, user } = setup()
    const account = await section()
    await user.click(account.getByRole('button', { name: 'Connect your account' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Connect your Spotify account?' })
    expect(dialog).toHaveTextContent(
      'Spotify’s own login page opens in a window of FXM’s, where you log in. FXM never sees your password.',
    )
    expect(dialog).toHaveTextContent('encrypted on this phone')
    expect(dialog).toHaveTextContent('The token stays in FXM’s memory and is never saved')
    expect(dialog).toHaveTextContent('Google and Facebook don’t allow signing in there')
    expect(dialog).not.toHaveTextContent('FXM Connect')
    expect(dialog).toHaveTextContent('Spotify’s User Guidelines forbid accessing Spotify')
    // Settings only asked whether a login is kept: nothing opened, nothing was sent.
    expect(login.calls).toEqual(['status'])

    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))
    expect(await account.findByText(/^Connected as/)).toHaveTextContent(
      'Connected as Fixture User.',
    )
    expect(choice.getState().optedIn).toBe(true)
    expect(login.calls).toContain('login')
    expect(await account.findByText(/^Last synced just now/)).toBeVisible()
  })

  it('offers its login window, not the browser’s, while no login is kept', async () => {
    let answer = false
    const { login, user } = setup({ optedIn: true, plugin: { window: () => answer } })
    const account = await section()
    const text = await account.findByText(/^You’re not logged in to Spotify in FXM/)
    expect(text).toHaveTextContent('FXM never sees your password')
    expect(text).toHaveTextContent('Google and Facebook don’t allow signing in there')
    expect(account.queryByRole('link', { name: /open\.spotify\.com/ })).toBeNull()
    expect(account.queryByRole('button', { name: 'Try again' })).toBeNull()

    // Closed without logging in: still logged out, and the window is offered again.
    await user.click(account.getByRole('button', { name: 'Log in to Spotify' }))
    expect(await account.findByRole('button', { name: 'Log in to Spotify' })).toBeVisible()
    answer = true
    await user.click(account.getByRole('button', { name: 'Log in to Spotify' }))
    expect(await account.findByText(/^Connected as/)).toBeVisible()
    expect(login.calls.filter((call) => call === 'login')).toHaveLength(2)
  })

  it('says when the window could not open or keep the login', async () => {
    const { user } = setup({
      optedIn: true,
      plugin: {
        window: () => {
          throw fxmSpotifyLoginError('STORAGE')
        },
      },
    })
    const account = await section()
    await user.click(await account.findByRole('button', { name: 'Log in to Spotify' }))
    expect(await account.findByText(LOGIN_FAILED)).toBeVisible()
  })

  it('says when the window can’t open on this phone after all', async () => {
    const { login, user } = setup({ optedIn: true })
    const account = await section()
    const button = await account.findByRole('button', { name: 'Log in to Spotify' })
    // The WebView changed since the check (an update rolled back): the window doesn't open.
    login.available = false
    await user.click(button)
    expect(await account.findByText(LOGIN_UNAVAILABLE)).toBeVisible()
    expect(
      account.getByText(/^This phone’s WebView can’t keep FXM’s Spotify login apart/),
    ).toBeVisible()
  })

  it('explains a WebView without profiles, and tries again', async () => {
    const { user } = setup({ optedIn: true, plugin: { available: false } })
    const account = await section()
    expect(
      await account.findByText(/^This phone’s WebView can’t keep FXM’s Spotify login apart/),
    ).toHaveTextContent('Update Android System WebView from the Play Store')
    expect(account.queryByRole('button', { name: 'Log in to Spotify' })).toBeNull()
    await user.click(account.getByRole('button', { name: 'Try again' }))
    expect(await account.findByText(/^This phone’s WebView/)).toBeVisible()
  })

  it('logs out of Spotify on this phone when disconnecting', async () => {
    const { login, choice, user } = setup({ optedIn: true, plugin: { loggedIn: true } })
    const account = await section()
    await account.findByText(/^Last synced/)
    await user.click(account.getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Disconnect your Spotify account?',
    })
    expect(dialog).toHaveTextContent('FXM also logs out of Spotify on this phone')
    expect(dialog).not.toHaveTextContent('FXM Connect')
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    expect(
      await account.findByText(
        'Disconnected and logged out of Spotify on this phone. Your library keeps what FXM synced.',
      ),
    ).toBeVisible()
    expect(choice.getState().optedIn).toBe(false)
    expect(login.loggedIn).toBe(false)
    expect(login.calls).toContain('logout')
  })

  it('says when Disconnect couldn’t delete the login, and logs out of it later', async () => {
    let failing = true
    const { login, choice, user } = setup({
      optedIn: true,
      plugin: {
        loggedIn: true,
        logout: () => {
          if (failing) throw fxmSpotifyLoginError('STORAGE')
        },
      },
    })
    const account = await section()
    await account.findByText(/^Last synced/)
    await user.click(account.getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Disconnect your Spotify account?',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    expect(
      await account.findByText(
        'Disconnected, but FXM couldn’t delete its Spotify login on this phone. Your library keeps what FXM synced. Select Log out of Spotify to try again.',
      ),
    ).toBeVisible()
    expect(choice.getState().optedIn).toBe(false)
    expect(login.loggedIn).toBe(true)
    expect(account.getByText('FXM still keeps a Spotify login on this phone.')).toBeVisible()

    await user.click(account.getByRole('button', { name: 'Log out of Spotify' }))
    expect(await account.findByText(LOGOUT_FAILED)).toBeVisible()
    failing = false
    await user.click(account.getByRole('button', { name: 'Log out of Spotify' }))
    expect(await account.findByText('Logged out of Spotify on this phone.')).toBeVisible()
    expect(login.loggedIn).toBe(false)
    expect(account.queryByRole('button', { name: 'Log out of Spotify' })).toBeNull()
    expect(account.queryByText('FXM still keeps a Spotify login on this phone.')).toBeNull()
  })

  it('offers to log out of a login kept while the account is off', async () => {
    const { login, user } = setup({ plugin: { loggedIn: true } })
    const account = await section()
    expect(await account.findByText('FXM still keeps a Spotify login on this phone.')).toBeVisible()
    expect(account.getByRole('button', { name: 'Connect your account' })).toBeVisible()
    await user.click(account.getByRole('button', { name: 'Log out of Spotify' }))
    expect(await account.findByText('Logged out of Spotify on this phone.')).toBeVisible()
    expect(login.loggedIn).toBe(false)
    expect(login.calls).toEqual(['status', 'logout'])
  })
})
