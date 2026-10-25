import { screen, waitFor, within } from '@testing-library/react'
import type { RouteObject } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { AppLayout } from '../components/layout/app-layout'
import { renderApp } from '../test/render'
import { RootError, RouteError } from './errors'
import { routerBasename } from './router'

describe('routes', () => {
  it.each([
    ['/', /^Good (morning|afternoon|evening)$/],
    ['/search', 'Search'],
    ['/library', 'Your library'],
    ['/album/MPREb_123', 'Album MPREb_123'],
    ['/artist/UC-abc', 'Artist UC-abc'],
    ['/playlist/liked', 'Playlist liked'],
    ['/now-playing', 'Now playing'],
    ['/settings', 'Settings'],
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
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Results for “daft punk”' }),
    ).toBeInTheDocument()
    for (const box of screen.getAllByRole('searchbox', { name: 'Search' })) {
      expect(box).toHaveValue('daft punk')
    }
  })

  it('writes what the user types into ?q=', async () => {
    const { user, router } = renderApp('/search')
    await screen.findByRole('heading', { level: 1, name: 'Search' })
    const box = screen.getAllByRole('searchbox', { name: 'Search' })[0] as HTMLElement

    await user.type(box, 'lofi beats')

    expect(box).toHaveValue('lofi beats')
    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get('q')).toBe('lofi beats'),
    )
    expect(router.state.location.pathname).toBe('/search')
  })

  it('opens the search page when typing in the top bar elsewhere', async () => {
    const { user, router } = renderApp('/library')
    await screen.findByRole('heading', { level: 1, name: 'Your library' })
    const topBar = within(screen.getByRole('banner'))

    await user.type(topBar.getByRole('searchbox', { name: 'Search' }), 'jazz')

    await waitFor(() => expect(router.state.location.pathname).toBe('/search'))
    expect(router.state.location.search).toBe('?q=jazz')
  })

  it('offers a Videos tab only in Music + Video mode', async () => {
    const { user } = renderApp('/search?q=lofi')
    const tabs = await screen.findByRole('tablist', { name: 'Result type' })
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Songs', 'Albums', 'Artists', 'Playlists'])

    await user.click(screen.getByRole('radio', { name: 'Music + Video' }))

    expect(within(tabs).getByRole('tab', { name: 'Videos' })).toBeInTheDocument()
  })

  it('shows a friendly error inside the shell and recovers on "Try again"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let broken = true
    function FlakyPage() {
      if (broken) throw new Error('Flaky page')
      return <h1>Recovered</h1>
    }
    const flakyRoutes: RouteObject[] = [
      {
        path: '/',
        element: <AppLayout />,
        errorElement: <RootError />,
        children: [
          { errorElement: <RouteError />, children: [{ index: true, Component: FlakyPage }] },
        ],
      },
    ]
    const { user } = renderApp('/', flakyRoutes)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('navigation', { name: 'Main' })).not.toHaveLength(0)

    broken = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Recovered' })).toBeInTheDocument()
  })
})

describe('routerBasename', () => {
  it.each([
    ['/app/', '/app'],
    ['/app', '/app'],
    ['/', '/'],
  ])('turns base URL %s into basename %s', (base, basename) => {
    expect(routerBasename(base)).toBe(basename)
  })
})
