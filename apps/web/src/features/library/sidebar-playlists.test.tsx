import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { renderApp } from '../../test/render'

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
