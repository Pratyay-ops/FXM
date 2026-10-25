import type { EntityId } from '@fxm/core'
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createSeededRandom, shuffleKeys } from '../../db/ordering'
import { getLibrary, resetLibrary } from '../../db/repo'
import { DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID, PLAYLISTS_ORDER_ID } from '../../db/types'
import { track, tracks } from '../../test/library-fixtures'
import { renderApp } from '../../test/render'
import { playlistPath } from './paths'

/**
 * happy-dom lays nothing out, so every rectangle is empty. Drag and drop needs real positions:
 * give each list item a 56 px row by its place among its siblings.
 */
function stubRowLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const row = this.closest('li')
    const index = row?.parentElement ? [...row.parentElement.children].indexOf(row) : 0
    const top = 100 + index * 56
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 800,
      bottom: top + 56,
      width: 800,
      height: 56,
      toJSON: () => ({}),
    } as DOMRect
  })
}

/** The names of a list's rows, from their "More options for …" buttons. */
function rowNames(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('button', { name: /^More options for / })
    .map((button) => button.getAttribute('aria-label')?.replace('More options for ', '') ?? '')
}

const main = () => within(screen.getByRole('main'))
const sidebar = () => within(screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement)
const songs = (name: string) => screen.findByRole('list', { name: `Songs in ${name}` })

async function playlistWith(name: string, count: number) {
  return getLibrary().createPlaylist({ name, tracks: tracks(count) })
}

