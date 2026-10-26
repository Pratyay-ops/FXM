import { act, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as appUpdate from '../../lib/app-update'
import { AppUpdatedError } from '../../lib/app-update'
import { createSources, createStaticPlatform, TIER_CAPABILITIES } from './sources'
import { SourcesProvider } from './sources-context'
import { SpotifySwitchHelp } from './spotify-setting'
import { renderCatalog, resetCatalogState } from './testing'

// Pages are lazy chunks and the machine running the tests may be busy.
const SLOW = { timeout: 5000 }

afterEach(() => resetCatalogState())

describe('while FXM Connect is answering', () => {
  it('says FXM is connecting rather than offering the install, and then shows what it found', async () => {
    const { sources } = renderCatalog('/search?q=harbor', { tier: 'free', freeSources: true })
    act(() => sources.setDetecting(true))

    expect(
      await screen.findByRole('heading', { name: 'Connecting to FXM Connect…' }, SLOW),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Get FXM Connect/ })).not.toBeInTheDocument()

    // It never answered within the grace period: as good as no FXM Connect.
    act(() => sources.setDetecting(false))

    expect(
      screen.getByRole('heading', { name: 'Search needs YouTube Music access' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get FXM Connect/ })).toBeInTheDocument()
  })

  it("doesn't show the install banner on the empty search page", async () => {
    const { sources } = renderCatalog('/search', { tier: 'free' })
    await screen.findByRole('heading', { level: 1, name: 'Search' }, SLOW)
    expect(screen.getByRole('region', { name: /Search needs YouTube Music access/ })).toBeVisible()

    act(() => sources.setDetecting(true))

    expect(
      screen.queryByRole('region', { name: /Search needs YouTube Music access/ }),
    ).not.toBeInTheDocument()
  })

  it('says so on the page of an album on YouTube Music too', async () => {
    const { sources } = renderCatalog('/album/ytm:alb-neon-harbor', { tier: 'free' })
    act(() => sources.setDetecting(true))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Connecting to FXM Connect…' }, SLOW),
    ).toBeInTheDocument()
  })
})

describe('the Free tier on the search page', () => {
  it('offers the free sources in place of YouTube Music, and moves the focus to their results', async () => {
    const { user, ytm } = renderCatalog('/search?q=harbor', { tier: 'free', freeSources: true })
    const notice = await screen.findByRole(
      'heading',
      { name: 'Search needs YouTube Music access' },
      SLOW,
    )
    expect(notice).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search Jamendo instead' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Search Internet Archive instead' }))

    const searchIn = screen.getByRole('radiogroup', { name: 'Search in' })
    expect(within(searchIn).getByRole('radio', { name: 'Internet Archive' })).toBeChecked()
    expect(screen.getByRole('heading', { name: 'Results for “harbor”' })).toHaveFocus()
    const songs = await screen.findByRole('list', { name: 'Songs' }, SLOW)
    expect(within(songs).getAllByText('Internet Archive').length).toBeGreaterThan(0)
    expect(ytm.calls).toEqual([])
  })
})

describe('code that was replaced by an update', () => {
  it('says FXM was updated and offers a reload, never "Try again"', async () => {
    const reload = vi.spyOn(appUpdate, 'reloadApp').mockImplementation(() => {})
    const { user, ytm } = renderCatalog('/search?q=harbor', { tier: 'full' })
    ytm.fail('search', new AppUpdatedError('Could not load YouTube Music'))

    const alert = await screen.findByRole('alert', {}, SLOW)

    expect(alert).toHaveTextContent('FXM was updated. Reload to get the new version.')
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledOnce()
  })
})

describe("Spotify's switch in Settings", () => {
  it("says when this version can't read Spotify in a browser yet", () => {
    // FXM Connect reaches Spotify, but no Spotify provider is registered (stage 1.10's sandbox
    // documents are not wired in yet).
    const sources = createSources({ platform: createStaticPlatform(TIER_CAPABILITIES.full) })

    render(
      <SourcesProvider sources={sources}>
        <SpotifySwitchHelp />
      </SourcesProvider>,
    )

    expect(
      screen.getByText("On, but this version of FXM can't read Spotify in a browser yet.", {
        exact: false,
      }),
    ).toBeInTheDocument()
  })
})
