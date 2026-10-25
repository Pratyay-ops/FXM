import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'

// Both navigations render; CSS shows the sidebar from 768px and the tab bar below.
const mainNavs = () => screen.getAllByRole('navigation', { name: 'Main' })

describe('app layout', () => {
  it('renders the main navigation with the current page marked', async () => {
    renderApp('/library')
    await screen.findByRole('heading', { level: 1, name: 'Your library' })

    expect(mainNavs()).toHaveLength(2)
    for (const nav of mainNavs()) {
      const links = within(nav)
      expect(links.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page')
      expect(links.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
      expect(links.getByRole('link', { name: 'Search' })).not.toHaveAttribute('aria-current')
    }
  })

  it('moves the current-page mark when navigating', async () => {
    const { user } = renderApp('/')
    const sidebar = within(mainNavs()[0] as HTMLElement)
    expect(sidebar.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')

    await user.click(sidebar.getByRole('link', { name: 'Search' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument()
    expect(sidebar.getByRole('link', { name: 'Search' })).toHaveAttribute('aria-current', 'page')
    expect(sidebar.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
  })

  it('lists the playlists of the library in the sidebar, the open one marked', async () => {
    renderApp('/playlist/local:playlist:liked')
    const sidebar = within(mainNavs()[0] as HTMLElement)
    expect(await sidebar.findByRole('link', { name: /Liked songs/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(sidebar.getByRole('link', { name: /Downloads/ })).not.toHaveAttribute('aria-current')
  })

  it('has banner, main and player landmarks', async () => {
    renderApp('/')
    expect(await screen.findByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    // Player bar (768px+) and mini player (phones).
    expect(screen.getAllByRole('region', { name: 'Player' })).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })

  it('has player controls that respond but play nothing yet', async () => {
    const { user } = renderApp('/')
    const player = within(screen.getAllByRole('region', { name: 'Player' })[0] as HTMLElement)
    expect(player.getByText('0:00')).toBeInTheDocument()
    expect(player.getByText('3:33')).toBeInTheDocument()

    await user.click(player.getByRole('button', { name: 'Play' }))
    expect(player.getByRole('button', { name: 'Pause' })).toBeInTheDocument()

    await user.click(player.getByRole('button', { name: 'Shuffle' }))
    expect(player.getByRole('button', { name: 'Shuffle' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(player.getByRole('button', { name: 'Enable repeat' }))
    expect(player.getByRole('button', { name: 'Enable repeat one' })).toBeInTheDocument()

    expect(player.getByRole('slider', { name: 'Seek' })).toHaveAttribute(
      'aria-valuetext',
      '0:00 of 3:33',
    )
    expect(player.getByRole('link', { name: /Catalog mode: Music\./ })).toHaveAttribute(
      'href',
      '/settings',
    )
  })

  it('hides the mini player on Now Playing, which has its own controls', async () => {
    renderApp('/now-playing')
    await screen.findByRole('heading', { level: 1, name: 'Now playing' })
    expect(screen.getAllByRole('region', { name: 'Player' })).toHaveLength(1)
  })

  it('announces new pages to screen readers, but not the first page or query changes', async () => {
    const { user, router } = renderApp('/')
    await screen.findByRole('heading', { level: 1, name: /^Good/ })
    expect(screen.queryByText(/^Navigated to/)).not.toBeInTheDocument()

    await user.click(within(mainNavs()[0] as HTMLElement).getByRole('link', { name: 'Search' }))
    const announcer = await screen.findByText('Navigated to Search')
    expect(announcer).toHaveAttribute('aria-live', 'polite')

    // Typing a search changes only the query: no announcement.
    await act(() => router.navigate('/search?q=jazz'))
    expect(announcer.textContent).toBe('Navigated to Search')

    // Album to album has the same title: the text still changes, so it is read again.
    await act(() => router.navigate('/album/one'))
    await screen.findByRole('heading', { level: 1, name: 'Album not found' })
    expect(announcer.textContent).toBe('Navigated to Album')
    await act(() => router.navigate('/album/two'))
    await screen.findByRole('heading', { level: 1, name: 'Album not found' })
    expect(announcer.textContent).toBe('Navigated to Album ')
  })
})
