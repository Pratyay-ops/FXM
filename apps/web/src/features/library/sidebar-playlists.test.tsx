import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { renderApp } from '../../test/render'
import { STATUS_VISIBLE_MS } from './status'

function stubRowLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const row = this.closest('li')
    const index = row?.parentElement ? [...row.parentElement.children].indexOf(row) : 0
    const top = 200 + index * 56
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 260,
      bottom: top + 56,
      width: 260,
      height: 56,
      toJSON: () => ({}),
    } as DOMRect
  })
}

const sidebarPlaylists = () =>
  within(
    within(screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement).getByRole(
      'region',
      { name: 'Your playlists' },
    ),
  )

const linkNames = () =>
  sidebarPlaylists()
    .getAllByRole('link')
    .map((link) => link.getAttribute('title'))

describe('Sidebar playlists', { timeout: 30_000 }, () => {
  it('reorders a playlist by dragging its row, without opening it', async () => {
    stubRowLayout()
    await getLibrary().createPlaylist({ name: 'Road trip' })
    const { user, router } = renderApp('/settings')
    await waitFor(() => expect(linkNames()).toEqual(['Road trip', 'Liked songs', 'Downloads']))

    // Press on Road trip (row 0), drag it below Downloads (row 2), let go.
    const road = sidebarPlaylists().getByRole('link', { name: /Road trip/ })
    await user.pointer([
      { keys: '[MouseLeft>]', target: road, coords: { clientX: 40, clientY: 228 } },
      { target: road, coords: { clientX: 40, clientY: 250 } },
      { target: road, coords: { clientX: 40, clientY: 340 } },
      { keys: '[/MouseLeft]', target: road, coords: { clientX: 40, clientY: 340 } },
    ])

    await waitFor(() => expect(linkNames()).toEqual(['Liked songs', 'Downloads', 'Road trip']))
    expect(router.state.location.pathname).toBe('/settings')
  })

  it('still opens a playlist with a plain click', async () => {
    const { user, router } = renderApp('/settings')
    // The sidebar's playlists load just after the shell.
    await user.click(
      await waitFor(() => sidebarPlaylists().getByRole('link', { name: /Downloads/ })),
    )
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/playlist/local:playlist:downloads'),
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Downloads' })).toBeInTheDocument()
  })

  it('confirms its actions on every page, and never late', async () => {
    await getLibrary().createPlaylist({ name: 'Road trip' })
    const { user } = renderApp('/settings')
    await user.click(
      await waitFor(() =>
        sidebarPlaylists().getByRole('button', { name: 'More options for Road trip' }),
      ),
    )
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }))

    // The shell has the one toast: Settings shows it too.
    expect(await screen.findByText('Created Road trip (copy)')).toBeInTheDocument()
    await waitFor(() =>
      expect(linkNames()).toEqual(['Road trip', 'Road trip (copy)', 'Liked songs', 'Downloads']),
    )

    // Opened a while later, the Library page doesn't show it again.
    const now = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => now() + STATUS_VISIBLE_MS + 1000)
    await user.click(
      within(screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement).getByRole(
        'link',
        { name: 'Library' },
      ),
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
    expect(screen.queryByText('Created Road trip (copy)')).not.toBeInTheDocument()
  })

  it('gives focus to the next playlist after deleting one from the sidebar', async () => {
    await getLibrary().createPlaylist({ name: 'Road trip' })
    const { user } = renderApp('/settings')
    await waitFor(() => expect(linkNames()).toEqual(['Road trip', 'Liked songs', 'Downloads']))

    await user.click(sidebarPlaylists().getByRole('button', { name: 'More options for Road trip' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete playlist?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(linkNames()).toEqual(['Liked songs', 'Downloads']))
    await waitFor(() =>
      expect(
        sidebarPlaylists().getByRole('button', { name: 'More options for Liked songs' }),
      ).toHaveFocus(),
    )
    expect(screen.getByText('Deleted Road trip')).toBeInTheDocument()
  })

  it('says when a sort from the Library page is shown, and goes back to the custom order', async () => {
    await getLibrary().createPlaylist({ name: 'Zulu' })
    const { user } = renderApp('/library')
    await waitFor(() => expect(linkNames()).toEqual(['Zulu', 'Liked songs', 'Downloads']))
    const main = within(screen.getByRole('main'))
    await user.click(await main.findByRole('button', { name: 'Sort: Custom order' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Name' }))

    await waitFor(() => expect(linkNames()).toEqual(['Downloads', 'Liked songs', 'Zulu']))
    expect(sidebarPlaylists().getByText('Sorted by name, A to Z')).toBeInTheDocument()

    await user.click(sidebarPlaylists().getByRole('button', { name: 'Show custom order' }))

    await waitFor(() => expect(linkNames()).toEqual(['Zulu', 'Liked songs', 'Downloads']))
    expect(sidebarPlaylists().queryByText('Sorted by name, A to Z')).not.toBeInTheDocument()
    // The line went with the sort, and its button with it: the Arrange button has focus.
    expect(sidebarPlaylists().getByRole('button', { name: 'Arrange playlists' })).toHaveFocus()
  })

  it('saves a sort as the custom order without either list showing the old order', async () => {
    await getLibrary().createPlaylist({ name: 'Zulu' })
    await getLibrary().createPlaylist({ name: 'Echo' })
    const { user } = renderApp('/library')
    const main = within(screen.getByRole('main'))
    const pageList = await main.findByRole('list', { name: 'Your playlists' })
    const pageNames = () =>
      within(pageList)
        .getAllByRole('link')
        .map((link) => link.textContent?.replace(/Playlist.*$/, '') ?? '')
    await waitFor(() => expect(linkNames()).toEqual(['Echo', 'Zulu', 'Liked songs', 'Downloads']))
    await user.click(await main.findByRole('button', { name: 'Sort: Custom order' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Name' }))
    const sorted = ['Downloads', 'Echo', 'Liked songs', 'Zulu']
    await waitFor(() => expect(linkNames()).toEqual(sorted))

    // Every order either list shows from here on.
    const shown: (string | null)[][] = []
    const observer = new MutationObserver(() => shown.push(linkNames(), pageNames()))
    observer.observe(document.body, { childList: true, subtree: true })
    await user.click(main.getByRole('button', { name: 'Save as custom order' }))
    expect(await main.findByText('The sorted order was saved.')).toBeInTheDocument()
    observer.disconnect()

    expect(main.getByRole('button', { name: 'Sort: Custom order' })).toBeInTheDocument()
    expect(shown.length).toBeGreaterThan(0)
    for (const order of shown) expect(order).toEqual(sorted)
  })

  it('creates a playlist from the sidebar', async () => {
    const { user } = renderApp('/settings')
    await user.click(
      await within(
        screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement,
      ).findByRole('button', { name: 'New playlist' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'New playlist' })
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: /^My playlist/ }),
    ).toBeInTheDocument()
  })
})