describe('Library page', { timeout: 30_000 }, () => {
  it('shows Liked songs and Downloads before anything else is there', async () => {
    renderApp('/library')
    const list = await main().findByRole('list', { name: 'Your playlists' })
    await waitFor(() => expect(rowNames(list)).toEqual(['Liked songs', 'Downloads']))
    expect(main().getByRole('heading', { name: 'Make your first playlist' })).toBeInTheDocument()
  })

  it('creates a playlist, opens it and lists it in the sidebar', async () => {
    const { user, router } = renderApp('/library')
    await user.click(await main().findByRole('button', { name: 'New playlist' }))
    const dialog = await screen.findByRole('dialog', { name: 'New playlist' })
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    await waitFor(() => expect(name).toHaveValue('My playlist #1'))

    await user.clear(name)
    await user.type(name, 'Road trip')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Road trip' })).toBeInTheDocument()
    expect(router.state.location.pathname).toMatch(/^\/playlist\/local:playlist:[0-9a-f-]{36}$/)
    expect(await sidebar().findByRole('link', { name: /Road trip/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('heading', { name: 'This playlist is empty' })).toBeInTheDocument()
  })

  it('renames, duplicates and deletes a playlist from its page', async () => {
    const id = await playlistWith('Draft', 2)
    const { user, router } = renderApp(playlistPath(id))
    await screen.findByRole('heading', { level: 1, name: 'Draft' })

    await user.click(main().getByRole('button', { name: 'More options for Draft' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit details…' }))
    const edit = await screen.findByRole('dialog', { name: 'Edit details' })
    await user.clear(within(edit).getByRole('textbox', { name: 'Name' }))
    await user.type(within(edit).getByRole('textbox', { name: 'Name' }), 'Final')
    await user.click(within(edit).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Final' })).toBeInTheDocument()

    await user.click(main().getByRole('button', { name: 'More options for Final' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }))
    expect(await sidebar().findByRole('link', { name: /Final \(copy\)/ })).toBeInTheDocument()

    await user.click(main().getByRole('button', { name: 'More options for Final' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete playlist?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/library'))
    expect(await getLibrary().getPlaylistView(id)).toBeUndefined()
  })

  it('reorders songs with the keyboard (drag and drop) and with the move buttons', async () => {
    stubRowLayout()
    const id = await playlistWith('Mix', 4)
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 1', 'Song 2', 'Song 3', 'Song 4']))

    // Pick Song 1 up with Space, move it down two places, drop it with Space.
    within(list).getByRole('button', { name: 'Reorder Song 1' }).focus()
    await user.keyboard(' ')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')
    await user.keyboard(' ')
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 2', 'Song 3', 'Song 1', 'Song 4']))

    // Move to top, from the song's menu.
    await user.click(within(list).getByRole('button', { name: 'More options for Song 4' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to top' }))
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 4', 'Song 2', 'Song 3', 'Song 1']))

    // The same menu by keyboard: at the top, "Move down" is the first entry that applies.
    within(list).getByRole('button', { name: 'More options for Song 4' }).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menuitem', { name: 'Move down' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 2', 'Song 4', 'Song 3', 'Song 1']))

    await user.click(within(list).getByRole('button', { name: 'More options for Song 2' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to bottom' }))
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 4', 'Song 3', 'Song 1', 'Song 2']))
    expect(await getLibrary().getOrder(id)).toEqual([4, 3, 1, 2].map((n) => track(n).id))
  })

  it('moves several selected songs at once', async () => {
    const id = await playlistWith('Mix', 6)
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')
    await user.click(main().getByRole('button', { name: 'Select', pressed: false }))

    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 3' }))
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 5' }))
    expect(main().getByText('2 selected')).toBeInTheDocument()
    await user.click(main().getByRole('button', { name: 'Move' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to top' }))
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Song 3', 'Song 5', 'Song 1', 'Song 2', 'Song 4', 'Song 6']),
    )

    // Shift + click selects a range.
    await user.click(main().getByRole('button', { name: 'Clear selection' }))
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 2' }))
    await user.keyboard('{Shift>}')
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 6' }))
    await user.keyboard('{/Shift}')
    expect(main().getByText('3 selected')).toBeInTheDocument()
    await user.click(main().getByRole('button', { name: 'Move' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }))
    // Each selected song moves one place up, past the nearest song that stays.
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Song 3', 'Song 5', 'Song 2', 'Song 4', 'Song 6', 'Song 1']),
    )
  })

  it('drags a selection with the pointer', async () => {
    stubRowLayout()
    const id = await playlistWith('Mix', 5)
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')
    await user.click(main().getByRole('button', { name: 'Select', pressed: false }))
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 1' }))
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 2' }))

    // Grab Song 1's handle and drop it on Song 4 (rows are 56 px, from 100 px down).
    const handle = within(list).getByRole('button', { name: 'Reorder Song 1' })
    await user.pointer([
      { keys: '[MouseLeft>]', target: handle, coords: { clientX: 20, clientY: 128 } },
      { target: handle, coords: { clientX: 20, clientY: 160 } },
      { target: handle, coords: { clientX: 20, clientY: 296 } },
      { keys: '[/MouseLeft]', target: handle, coords: { clientX: 20, clientY: 296 } },
    ])

    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Song 3', 'Song 4', 'Song 1', 'Song 2', 'Song 5']),
    )
  })

  it('shuffles the saved order for good, with Undo', async () => {
    await resetLibrary({ random: createSeededRandom(5) })
    const id = await playlistWith('Mix', 8)
    const original = tracks(8).map((item) => item.id)
    const expected = shuffleKeys(original, createSeededRandom(5))
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')

    await user.click(main().getByRole('button', { name: 'Shuffle order' }))

    await waitFor(async () => expect(await getLibrary().getOrder(id)).toEqual(expected))
    await waitFor(() =>
      expect(rowNames(list)).toEqual(
        expected.map((trackId) => `Song ${Number(trackId.slice(-4))}`),
      ),
    )
    expect(main().getByText('The order was shuffled.')).toBeInTheDocument()

    await user.click(main().getByRole('button', { name: 'Undo shuffle' }))

    await waitFor(async () => expect(await getLibrary().getOrder(id)).toEqual(original))
    await waitFor(() =>
      expect(main().queryByRole('button', { name: 'Undo shuffle' })).not.toBeInTheDocument(),
    )
  })

  it('sorts as a view, then saves the sort as the custom order', async () => {
    const id = await getLibrary().createPlaylist({
      name: 'Mix',
      tracks: [
        track(1, { title: 'Charlie', durationMs: 200_000 }),
        track(2, { title: 'alpha', durationMs: 300_000 }),
        track(3, { title: 'Bravo', durationMs: 100_000 }),
      ],
    })
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')

    await user.click(main().getByRole('button', { name: 'Sort: Custom order' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Title' }))
    await waitFor(() => expect(rowNames(list)).toEqual(['alpha', 'Bravo', 'Charlie']))
    expect(main().getByText('Sorted by title, A to Z.')).toBeInTheDocument()
    // A sorted view has no custom order to drag: the handles are gone.
    expect(within(list).queryByRole('button', { name: /^Reorder / })).not.toBeInTheDocument()
    // Still only a view.
    expect(await getLibrary().getOrder(id)).toEqual([1, 2, 3].map((n) => track(n).id))

    await user.click(main().getByRole('button', { name: 'Sort: Title' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Z to A' }))
    await waitFor(() => expect(rowNames(list)).toEqual(['Charlie', 'Bravo', 'alpha']))

    await user.click(main().getByRole('button', { name: 'Save as custom order' }))

    await waitFor(async () =>
      expect(await getLibrary().getOrder(id)).toEqual([1, 3, 2].map((n) => track(n).id)),
    )
    expect(await main().findByText('The sorted order was saved.')).toBeInTheDocument()
    expect(main().getByRole('button', { name: 'Sort: Custom order' })).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Reorder Charlie' })).toBeInTheDocument()
  })

  it('reorders the list of playlists, also from the sidebar', async () => {
    stubRowLayout()
    const a = await getLibrary().createPlaylist({ name: 'Alpha' })
    const b = await getLibrary().createPlaylist({ name: 'Bravo' })
    const { user } = renderApp('/library')
    const list = await main().findByRole('list', { name: 'Your playlists' })
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Bravo', 'Alpha', 'Liked songs', 'Downloads']),
    )

    within(list).getByRole('button', { name: 'Reorder Liked songs' }).focus()
    await user.keyboard(' ')
    await user.keyboard('{ArrowUp}')
    await user.keyboard('{ArrowUp}')
    await user.keyboard(' ')
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Liked songs', 'Bravo', 'Alpha', 'Downloads']),
    )

    await user.click(within(list).getByRole('button', { name: 'More options for Downloads' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }))
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Liked songs', 'Bravo', 'Downloads', 'Alpha']),
    )

    // The sidebar shows the same order and changes it too.
    const sidebarList = await sidebar().findByRole('region', { name: 'Your playlists' })
    await waitFor(() =>
      expect(rowNames(sidebarList)).toEqual(['Liked songs', 'Bravo', 'Downloads', 'Alpha']),
    )
    await user.click(within(sidebarList).getByRole('button', { name: 'More options for Alpha' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to top' }))
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Alpha', 'Liked songs', 'Bravo', 'Downloads']),
    )
    expect(await getLibrary().getOrder(PLAYLISTS_ORDER_ID)).toEqual([
      a,
      LIKED_PLAYLIST_ID,
      b,
      DOWNLOADS_PLAYLIST_ID,
    ])
  })

  it('sorts, shuffles and undoes the list of playlists from the sidebar', async () => {
    await resetLibrary({ random: createSeededRandom(1) })
    await getLibrary().createPlaylist({ name: 'Zulu' })
    await getLibrary().createPlaylist({ name: 'Echo' })
    const { user } = renderApp('/library')
    const list = await main().findByRole('list', { name: 'Your playlists' })
    await waitFor(() => expect(rowNames(list)).toHaveLength(4))
    const before = rowNames(list)

    await user.click(await sidebar().findByRole('button', { name: 'Arrange playlists' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Name' }))
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Downloads', 'Echo', 'Liked songs', 'Zulu']),
    )
    await user.click(sidebar().getByRole('button', { name: 'Arrange playlists' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Save as custom order' }))
    await waitFor(async () =>
      expect((await getLibrary().getPlaylistList()).items.map((item) => item.name)).toEqual([
        'Downloads',
        'Echo',
        'Liked songs',
        'Zulu',
      ]),
    )

    await user.click(sidebar().getByRole('button', { name: 'Arrange playlists' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Undo saved sort' }))
    await waitFor(() => expect(rowNames(list)).toEqual(before))

    await user.click(sidebar().getByRole('button', { name: 'Arrange playlists' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Shuffle order' }))
    await waitFor(() => expect(rowNames(list)).not.toEqual(before))
    expect([...rowNames(list)].sort()).toEqual([...before].sort())
  })

  it('likes the playing track from the player bar', async () => {
    const { user } = renderApp('/library?tab=liked')
    expect(
      await main().findByRole('heading', { name: 'Songs you like show up here' }),
    ).toBeInTheDocument()
    const player = within(screen.getAllByRole('region', { name: 'Player' })[0] as HTMLElement)
    // The like button loads just after the shell; until then it is a disabled stand-in.
    await waitFor(() => expect(player.getByRole('button', { name: 'Like' })).toBeEnabled())

    await user.click(player.getByRole('button', { name: 'Like', pressed: false }))

    const list = await songs('Liked songs')
    expect(rowNames(list)).toEqual(['Track title'])
    // Every like button follows, the mini player's too.
    await waitFor(() => {
      for (const region of screen.getAllByRole('region', { name: 'Player' })) {
        expect(within(region).getByRole('button', { name: 'Like' })).toHaveAttribute(
          'aria-pressed',
          'true',
        )
      }
    })

    await user.click(player.getByRole('button', { name: 'Like', pressed: true }))
    expect(
      await main().findByRole('heading', { name: 'Songs you like show up here' }),
    ).toBeInTheDocument()
  })

  it('adds songs to a playlist and removes them', async () => {
    const library = getLibrary()
    for (const n of [1, 2]) await library.like(track(n))
    const id = await library.createPlaylist({ name: 'Mix', tracks: [track(3)] })
    const { user } = renderApp('/library?tab=liked')
    const liked = await songs('Liked songs')

    await user.click(within(liked).getByRole('button', { name: 'More options for Song 1' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add to playlist…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add to playlist' })
    await user.click(await within(dialog).findByRole('button', { name: /Mix/ }))
    expect(await screen.findByText('Added to Mix')).toBeInTheDocument()
    expect(await library.getOrder(id)).toEqual([track(3).id, track(1).id])

    await user.click(within(liked).getByRole('button', { name: 'More options for Song 2' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from Liked songs' }))
    await waitFor(() => expect(rowNames(liked)).toEqual(['Song 1']))
  })

  it('keeps Downloads as a built-in playlist that can be reordered but not renamed or deleted', async () => {
    const { user } = renderApp('/library')
    const list = await main().findByRole('list', { name: 'Your playlists' })
    await waitFor(() => expect(rowNames(list)).toContain('Downloads'))

    await user.click(within(list).getByRole('button', { name: 'More options for Downloads' }))
    const menu = await screen.findByRole('menu', { name: 'More options for Downloads' })
    const entries = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
    expect(entries).toEqual(['Move to top', 'Move up', 'Move down', 'Move to bottom', 'Duplicate'])
    await user.keyboard('{Escape}')

    await user.click(main().getByRole('tab', { name: 'Downloads' }))
    expect(await main().findByRole('heading', { name: 'No downloads yet' })).toBeInTheDocument()
    await expect(getLibrary().deletePlaylist(DOWNLOADS_PLAYLIST_ID)).rejects.toMatchObject({
      code: 'protected',
    })

    // The download manager (stage 4.1) fills it; its songs can't be removed by hand.
    await getLibrary().addDownload(track(1))
    await getLibrary().addDownload(track(2))
    const downloads = await songs('Downloads')
    expect(rowNames(downloads)).toEqual(['Song 2', 'Song 1'])
    await user.click(within(downloads).getByRole('button', { name: 'More options for Song 2' }))
    const rowMenu = await screen.findByRole('menu', { name: 'More options for Song 2' })
    expect(within(rowMenu).queryByRole('menuitem', { name: /Remove from/ })).not.toBeInTheDocument()
    await user.click(within(rowMenu).getByRole('menuitem', { name: 'Move down' }))
    await waitFor(() => expect(rowNames(downloads)).toEqual(['Song 1', 'Song 2']))
  })

  it('lists followed artists, saved albums and recently played songs', async () => {
    const library = getLibrary()
    await library.follow({
      id: 'ytm:artist:UC1' as EntityId<'artist'>,
      source: 'ytm',
      name: 'Band',
      artwork: [],
    })
    await library.follow({
      id: 'ytm:album:MPREb_1' as EntityId<'album'>,
      source: 'ytm',
      name: 'Record',
      artists: [{ name: 'Band' }],
      artwork: [],
    })
    await library.recordPlay({ track: track(7), playedMs: 1000, completed: false, skipped: false })
    const { user } = renderApp('/library?tab=artists')

    expect(await main().findByRole('link', { name: 'Band Artist' })).toHaveAttribute(
      'href',
      '/artist/ytm:artist:UC1',
    )

    await user.click(main().getByRole('tab', { name: 'Albums' }))
    expect(await main().findByRole('link', { name: 'Record Band' })).toHaveAttribute(
      'href',
      '/album/ytm:album:MPREb_1',
    )

    await user.click(main().getByRole('tab', { name: 'Recently played' }))
    const recent = await main().findByRole('list', { name: 'Recently played' })
    expect(rowNames(recent)).toEqual(['Song 7'])
    await user.click(main().getByRole('button', { name: 'Clear history' }))
    const confirm = await screen.findByRole('dialog', { name: 'Clear listening history?' })
    await user.click(within(confirm).getByRole('button', { name: 'Clear history' }))
    expect(await main().findByRole('heading', { name: 'Nothing played yet' })).toBeInTheDocument()
  })

  it('says so when a local playlist does not exist', async () => {
    renderApp('/playlist/local:playlist:missing')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Playlist not found' }),
    ).toBeInTheDocument()
  })
})
