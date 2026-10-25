import { act, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { STANDALONE_QUERY } from './install'
import { INSTALL_HELP } from './install-setting'
import { type InstallChoice, type InstallPromptEvent, usePwaStore } from './pwa-store'

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

const banner = () => within(screen.getByRole('banner'))

describe('install button', () => {
  it("is not there while the browser doesn't offer to install FXM", async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(banner().queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument()
  })

  it("opens the browser's install dialog from the top bar", async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    const prompt = browserOffersInstall()

    await user.click(banner().getByRole('button', { name: 'Install app' }))

    expect(prompt).toHaveBeenCalledOnce()
    // The offer is used up: the browser makes a new one if the user said no.
    expect(banner().queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument()
  })

  it('stays away in the installed app', async () => {
    runAsInstalledApp()
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    browserOffersInstall()
    expect(banner().queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument()
  })
})

describe('the Install app setting', () => {
  it('installs FXM where the browser offers it', async () => {
    const { user } = renderApp('/settings')
    await screen.findByRole('heading', { level: 2, name: 'App' })
    const prompt = browserOffersInstall('dismissed')

    const install = screen.getByRole('button', { name: 'Install' })
    expect(install).toHaveAccessibleDescription(INSTALL_HELP.prompt)
    await user.click(install)

    expect(prompt).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
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
})
