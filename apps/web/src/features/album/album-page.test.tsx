import { currentQueueItem, FxmError } from '@fxm/core'
import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver } from '@fxm/player/testing'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playbackFromPlayer } from '../search/actions'
import { ONBOARDING_URL } from '../search/onboarding'
import { TIER_CAPABILITIES } from '../search/sources'
import { renderCatalog, resetCatalogState } from '../search/testing'
import { useSettingsStore } from '../settings/settings-store'

// The page is a lazy chunk and the machine running the tests may be busy.
const SLOW = { timeout: 5000 }
const NEON_HARBOR = '/album/ytm:alb-neon-harbor'

afterEach(() => resetCatalogState())

function findTitle(name: string | RegExp) {
  return screen.findByRole('heading', { level: 1, name }, SLOW)
}

async function openMoreMenu(user: ReturnType<typeof renderCatalog>['user'], name: string) {
  await user.click(screen.getByRole('button', { name: `More options for ${name}` }))
  return screen.findByRole('menu')
}

/** What the live regions on the page say: the toast, and the sidebar's drag announcements. */
function statusTexts(): string[] {
  return screen.queryAllByRole('status').map((element) => element.textContent ?? '')
}

describe('Album page', () => {
  it('shows the album with its badges, byline and numbered tracks', async () => {
    renderCatalog(NEON_HARBOR)
    expect(await findTitle('Neon Harbor')).toBeInTheDocument()
    expect(document.title).toBe('Neon Harbor · FXM')
    expect(screen.getAllByText('Album')[0]).toBeInTheDocument()
    expect(screen.getAllByText('YouTube Music').length).toBeGreaterThan(1)
    expect(screen.getAllByRole('link', { name: 'Nova Lane' })[0]).toHaveAttribute(
      'href',
      '/artist/ytm:art-nova-lane',
    )
    expect(screen.getByText('2021')).toBeInTheDocument()
    expect(screen.getByText(/^10 songs, \d+ min$/)).toBeInTheDocument()

    const tracks = screen.getByRole('list', { name: 'Tracks' })
    const rows = within(tracks).getAllByRole('listitem')
    expect(rows).toHaveLength(10)
    expect(rows[0]).toHaveTextContent(/^1/)
    for (const row of rows) {
      expect(within(row).getByText('Song')).toBeInTheDocument()
      expect(within(row).getByText('YouTube Music')).toBeInTheDocument()
    }
  })

  it('plays, shuffles and plays from a track, with the album as context', async () => {
    const { user, actions } = renderCatalog(NEON_HARBOR)
    await findTitle('Neon Harbor')

    await user.click(screen.getByRole('button', { name: 'Play Neon Harbor' }))
    await user.click(screen.getByRole('button', { name: 'Shuffle Neon Harbor' }))
    await user.click(screen.getByRole('button', { name: 'Play Night Ferry by Nova Lane' }))

    const context = { type: 'album', id: 'ytm:album:alb-neon-harbor', title: 'Neon Harbor' }
    expect(actions.log).toMatchObject([
      { action: 'play', options: { shuffle: false, context } },
      { action: 'play', options: { shuffle: true, context } },
      { action: 'play', options: { startIndex: 5, context } },
    ])
    expect(actions.log[0]?.action === 'play' && actions.log[0].tracks).toHaveLength(10)
  })

  it('plays in order after a shuffle, on the real player', async () => {
    // The player keeps its shuffle setting for a new queue unless told otherwise.
    const player = new Player({
      engine: new FakeEngine(),
      resolver: new FakeResolver(),
      preload: false,
    })
    try {
      const { user } = renderCatalog(NEON_HARBOR, {
        actions: { playback: playbackFromPlayer(player) },
      })
      await findTitle('Neon Harbor')

      await user.click(screen.getByRole('button', { name: 'Shuffle Neon Harbor' }))
      await vi.waitFor(() => expect(player.getState().queue.shuffle).toBe(true))
      await user.click(screen.getByRole('button', { name: 'Play Neon Harbor' }))

      await vi.waitFor(() => expect(player.getState().queue.shuffle).toBe(false))
      expect(currentQueueItem(player.getState().queue)?.track.title).toBe('Harbor Lights')
    } finally {
      player.destroy()
    }
  })

  it('queues the album and adds it to a playlist', async () => {
    const { user, actions } = renderCatalog(NEON_HARBOR)
    await findTitle('Neon Harbor')

    let menu = await openMoreMenu(user, 'Neon Harbor')
    await user.click(within(menu).getByRole('menuitem', { name: 'Play next' }))
    expect(statusTexts()).toContain('10 songs play next')

    menu = await openMoreMenu(user, 'Neon Harbor')
    await user.click(within(menu).getByRole('menuitem', { name: 'Add to queue' }))
    expect(statusTexts()).toContain('Added 10 songs to the queue')

    menu = await openMoreMenu(user, 'Neon Harbor')
    await user.click(within(menu).getByRole('menuitem', { name: 'Add to playlist…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add to playlist' })
    expect(dialog).toHaveTextContent('10 songs from Neon Harbor')
    await user.click(await within(dialog).findByRole('button', { name: /^Workout/ }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(statusTexts()).toContain('Added 10 songs to Workout')
    expect(actions.log.map((entry) => entry.action)).toEqual([
      'playNext',
      'addToQueue',
      'addToPlaylist',
    ])
    expect(actions.log[2]).toMatchObject({ playlistId: 'workout' })
  })

  it('creates a playlist from the album', async () => {
    const { user, actions } = renderCatalog(NEON_HARBOR)
    await findTitle('Neon Harbor')
    const menu = await openMoreMenu(user, 'Neon Harbor')
    await user.click(within(menu).getByRole('menuitem', { name: 'Add to playlist…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add to playlist' })

    await user.type(within(dialog).getByRole('textbox', { name: 'New playlist' }), 'Harbor nights')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(actions.log).toMatchObject([{ action: 'createPlaylist', name: 'Harbor nights' }])
    expect(statusTexts()).toContain('Created Harbor nights with 10 songs')
  })

  it('closes the add-to-playlist dialog with the page that opened it', async () => {
    const { user, router } = renderCatalog('/search?q=neon harbor')
    await act(() => router.navigate(NEON_HARBOR))
    await findTitle('Neon Harbor')
    let menu = await openMoreMenu(user, 'Neon Harbor')
    await user.click(within(menu).getByRole('menuitem', { name: 'Add to playlist…' }))
    await screen.findByRole('dialog', { name: 'Add to playlist' })

    // Back removes the page, and the dialog with it, without a close event.
    await act(() => router.navigate(-1))
    expect(
      await screen.findByRole('heading', { name: 'Results for “neon harbor”' }, SLOW),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(() => router.navigate(1))
    expect(await findTitle('Neon Harbor')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // So does a mode switch that swaps the page for its placeholder while the album loads.
    menu = await openMoreMenu(user, 'Neon Harbor')
    await user.click(within(menu).getByRole('menuitem', { name: 'Add to playlist…' }))
    await screen.findByRole('dialog', { name: 'Add to playlist' })
    act(() => useSettingsStore.getState().setCatalogMode('all'))
    expect(await findTitle('Neon Harbor')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers downloads in the full tier but not in Lite', async () => {
    const full = renderCatalog(NEON_HARBOR, { tier: 'full' })
    await findTitle('Neon Harbor')
    expect(screen.queryByText(/Lite mode, experimental/)).not.toBeInTheDocument()
    let menu = await openMoreMenu(full.user, 'Neon Harbor')
    await full.user.click(within(menu).getByRole('menuitem', { name: 'Download' }))
    expect(full.actions.log).toMatchObject([{ action: 'download' }])
    full.unmount()

    const lite = renderCatalog(NEON_HARBOR, { tier: 'lite' })
    await findTitle('Neon Harbor')
    // The page says why the menus have no download and no equalizer.
    expect(screen.getByText(/Lite mode, experimental/)).toBeInTheDocument()
    menu = await openMoreMenu(lite.user, 'Neon Harbor')
    expect(within(menu).queryByRole('menuitem', { name: 'Download' })).not.toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Go to artist' })).toHaveAttribute(
      'href',
      '/artist/ytm:art-nova-lane',
    )
  })

  it('shows the onboarding entry point without YouTube, and the album once it is reachable', async () => {
    const { ytm, platform } = renderCatalog(NEON_HARBOR, { tier: 'free' })
    expect(await findTitle('This album is on YouTube Music')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get FXM Connect/ })).toHaveAttribute(
      'href',
      ONBOARDING_URL,
    )
    expect(ytm.calls).toEqual([])

    act(() => platform.setCapabilities(TIER_CAPABILITIES.lite))

    expect(await findTitle('Neon Harbor')).toBeInTheDocument()
  })

  it('opens Spotify albums only while Spotify is switched on and reachable', async () => {
    const path = '/album/spotify:alb-owl-hours'
    const off = renderCatalog(path, { tier: 'full', spotifyEnabled: false })
    expect(await findTitle('This album is on Spotify')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings')
    expect(off.spotify.calls).toEqual([])

    act(() => off.sources.setSpotifyEnabled(true))
    expect(await findTitle('Owl Hours')).toBeInTheDocument()
    expect(screen.getAllByText('Spotify').length).toBeGreaterThan(1)
    off.unmount()

    renderCatalog(path, { tier: 'lite', spotifyEnabled: true })
    expect(await findTitle('This album is on Spotify')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get FXM Connect/ })).toBeInTheDocument()
  })

  it('says when an album does not exist, or the link is malformed', async () => {
    const missing = renderCatalog('/album/ytm:alb-nope')
    expect(await findTitle('Album not found')).toBeInTheDocument()
    missing.unmount()

    renderCatalog('/album/MPREb_123')
    expect(await findTitle('Album not found')).toBeInTheDocument()
  })

  it('explains a failed load and tries again', async () => {
    const { user, ytm } = renderCatalog(NEON_HARBOR)
    ytm.fail('getAlbum', new FxmError('BotCheck', 'prove it'))
    expect(await findTitle("Couldn't load this album")).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/not a bot/)

    ytm.fail('getAlbum', undefined)
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await findTitle('Neon Harbor')).toBeInTheDocument()
  })
})
