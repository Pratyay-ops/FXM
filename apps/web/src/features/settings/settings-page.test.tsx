import { APP_VERSION } from '@fxm/core'
import { act, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from './settings-store'

const storedSettings = () => JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')

describe('Settings page', () => {
  it('switches the catalog mode, explains it and saves it', async () => {
    const { user } = renderApp('/settings')
    const musicAndVideo = await screen.findByRole('radio', { name: 'Music + Video' })
    expect(screen.getByRole('radio', { name: 'Music' })).toBeChecked()
    expect(screen.getByText(/only songs from the YouTube Music catalog/)).toBeInTheDocument()

    await user.click(musicAndVideo)

    expect(musicAndVideo).toBeChecked()
    expect(useSettingsStore.getState().catalogMode).toBe('all')
    expect(screen.getByText(/also any YouTube video/)).toBeInTheDocument()
    expect(storedSettings()).toMatchObject({ state: { catalogMode: 'all' } })
  })

  it('names the mode control and links it to its explanation', async () => {
    renderApp('/settings')
    const group = await screen.findByRole('radiogroup', { name: 'Catalog mode' })
    expect(group).toHaveAccessibleDescription(/only songs from the YouTube Music catalog/)
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
