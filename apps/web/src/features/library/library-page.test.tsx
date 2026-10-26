import { createSeededRandom, type EntityId, fisherYatesShuffle } from '@fxm/core'
import { act, screen, waitFor, within } from '@testing-library/react'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary, resetLibrary } from '../../db/repo'
import { DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID, PLAYLISTS_ORDER_ID } from '../../db/types'
import { track, tracks } from '../../test/library-fixtures'
import { renderApp } from '../../test/render'
import { setupTestPlayback } from '../now-playing/testing'
import { playlistPath as sourcePlaylistPath } from '../search/catalog/links'
import { renderCatalog, resetCatalogState } from '../search/testing'
import { playlistPath } from './paths'
import { useLibraryViewStore } from './view-store'

afterEach(() => resetCatalogState())

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

/** A phone's window: only Tailwind's `max-sm` query (below 640 px) matches. */
function phoneWindow() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === '(width < 40rem)',
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
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
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete playlist?' })
    // It can't be undone: focus starts on Cancel, so an extra Enter deletes nothing.
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus()
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
    const expected = fisherYatesShuffle(original, createSeededRandom(5))
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

  it('puts Shuffle order in the sort menu on phones, where it keeps its label', async () => {
    phoneWindow()
    await resetLibrary({ random: createSeededRandom(5) })
    const id = await playlistWith('Mix', 8)
    const { user } = renderApp(playlistPath(id))
    await songs('Mix')
    // Two chips with their labels fit a 320 px phone; a third would be an unlabelled icon.
    expect(main().queryByRole('button', { name: 'Shuffle order' })).not.toBeInTheDocument()
    expect(main().getByRole('button', { name: 'Select', pressed: false })).toHaveTextContent(
      'Select',
    )

    await user.click(main().getByRole('button', { name: 'Sort: Custom order' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Shuffle order' }))

    expect(await main().findByText('The order was shuffled.')).toBeInTheDocument()
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
    // The button went with the sort view: focus is on the sort button, not lost.
    expect(main().getByRole('button', { name: 'Sort: Custom order' })).toHaveFocus()
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
    // Rows can't be dragged in a sorted view: the sidebar says which view it shows.
    expect(sidebar().getByText('Sorted by name, A to Z')).toBeInTheDocument()
    await user.click(
      sidebar().getByRole('button', { name: 'Arrange playlists, sorted by name, a to z' }),
    )
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
    const { player: appPlayer } = setupTestPlayback()
    await appPlayer.setQueue([track(7)], { autoplay: false })
    const { user } = renderApp('/library?tab=liked')
    expect(
      await main().findByRole('heading', { name: 'Songs you like show up here' }),
    ).toBeInTheDocument()
    const player = within(screen.getAllByRole('region', { name: 'Player' })[0] as HTMLElement)
    // The like button loads just after the shell; until then it is a disabled stand-in.
    await waitFor(() => expect(player.getByRole('button', { name: 'Like' })).toBeEnabled())

    await user.click(player.getByRole('button', { name: 'Like', pressed: false }))

    const list = await songs('Liked songs')
    expect(rowNames(list)).toEqual(['Song 7'])
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
      '/artist/ytm:UC1',
    )

    await user.click(main().getByRole('tab', { name: 'Albums' }))
    expect(await main().findByRole('link', { name: 'Record Band' })).toHaveAttribute(
      'href',
      '/album/ytm:MPREb_1',
    )

    await user.click(main().getByRole('tab', { name: 'Recently played' }))
    const recent = await main().findByRole('list', { name: 'Recently played' })
    expect(rowNames(recent)).toEqual(['Song 7'])
    // The song the player is on is marked in the history too.
    const { player } = setupTestPlayback()
    await act(() => player.setQueue([track(7)], { autoplay: false }))
    expect(within(recent).getByRole('listitem')).toHaveAttribute('aria-current', 'true')
    expect(within(recent).getByRole('listitem')).toHaveTextContent('Song 7. Paused')
    await user.click(main().getByRole('button', { name: 'Clear history' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Clear listening history?' })
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(confirm).getByRole('button', { name: 'Clear history' }))
    expect(await main().findByRole('heading', { name: 'Nothing played yet' })).toBeInTheDocument()
    // The button went with the list: the tab panel keeps focus.
    await waitFor(() => expect(main().getByRole('tabpanel')).toHaveFocus())
  })

  it('opens what it follows on the pages from search', async () => {
    const library = getLibrary()
    await library.follow({
      id: 'ytm:artist:art-nova-lane' as EntityId<'artist'>,
      source: 'ytm',
      name: 'Nova Lane',
      artwork: [],
    })
    await library.follow({
      id: 'ytm:album:alb-neon-harbor' as EntityId<'album'>,
      source: 'ytm',
      name: 'Neon Harbor',
      artists: [{ name: 'Nova Lane' }],
      artwork: [],
    })
    await library.follow({
      id: 'ytm:playlist:pl-late-night-drive' as EntityId<'playlist'>,
      source: 'ytm',
      name: 'Late Night Drive',
      artwork: [],
    })
    const { user, router } = renderCatalog('/library?tab=artists')

    await user.click(await main().findByRole('link', { name: 'Nova Lane Artist' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Nova Lane' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/artist/ytm:art-nova-lane')

    await act(() => router.navigate('/library?tab=albums'))
    await user.click(await main().findByRole('link', { name: 'Neon Harbor Nova Lane' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Neon Harbor' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/album/ytm:alb-neon-harbor')

    await act(() => router.navigate('/library'))
    await user.click(await main().findByRole('link', { name: /^Late Night Drive/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Late Night Drive' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/playlist/ytm:pl-late-night-drive')
  })

  it('plays a playlist from its big button and from a song, and pauses only its own queue', async () => {
    const { player } = setupTestPlayback()
    const id = await playlistWith('Mix', 3)
    const { user } = renderApp(playlistPath(id))
    await songs('Mix')
    const page = main()

    // Named after the list: the player bar has a Play button of its own.
    await user.click(page.getByRole('button', { name: 'Play Mix' }))

    expect(player.getState().queue.items.map((item) => item.track.title)).toEqual([
      'Song 1',
      'Song 2',
      'Song 3',
    ])
    expect(player.getState().queue.context).toEqual({ type: 'playlist', id, title: 'Mix' })
    await waitFor(() => expect(page.getByRole('button', { name: 'Pause Mix' })).toBeInTheDocument())
    await user.click(page.getByRole('button', { name: 'Pause Mix' }))
    expect(player.getState().status).toBe('paused')

    // A song plays the list from there.
    await user.click(page.getByRole('button', { name: 'Play Song 2 by Artist 2' }))
    const queue = player.getState().queue
    expect(queue.items[queue.index]?.track.title).toBe('Song 2')
  })

  it('plays a playlist in the order it shows, sorted or not', async () => {
    const { player } = setupTestPlayback()
    const id = await playlistWith('Mix', 3)
    useLibraryViewStore.getState().setTrackView(id, { key: 'title', direction: 'desc' })
    const { user } = renderApp(playlistPath(id))
    await songs('Mix')

    await user.click(main().getByRole('button', { name: 'Play Mix' }))

    expect(player.getState().queue.items.map((item) => item.track.title)).toEqual([
      'Song 3',
      'Song 2',
      'Song 1',
    ])
  })

  it('moves a link to its playlist built as for other sources to its own address', async () => {
    const { router } = renderApp(sourcePlaylistPath(LIKED_PLAYLIST_ID))
    expect(await screen.findByRole('heading', { level: 1, name: 'Liked songs' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/playlist/local:playlist:liked')
  })

  it('moves focus into a menu once it is placed, never while it is hidden', async () => {
    const id = await playlistWith('Mix', 3)
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')
    // Browsers ignore focus() on an element that is visibility: hidden: happy-dom doesn't.
    const focusedWhileHidden: string[] = []
    const focus = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      const menu = this.closest<HTMLElement>('[role="menu"]')
      if (menu && getComputedStyle(menu).visibility === 'hidden') {
        focusedWhileHidden.push(this.textContent ?? '')
      }
      focus.call(this, options)
    })

    const trigger = within(list).getByRole('button', { name: 'More options for Song 2' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menuitem', { name: 'Move to top' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    // ArrowUp on a menu button opens it on its last entry; Tab closes it and moves on.
    const sort = main().getByRole('button', { name: 'Sort: Custom order' })
    sort.focus()
    await user.keyboard('{ArrowUp}')
    expect(await screen.findByRole('menuitemradio', { name: 'Duration' })).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(focusedWhileHidden).toEqual([])
  })

  it('says where a song moved from its menu, for screen readers too', async () => {
    const id = await playlistWith('Mix', 4)
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')

    await user.click(within(list).getByRole('button', { name: 'More options for Song 3' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to top' }))
    expect(await screen.findByText('Moved Song 3 to position 1 of 4')).toBeInTheDocument()

    await user.click(main().getByRole('button', { name: 'Select', pressed: false }))
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 1' }))
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 2' }))
    await user.click(main().getByRole('button', { name: 'Move' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to bottom' }))
    expect(await screen.findByText('Moved 2 songs to the bottom')).toBeInTheDocument()
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 3', 'Song 4', 'Song 1', 'Song 2']))
  })

  it('keeps focus in the list when songs are removed', async () => {
    const id = await playlistWith('Mix', 4)
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')
    const menuOf = (name: string) =>
      within(list).getByRole('button', { name: `More options for ${name}` })

    // From a song's menu: the next song's menu button takes over.
    menuOf('Song 2').focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{End}{Enter}')
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 1', 'Song 3', 'Song 4']))
    await waitFor(() => expect(menuOf('Song 3')).toHaveFocus())

    // The last song: the one before it takes over.
    await user.click(menuOf('Song 4'))
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from this playlist' }))
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 1', 'Song 3']))
    await waitFor(() => expect(menuOf('Song 3')).toHaveFocus())

    // From the selection bar: the checkbox of the song after the first one removed.
    await user.click(main().getByRole('button', { name: 'Select', pressed: false }))
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 1' }))
    await user.click(main().getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 3']))
    await waitFor(() =>
      expect(within(list).getByRole('checkbox', { name: 'Select Song 3' })).toHaveFocus(),
    )

    // The last one: the empty playlist takes focus.
    await user.click(within(list).getByRole('checkbox', { name: 'Select Song 3' }))
    await user.click(main().getByRole('button', { name: 'Remove' }))
    const empty = await main().findByRole('heading', { name: 'This playlist is empty' })
    await waitFor(() => expect(empty.closest('[tabindex="-1"]')).toHaveFocus())
  })

  it('keeps focus in Liked songs when a song is unliked there', async () => {
    for (const n of [1, 2]) await getLibrary().like(track(n))
    const { user } = renderApp('/library?tab=liked')
    const list = await songs('Liked songs')
    await waitFor(() => expect(rowNames(list)).toEqual(['Song 2', 'Song 1']))

    await user.click(within(list).getByRole('button', { name: 'Like Song 2', pressed: true }))

    await waitFor(() => expect(rowNames(list)).toEqual(['Song 1']))
    await waitFor(() =>
      expect(within(list).getByRole('button', { name: 'Like Song 1' })).toHaveFocus(),
    )
  })

  it('gives focus to the next playlist after deleting one', async () => {
    await getLibrary().createPlaylist({ name: 'Alpha' })
    await getLibrary().createPlaylist({ name: 'Bravo' })
    const { user } = renderApp('/library')
    const list = await main().findByRole('list', { name: 'Your playlists' })
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Bravo', 'Alpha', 'Liked songs', 'Downloads']),
    )

    within(list).getByRole('button', { name: 'More options for Bravo' }).focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete playlist?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(rowNames(list)).toEqual(['Alpha', 'Liked songs', 'Downloads']))
    await waitFor(() =>
      expect(within(list).getByRole('button', { name: 'More options for Alpha' })).toHaveFocus(),
    )
  })

  it('keeps focus in the Artists tab when an artist is unfollowed', async () => {
    for (const [id, name] of [
      ['UC1', 'Band'],
      ['UC2', 'Duo'],
    ] as const) {
      await getLibrary().follow({
        id: `ytm:artist:${id}` as EntityId<'artist'>,
        source: 'ytm',
        name,
        artwork: [],
      })
    }
    const { user } = renderApp('/library?tab=artists')
    const artists = await main().findByRole('list', { name: 'Artists you follow' })

    await user.click(within(artists).getByRole('button', { name: 'More options for Duo' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Unfollow' }))
    await waitFor(() =>
      expect(within(artists).getByRole('button', { name: 'More options for Band' })).toHaveFocus(),
    )

    // The last one: the tab panel, now with the empty state, keeps focus.
    await user.click(within(artists).getByRole('button', { name: 'More options for Band' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Unfollow' }))
    expect(await main().findByRole('heading', { name: 'No artists yet' })).toBeInTheDocument()
    await waitFor(() => expect(main().getByRole('tabpanel')).toHaveFocus())
  })

  it('says where followed artists and saved albums come from while there are none', async () => {
    // The web app has no Follow or Save button: only an import of Spotify's data brings them.
    const { router } = renderApp('/library?tab=artists')
    expect(await main().findByRole('heading', { name: 'No artists yet' })).toBeInTheDocument()
    expect(
      main().getByText(
        'The artists you follow on Spotify show up here when you import your Spotify data. FXM can’t follow artists itself yet.',
      ),
    ).toBeVisible()
    expect(main().queryByText(/Follow artists you love/)).toBeNull()
    await act(() => router.navigate('/library?tab=albums'))
    expect(await main().findByRole('heading', { name: 'No albums yet' })).toBeInTheDocument()
    expect(main().getByText(/^The albums you saved on Spotify show up here/)).toBeVisible()
    expect(
      within(main().getByRole('tabpanel')).getByRole('link', { name: 'Import music' }),
    ).toHaveAttribute('href', '/import')
  })

  it('shows a saved sort as the custom order at once, without the old order in between', async () => {
    const id = await getLibrary().createPlaylist({
      name: 'Mix',
      tracks: [
        track(1, { title: 'Charlie' }),
        track(2, { title: 'alpha' }),
        track(3, { title: 'Bravo' }),
      ],
    })
    const { user } = renderApp(playlistPath(id))
    const list = await songs('Mix')
    await user.click(main().getByRole('button', { name: 'Sort: Custom order' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Title' }))
    await waitFor(() => expect(rowNames(list)).toEqual(['alpha', 'Bravo', 'Charlie']))

    // Every order the list shows from here on.
    const shown: string[][] = []
    const observer = new MutationObserver(() => {
      const current = screen.queryByRole('list', { name: 'Songs in Mix' })
      if (current) shown.push(rowNames(current))
    })
    observer.observe(main().getByRole('heading', { level: 1 }).closest('main') as HTMLElement, {
      childList: true,
      subtree: true,
    })
    await user.click(main().getByRole('button', { name: 'Save as custom order' }))
    await waitFor(async () =>
      expect(await getLibrary().getOrder(id)).toEqual([2, 3, 1].map((n) => track(n).id)),
    )
    await screen.findByText('The sorted order was saved.')
    observer.disconnect()

    expect(main().getByRole('button', { name: 'Sort: Custom order' })).toBeInTheDocument()
    expect(shown.length).toBeGreaterThan(0)
    for (const order of shown) expect(order).toEqual(['alpha', 'Bravo', 'Charlie'])
  })

  it('says when a like from the player bar could not be saved', async () => {
    const { player: appPlayer } = setupTestPlayback()
    await appPlayer.setQueue([track(7)], { autoplay: false })
    const { user } = renderApp('/library')
    const player = within(screen.getAllByRole('region', { name: 'Player' })[0] as HTMLElement)
    await waitFor(() => expect(player.getByRole('button', { name: 'Like' })).toBeEnabled())
    vi.spyOn(getLibrary(), 'toggleLike').mockRejectedValue(new Error('QuotaExceededError'))

    await user.click(player.getByRole('button', { name: 'Like' }))

    expect(
      await screen.findByText(
        'That could not be saved. The browser may be out of storage space, or blocking it.',
      ),
    ).toBeInTheDocument()
  })

  it('says so at once when the browser window has no IndexedDB at all', async () => {
    // Firefox with IndexedDB turned off, some sandboxed frames: Dexie finds none when it loads,
    // and its live queries never answer.
    const deps = Dexie.dependencies
    const indexedDB = deps.indexedDB
    deps.indexedDB = undefined as unknown as IDBFactory
    try {
      renderApp('/library')
      expect(
        await main().findByText(/Your library can.t be read in this browser window/),
      ).toBeInTheDocument()
      expect(
        await screen.findByText("Your playlists can't be shown in this browser window."),
      ).toBeInTheDocument()
    } finally {
      deps.indexedDB = indexedDB
    }
  })

  it('says so when a local playlist does not exist', async () => {
    renderApp('/playlist/local:playlist:missing')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Playlist not found' }),
    ).toBeInTheDocument()
  })
})
