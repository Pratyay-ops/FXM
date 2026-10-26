import { act, screen, waitFor, within } from '@testing-library/react'
import type { RouteObject } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppLayout } from '../components/layout/app-layout'
import { renderCatalog, resetCatalogState } from '../features/search/testing'
import { renderApp } from '../test/render'
import { RootError, RouteError } from './errors'

afterEach(() => resetCatalogState())

/** The app's route frame (shell, root and page error elements) around `page`. */
function shellAround(page: RouteObject, routeError = <RouteError />): RouteObject[] {
  return [
    {
      path: '/',
      element: <AppLayout />,
      errorElement: <RootError />,
      children: [{ errorElement: routeError, children: [page] }],
    },
  ]
}

describe('routes', () => {
  it.each([
    ['/', /^Good (morning|afternoon|evening)$/],
    ['/search', 'Search'],
    ['/library', 'Your library'],
    // No YouTube until the platform is wired in: the pages show the onboarding entry point.
    ['/album/ytm:MPREb_123', 'This album is on YouTube Music'],
    ['/artist/ytm:UC-abc', 'This artist is on YouTube Music'],
    ['/playlist/liked', 'Playlist liked'],
    ['/now-playing', 'Now playing'],
    ['/settings', 'Settings'],
    ['/connect', 'FXM Connect'],
    ['/no/such/page', 'Page not found'],
  ])('renders %s', async (path, name) => {
    renderApp(path)
    expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument()
  })

  it('titles the document after the page', async () => {
    renderApp('/settings')
    await screen.findByRole('heading', { level: 1, name: 'Settings' })
    expect(document.title).toBe('Settings · FXM')
  })

  it('fills the search box from ?q=', async () => {
    renderApp('/search?q=daft%20punk')
    expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument()
    for (const box of screen.getAllByRole('searchbox', { name: 'Search' })) {
      expect(box).toHaveValue('daft punk')
    }
  })

  it('writes what the user types into ?q= without a history entry per keystroke', async () => {
    const { user, router } = renderApp('/search')
    await screen.findByRole('heading', { level: 1, name: 'Search' })
    const box = screen.getAllByRole('searchbox', { name: 'Search' })[0] as HTMLElement

    await user.type(box, 'lofi beats')

    expect(box).toHaveValue('lofi beats')
    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get('q')).toBe('lofi beats'),
    )
    expect(router.state.location.pathname).toBe('/search')
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('opens the search page when typing in the top bar elsewhere, one Back away', async () => {
    const { user, router } = renderApp('/library')
    await screen.findByRole('heading', { level: 1, name: 'Your library' })
    const topBar = within(screen.getByRole('banner'))

    await user.type(topBar.getByRole('searchbox', { name: 'Search' }), 'jazz')

    await waitFor(() => expect(router.state.location.search).toBe('?q=jazz'))
    expect(router.state.location.pathname).toBe('/search')

    await act(() => router.navigate(-1))

    expect(router.state.location.pathname).toBe('/library')
  })

  // Results and their tabs need a source that can be searched, which the app gets once the
  // platform and providers are wired in: until then, these use the fake catalog.
  it('offers a Videos tab only in Music + Video mode', async () => {
    const { user } = renderCatalog('/search?q=lofi')
    const tabs = await screen.findByRole('tablist', { name: 'Result type' })
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Songs', 'Albums', 'Artists', 'Playlists'])

    await user.click(screen.getByRole('radio', { name: 'Music + Video' }))

    expect(within(tabs).getByRole('tab', { name: 'Videos' })).toBeInTheDocument()
  })

  it('falls back to Songs when switching to Music mode on the Videos tab', async () => {
    const { user } = renderCatalog('/search?q=lofi')
    const tabs = await screen.findByRole('tablist', { name: 'Result type' })
    await user.click(screen.getByRole('radio', { name: 'Music + Video' }))
    await user.click(within(tabs).getByRole('tab', { name: 'Videos' }))
    expect(within(tabs).getByRole('tab', { name: 'Videos' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await user.click(screen.getByRole('radio', { name: 'Music' }))

    // The tab list keeps a keyboard stop and the panel stays labelled by a real tab.
    const songs = within(tabs).getByRole('tab', { name: 'Songs' })
    expect(songs).toHaveAttribute('aria-selected', 'true')
    expect(songs).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', songs.id)
  })

  it('shows a friendly error inside the shell and recovers on "Try again"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let broken = true
    function FlakyPage() {
      if (broken) throw new Error('Flaky page')
      return <h1>Recovered</h1>
    }
    const { user } = renderApp('/', shellAround({ index: true, Component: FlakyPage }))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/Something went wrong/)
    expect(screen.getAllByRole('navigation', { name: 'Main' })).not.toHaveLength(0)

    broken = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Recovered' })).toBeInTheDocument()
  })

  it('asks to check the connection when a page fails to download, and reloads', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reload = vi.fn()
    const offline = new TypeError('Failed to fetch dynamically imported module: /app/assets/x.js')
    const { user } = renderApp(
      '/',
      shellAround(
        { index: true, lazy: () => Promise.reject(offline) },
        <RouteError reload={reload} />,
      ),
    )

    expect(
      await screen.findByText(
        'This page could not be loaded. Check your connection, then try again.',
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(reload).toHaveBeenCalledOnce()
  })
})
