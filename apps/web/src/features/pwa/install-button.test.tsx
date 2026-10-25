import { act, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { INSTALL_SNOOZE_MS, STANDALONE_QUERY } from './install'
import { INSTALL_HELP } from './install-setting'
import {
  type InstallChoice,
  type InstallPromptEvent,
  PWA_STORAGE_KEY,
  usePwaStore,
} from './pwa-store'

/** The browser offers to install FXM (Chromium's deferred `beforeinstallprompt`). */
function browserOffersInstall(outcome: InstallChoice['outcome'] = 'accepted') {
  const prompt = vi.fn(async () => {})
  const event = Object.assign(new Event('beforeinstallprompt'), {
    prompt,
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  }) as InstallPromptEvent
  act(() => usePwaStore.setState({ installPrompt: event }))
  return prompt
}

/** Makes `matchMedia` report an installed app window. */
function runAsInstalledApp() {
  const matchMedia = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const list = matchMedia(query)
    // `matches` is a getter on the prototype: shadow it on this list.
    if (query === STANDALONE_QUERY) Object.defineProperty(list, 'matches', { value: true })
    return list
  })
}

/** The Android and desktop builds load the app from their package, with base '/'. */
function nativeAppBuild() {
  vi.stubEnv('BASE_URL', '/')
}

const banner = () => within(screen.getByRole('banner'))
const topBarButton = () => banner().queryByRole('button', { name: 'Install app' })
const card = () => screen.queryByRole('region', { name: 'Install FXM' })

describe('install button (top bar, from 768px)', () => {
  it("is not there while the browser doesn't offer to install FXM", async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(topBarButton()).not.toBeInTheDocument()
  })

  it("opens the browser's install dialog, keeping focus in the top bar", async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    const prompt = browserOffersInstall()

    await user.click(topBarButton() as HTMLElement)

    expect(prompt).toHaveBeenCalledOnce()
    // The offer is used up: the browser makes a new one if the user said no.
    expect(topBarButton()).not.toBeInTheDocument()
    expect(banner().getByRole('link', { name: 'Settings' })).toHaveFocus()
  })

  it('stays away in the installed app', async () => {
    runAsInstalledApp()
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    browserOffersInstall()
    expect(topBarButton()).not.toBeInTheDocument()
  })

  it('keeps quiet for a month after the user said no', async () => {
    const { user } = renderApp('/settings')
    await screen.findByRole('heading', { level: 1, name: 'Settings' })
    browserOffersInstall('dismissed')
    await user.click(topBarButton() as HTMLElement)
    await vi.waitFor(() => expect(usePwaStore.getState().installSnoozedUntil).toBeGreaterThan(0))

    // Chromium offers again on a later visit.
    browserOffersInstall()

    expect(topBarButton()).not.toBeInTheDocument()
    // Settings still offers it.
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument()
  })

  it('is not in the Android and desktop apps', async () => {
    nativeAppBuild()
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    browserOffersInstall()
    expect(topBarButton()).not.toBeInTheDocument()
    expect(card()).not.toBeInTheDocument()
  })
})

describe('install card (Home, on phones)', () => {
  it('offers to install FXM on the Home page only', async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(card()).not.toBeInTheDocument()

    browserOffersInstall()
    expect(card()).toHaveTextContent(/home screen/)

    await user.click(screen.getAllByRole('link', { name: 'Library' })[0] as HTMLElement)
    await screen.findByRole('heading', { level: 1, name: 'Your library' })
    expect(card()).not.toBeInTheDocument()
  })

  it("opens the browser's install dialog, focus moving to the page", async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    const prompt = browserOffersInstall()

    await user.click(within(card() as HTMLElement).getByRole('button', { name: 'Install' }))

    expect(prompt).toHaveBeenCalledOnce()
    expect(card()).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('goes away for a month with "Not now", also on the next visit', async () => {
    const now = Date.now()
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    const prompt = browserOffersInstall()

    await user.click(within(card() as HTMLElement).getByRole('button', { name: 'Not now' }))

    expect(prompt).not.toHaveBeenCalled()
    expect(card()).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveFocus()
    const until = usePwaStore.getState().installSnoozedUntil
    expect(until).toBeGreaterThanOrEqual(now + INSTALL_SNOOZE_MS)
    expect(JSON.parse(localStorage.getItem(PWA_STORAGE_KEY) ?? '{}')).toMatchObject({
      state: { installSnoozedUntil: until },
    })

    browserOffersInstall()
    expect(card()).not.toBeInTheDocument()
  })

  it('comes back once the month is over', async () => {
    act(() => usePwaStore.setState({ installSnoozedUntil: Date.now() - 1 }))
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    browserOffersInstall()
    expect(card()).toBeInTheDocument()
  })
})

describe('the Install app setting', () => {
  it('installs FXM where the browser offers it, and says so', async () => {
    const { user } = renderApp('/settings')
    await screen.findByRole('heading', { level: 2, name: 'App' })
    const prompt = browserOffersInstall('accepted')

    const install = screen.getByRole('button', { name: 'Install' })
    expect(install).toHaveAccessibleDescription(INSTALL_HELP.prompt)
    await user.click(install)

    expect(prompt).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    const help = await screen.findByText(INSTALL_HELP.added)
    // The button is gone, so its help text has focus.
    expect(help).toHaveFocus()
  })

  it('says how to install FXM where the browser makes no offer', async () => {
    renderApp('/settings')
    expect(await screen.findByText(INSTALL_HELP.browser)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  })

  it('explains Add to Home Screen on an iPhone', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    )
    renderApp('/settings')
    expect(await screen.findByText(INSTALL_HELP.ios)).toBeInTheDocument()
  })

  it('says so in the installed app', async () => {
    runAsInstalledApp()
    renderApp('/settings')
    expect(await screen.findByText(INSTALL_HELP.installed)).toBeInTheDocument()
  })

  it('is not in the Android and desktop apps, which are installed already', async () => {
    nativeAppBuild()
    renderApp('/settings')
    await screen.findByRole('heading', { level: 1, name: 'Settings' })
    browserOffersInstall()

    expect(screen.queryByRole('heading', { level: 2, name: 'App' })).not.toBeInTheDocument()
    expect(screen.queryByText(INSTALL_HELP.browser)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    // The rest of Settings is there.
    expect(screen.getByRole('heading', { level: 2, name: 'About' })).toBeInTheDocument()
  })
})
