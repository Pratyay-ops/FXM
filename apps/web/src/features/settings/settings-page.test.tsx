import { APP_VERSION } from '@fxm/core'
import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from './settings-store'

const storedSettings = () => JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')

describe('Settings page', () => {
  it('switches the catalog mode, explains it and saves it', async () => {
    const { user } = renderApp('/settings')
    const musicAndVideo = await screen.findByRole('radio', { name: 'Music + Video' })
    expect(screen.getByRole('radio', { name: 'Music' })).toBeChecked()
    expect(screen.getByText(/songs only, from any source/)).toBeInTheDocument()

    await user.click(musicAndVideo)

    expect(musicAndVideo).toBeChecked()
    expect(useSettingsStore.getState().catalogMode).toBe('all')
    expect(screen.getByText(/also any YouTube video/)).toBeInTheDocument()
    expect(storedSettings()).toMatchObject({ state: { catalogMode: 'all' } })
  })

  it('names the mode control and links it to its explanation', async () => {
    renderApp('/settings')
    const group = await screen.findByRole('radiogroup', { name: 'Catalog mode' })
    expect(group).toHaveAccessibleDescription(/songs only, from any source/)
  })

  it('follows mode changes made elsewhere, such as the search page', async () => {
    renderApp('/settings')
    await screen.findByRole('radio', { name: 'Music + Video' })
    act(() => useSettingsStore.getState().setCatalogMode('all'))
    expect(screen.getByRole('radio', { name: 'Music + Video' })).toBeChecked()
  })

  it('changes the theme and applies it to the page', async () => {
    const { user } = renderApp('/settings')
    expect(document.documentElement.dataset.theme).toBe('dark')

    await user.click(await screen.findByRole('radio', { name: 'Light' }))

    expect(useSettingsStore.getState().theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(storedSettings()).toMatchObject({ state: { theme: 'light' } })
  })

  it('shows the version from @fxm/core and links to the source code', async () => {
    renderApp('/settings')
    expect(await screen.findByText(new RegExp(`Version ${APP_VERSION}`))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Source on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/Pratyay-ops/FXM',
    )
  })
})

describe('Settings → About', () => {
  it('says FXM is independent, and links its privacy page, disclaimer and notices', async () => {
    renderApp('/settings')
    const about = await screen.findByRole('region', { name: 'About' })
    expect(about).toHaveTextContent(
      'FXM is an independent open-source project, not affiliated with or endorsed by YouTube, Google or Spotify, and it hosts no music.',
    )
    const legal = within(about).getByRole('list', { name: 'Legal' })
    expect(
      within(legal)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      'https://fxmusic.pages.dev/privacy',
      'https://fxmusic.pages.dev/disclaimer',
      // This build's own notices, at the root of the deploy that serves its /app/.
      '/third-party-notices.txt',
    ])
    // Each says it opens a new tab, as the app's other links to other sites do.
    expect(
      within(legal).getByRole('link', { name: 'Privacy (opens in a new tab)' }),
    ).toHaveAttribute('target', '_blank')
  })

  it('offers no Auto setting while the matching config keeps the band off', async () => {
    renderApp('/settings')
    await screen.findByRole('region', { name: 'Playback' })
    expect(screen.queryByRole('checkbox', { name: /Play sure matches automatically/ })).toBeNull()
  })
})
