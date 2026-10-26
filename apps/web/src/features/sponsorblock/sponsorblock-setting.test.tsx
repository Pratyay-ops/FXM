import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { useSettingsStore } from '../settings/settings-store'
import { SPONSORBLOCK_STORAGE_KEY, useSponsorBlockStore } from './sponsorblock-store'

const SWITCH = 'Skip non-music parts of videos'

describe('SponsorBlock in Settings', () => {
  it('has a switch in Playback, off by default, that turns skipping on', async () => {
    const { user } = renderApp('/settings')
    const playback = await screen.findByRole('region', { name: 'Playback' })
    const toggle = within(playback).getByRole('switch', { name: SWITCH })
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/skips the intros, skits and outros/)

    await user.click(toggle)

    expect(toggle).toBeChecked()
    expect(useSponsorBlockStore.getState()).toMatchObject({ enabled: true, offered: true })
    expect(JSON.parse(localStorage.getItem(SPONSORBLOCK_STORAGE_KEY) ?? 'null')).toMatchObject({
      state: { enabled: true },
    })
  })

  it('says how it keeps what plays private', async () => {
    renderApp('/settings')
    const playback = await screen.findByRole('region', { name: 'Playback' })
    expect(playback).toHaveTextContent(/never about the one that plays/)
  })

  it('credits SponsorBlock and its licence in Playback and in About', async () => {
    renderApp('/settings')
    for (const name of ['Playback', 'About']) {
      const section = await screen.findByRole('region', { name })
      expect(section).toHaveTextContent(
        'Uses SponsorBlock data licensed under CC BY-NC-SA 4.0 (opens in a new tab) from sponsor.ajay.app (opens in a new tab).',
      )
      const licence = within(section).getByRole('link', { name: /CC BY-NC-SA 4\.0/ })
      expect(licence).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-nc-sa/4.0/')
      expect(licence).toHaveAttribute('target', '_blank')
      expect(licence).toHaveAttribute('rel', 'noreferrer')
      expect(within(section).getByRole('link', { name: /sponsor\.ajay\.app/ })).toHaveAttribute(
        'href',
        'https://sponsor.ajay.app/',
      )
    }
  })

  it('says skipping waits for Music + Video mode when it is on in Music mode', async () => {
    useSponsorBlockStore.getState().setEnabled(true)
    renderApp('/settings')
    const hint = await screen.findByText(/starts working when you switch the catalog mode/)
    act(() => useSettingsStore.getState().setCatalogMode('all'))
    expect(hint).not.toBeInTheDocument()
  })
})
