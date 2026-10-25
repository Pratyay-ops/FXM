import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderCatalog, resetCatalogState } from '../search/testing'
import { useSettingsStore } from '../settings/settings-store'

// The page is a lazy chunk and the machine running the tests may be busy.
const SLOW = { timeout: 5000 }

afterEach(() => resetCatalogState())

function findTitle(name: string) {
  return screen.findByRole('heading', { level: 1, name }, SLOW)
}

function tracks() {
  return within(screen.getByRole('list', { name: 'Tracks' })).getAllByRole('listitem')
}

describe('Playlist page', () => {
  it('shows the playlist and loads its tracks a page at a time', async () => {
    const { user, ytm } = renderCatalog('/playlist/ytm:pl-indie-sunrise')
    expect(await findTitle('Indie Sunrise')).toBeInTheDocument()
    expect(screen.getByText('FXM Picks')).toBeInTheDocument()
    expect(screen.getByText('120 songs')).toBeInTheDocument()
    expect(tracks()).toHaveLength(50)
    screen.getByRole('button', { name: 'Show more tracks' }).focus()

    await user.keyboard('{Enter}')

    await waitFor(() => expect(tracks()).toHaveLength(120), SLOW)
    expect(screen.queryByRole('button', { name: 'Show more tracks' })).not.toBeInTheDocument()
    expect(ytm.calls.map((call) => call.method)).toEqual(['getPlaylist', 'getPlaylistTracks'])
    // The button went with the last page: focus goes on with the first new track instead of
    // falling back to the start of the page, and screen readers hear what arrived.
    const firstNew = within(tracks()[50] as HTMLElement).getAllByRole('button')[0]
    await waitFor(() => expect(firstNew).toHaveFocus())
    expect(screen.getByText('70 more tracks loaded, 120 in all')).toHaveAttribute('role', 'status')
  })

  it('hides plain videos in Music mode, says so, and shows them in Music + Video', async () => {
    const { user } = renderCatalog('/playlist/ytm:pl-late-night-drive')
    await findTitle('Late Night Drive')
    const kinds = () =>
      tracks().map(
        (row) => within(row).getAllByText(/^(Song|Official video|Video)$/)[0]?.textContent,
      )
    expect(kinds()).not.toContain('Video')
    expect(kinds()).toContain('Official video')
    // The playlist holds 8, and Music mode shows 7: the page counts both and says why.
    expect(tracks()).toHaveLength(7)
    expect(screen.getByText('7 of 8 songs')).toBeInTheDocument()
    expect(screen.getByText(/^1 track hidden in Music mode\./)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Switch to Music + Video' }))

    expect(useSettingsStore.getState().catalogMode).toBe('all')
    await waitFor(() => expect(kinds()).toContain('Video'), SLOW)
    expect(screen.getByText('8 songs')).toBeInTheDocument()
    expect(screen.queryByText(/hidden in Music mode/)).not.toBeInTheDocument()
  })

  it('plays from the track that was clicked, with the playlist as context', async () => {
    const { user, actions } = renderCatalog('/playlist/ytm:pl-study-hours')
    await findTitle('Lo-fi Study Hours')

    await user.click(screen.getByRole('button', { name: 'Play Cocoa by Lo-Fi Study Club' }))

    expect(actions.log).toMatchObject([
      {
        action: 'play',
        options: {
          startIndex: 3,
          context: {
            type: 'playlist',
            id: 'ytm:playlist:pl-study-hours',
            title: 'Lo-fi Study Hours',
          },
        },
      },
    ])
  })

  it('keeps the placeholder for the library playlists in the sidebar', async () => {
    renderCatalog('/playlist/liked')
    expect(await findTitle('Playlist liked')).toBeInTheDocument()
  })

  it.each(['/playlist/ytm:', '/playlist/foo:bar', '/playlist/plugin.:x', '/playlist/ytm:pl-nope'])(
    'says when a playlist link leads nowhere: %s',
    async (path) => {
      renderCatalog(path)
      expect(await findTitle('Playlist not found')).toBeInTheDocument()
    },
  )

  it('opens Spotify playlists only while Spotify is switched on', async () => {
    renderCatalog('/playlist/spotify:pl-study-hours', { spotifyEnabled: false })
    expect(await findTitle('This playlist is on Spotify')).toBeInTheDocument()
  })
})
