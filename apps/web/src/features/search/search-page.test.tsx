import { FxmError } from '@fxm/core'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../settings/settings-store'
import { ONBOARDING_URL } from './onboarding'
import { searchTiming } from './search-view'
import { TIER_CAPABILITIES } from './sources'
import { renderCatalog, resetCatalogState } from './testing'

// The machine running the tests may be busy: give the app time to render and search.
const SLOW = { timeout: 5000 }

afterEach(() => resetCatalogState())

function findList(name: string) {
  return screen.findByRole('list', { name }, SLOW)
}

function rows(list: HTMLElement) {
  return within(list).getAllByRole('listitem')
}

/** Opens the "more options" menu of a row and returns the names of its items. */
async function menuItemsOf(
  user: ReturnType<typeof renderCatalog>['user'],
  label: RegExp | string,
): Promise<string[]> {
  await user.click(screen.getByRole('button', { name: label }))
  const menu = await screen.findByRole('menu')
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
}

describe('Search: tiers', () => {
  it('shows YouTube Music results with kind and source badges on every row (full)', async () => {
    renderCatalog('/search?q=harbor', { tier: 'full' })
    const songs = await findList('Songs')
    expect(rows(songs).length).toBeGreaterThan(1)
    for (const row of rows(songs)) {
      expect(within(row).getByText('Song')).toBeInTheDocument()
      expect(within(row).getByText('YouTube Music')).toBeInTheDocument()
    }
    expect(
      within(songs).getByRole('button', { name: 'Play Harbor Lights by Nova Lane' }),
    ).toBeVisible()
  })

  it('offers download and the equalizer on YouTube items in the full tier', async () => {
    const { user } = renderCatalog('/search?q=harbor lights nova', { tier: 'full' })
    await findList('Songs')
    const items = await menuItemsOf(user, 'More options for Harbor Lights')
    expect(items).toEqual(
      expect.arrayContaining([
        'Play next',
        'Add to queue',
        'Add to playlist…',
        'Download',
        'Equalizer',
      ]),
    )
  })

  it('shows YouTube results in Lite but hides download and the equalizer, and says why', async () => {
    const { user, ytm } = renderCatalog('/search?q=harbor lights nova', { tier: 'lite' })
    await findList('Songs')
    expect(ytm.calls.some((call) => call.method === 'search')).toBe(true)
    expect(screen.getByText(/Lite mode, experimental/)).toBeInTheDocument()

    const items = await menuItemsOf(user, 'More options for Harbor Lights')
    expect(items).toEqual(expect.arrayContaining(['Play next', 'Add to queue', 'Add to playlist…']))
    expect(items).not.toContain('Download')
    expect(items).not.toContain('Equalizer')
  })

  it('shows the onboarding entry point instead of empty results without YouTube', async () => {
    const { ytm } = renderCatalog('/search?q=harbor', { tier: 'free' })
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Set up YouTube Music' }, SLOW),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get FXM Connect/ })).toHaveAttribute(
      'href',
      ONBOARDING_URL,
    )
    expect(screen.queryByRole('list', { name: 'Songs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Search suggestions' })).not.toBeInTheDocument()
    expect(ytm.calls).toEqual([])
  })

  it('follows the tier when it changes, e.g. once FXM Connect is installed', async () => {
    const { platform } = renderCatalog('/search?q=harbor', { tier: 'free' })
    await screen.findByRole('heading', { name: 'Set up YouTube Music' }, SLOW)

    act(() => platform.setCapabilities(TIER_CAPABILITIES.full))

    expect(await findList('Songs')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Set up YouTube Music' })).not.toBeInTheDocument()
  })
})

describe('Search: the Spotify switch', () => {
  it('offers Spotify as a source when it is switched on and reachable', async () => {
    const { user, spotify } = renderCatalog('/search?q=harbor', { tier: 'full' })
    const sourceSwitch = await screen.findByRole('radiogroup', { name: 'Search in' }, SLOW)
    expect(
      within(sourceSwitch)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['YouTube Music', 'Spotify'])

    await user.click(within(sourceSwitch).getByRole('radio', { name: 'Spotify' }))

    const songs = await findList('Songs')
    await waitFor(
      () => expect(within(songs).getAllByText('Spotify').length).toBeGreaterThan(1),
      SLOW,
    )
    expect(within(songs).queryByText('YouTube Music')).not.toBeInTheDocument()
    expect(spotify.calls.some((call) => call.method === 'search')).toBe(true)
  })

  it('offers no Spotify while it is switched off, and falls back when it is switched off', async () => {
    const { user, sources } = renderCatalog('/search?q=harbor', { tier: 'full' })
    const sourceSwitch = await screen.findByRole('radiogroup', { name: 'Search in' }, SLOW)
    await user.click(within(sourceSwitch).getByRole('radio', { name: 'Spotify' }))
    await waitFor(() => expect(screen.getAllByText('Spotify').length).toBeGreaterThan(2), SLOW)

    act(() => sources.setSpotifyEnabled(false))

    expect(screen.queryByRole('radiogroup', { name: 'Search in' })).not.toBeInTheDocument()
    const songs = await findList('Songs')
    await waitFor(() =>
      expect(within(songs).getAllByText('YouTube Music').length).toBeGreaterThan(1),
    )
    expect(within(songs).queryByText('Spotify')).not.toBeInTheDocument()
  })

  it('starts without Spotify when the switch is off', async () => {
    const { spotify } = renderCatalog('/search?q=harbor', { tier: 'full', spotifyEnabled: false })
    await findList('Songs')
    expect(screen.queryByRole('radiogroup', { name: 'Search in' })).not.toBeInTheDocument()
    expect(spotify.calls).toEqual([])
  })

  it('offers no Spotify where it cannot be reached, even when switched on', async () => {
    renderCatalog('/search?q=harbor', { tier: 'lite', spotifyEnabled: true })
    await findList('Songs')
    expect(screen.queryByRole('radiogroup', { name: 'Search in' })).not.toBeInTheDocument()
  })

  it('is switched in Settings, which explains it', async () => {
    const { user, sources } = renderCatalog('/settings', { tier: 'full' })
    const group = await screen.findByRole('radiogroup', { name: 'Spotify' }, SLOW)
    expect(within(group).getByRole('radio', { name: 'On' })).toBeChecked()
    expect(group).toHaveAccessibleDescription(/Search and browse Spotify too/)

    await user.click(within(group).getByRole('radio', { name: 'Off' }))

    expect(sources.getSnapshot().spotifyEnabled).toBe(false)
    expect(group).toHaveAccessibleDescription("Off: FXM doesn't contact Spotify.")
  })
})

describe('Search: typing, suggestions and tabs', () => {
  it('waits for the user to stop typing before it searches', async () => {
    // Long enough that no pause between two keystrokes reaches it, even on a busy machine.
    searchTiming.resultsDelayMs = 1500
    const { user, ytm } = renderCatalog('/search', { tier: 'full' })
    await screen.findByRole('heading', { level: 1, name: 'Search' }, SLOW)
    const box = screen.getAllByRole('searchbox', { name: 'Search' })[0] as HTMLElement

    await user.type(box, 'owl hours')

    const songs = await findList('Songs')
    expect(within(songs).getByRole('button', { name: /^Play Owl Hours by/ })).toBeInTheDocument()
    const searched = ytm.calls.filter((call) => call.method === 'search').map((call) => call.query)
    expect(searched).toEqual(['owl hours'])
  })

  it('suggests completions and searches the one picked', async () => {
    const { user, router } = renderCatalog('/search?q=neon', { tier: 'full' })
    const suggestions = await screen.findByRole('navigation', { name: 'Search suggestions' }, SLOW)

    await user.click(within(suggestions).getByRole('link', { name: 'neon harbor' }))

    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get('q')).toBe('neon harbor'),
    )
    expect(router.state.historyAction).toBe('REPLACE')
    expect(
      await screen.findByRole('heading', { name: 'Results for “neon harbor”' }, SLOW),
    ).toBeInTheDocument()
  })

  it('searches the type of each tab, with videos only in Music + Video mode', async () => {
    const { user, ytm } = renderCatalog('/search?q=paper moons', { tier: 'full' })
    await findList('Songs')
    const tabs = screen.getByRole('tablist', { name: 'Result type' })

    await user.click(within(tabs).getByRole('tab', { name: 'Albums' }))
    const albums = await findList('Albums')
    const single = within(albums).getByRole('link', { name: 'Paper Moons' })
    expect(single).toHaveAttribute('href', '/album/ytm:alb-paper-moons')
    expect(within(rows(albums)[0] as HTMLElement).getByText('Single')).toBeInTheDocument()
    expect(ytm.calls.at(-1)).toMatchObject({ method: 'search', types: ['album'] })

    expect(within(tabs).queryByRole('tab', { name: 'Videos' })).not.toBeInTheDocument()
    act(() => useSettingsStore.getState().setCatalogMode('all'))
    await user.click(within(tabs).getByRole('tab', { name: 'Videos' }))

    const videos = await findList('Videos')
    expect(within(videos).getByText('Official video')).toBeInTheDocument()
    expect(within(videos).getByText('Video')).toBeInTheDocument()
    expect(ytm.calls.at(-1)).toMatchObject({ types: ['video'], mode: 'all' })
  })

  it('lists artists and playlists, each linking to its page', async () => {
    const { user } = renderCatalog('/search?q=late', { tier: 'full' })
    await findList('Songs')
    const tabs = screen.getByRole('tablist', { name: 'Result type' })

    await user.click(within(tabs).getByRole('tab', { name: 'Playlists' }))
    const playlists = await findList('Playlists')
    expect(within(playlists).getByRole('link', { name: 'Late Night Drive' })).toHaveAttribute(
      'href',
      '/playlist/ytm:pl-late-night-drive',
    )
    expect(within(playlists).getByText('Playlist')).toBeInTheDocument()

    await user.click(within(tabs).getByRole('tab', { name: 'Artists' }))
    expect(await screen.findByText('No artists found', undefined, SLOW)).toBeInTheDocument()
  })

  it('loads more results on demand', async () => {
    const { user } = renderCatalog('/search?q=e', { tier: 'full' })
    const songs = await findList('Songs')
    expect(rows(songs)).toHaveLength(20)

    await user.click(screen.getByRole('button', { name: 'Show more songs' }))

    await waitFor(() => expect(rows(songs)).toHaveLength(40), SLOW)
  })

  it('says when nothing matches', async () => {
    renderCatalog('/search?q=zzzz', { tier: 'full' })
    expect(await screen.findByRole('heading', { name: 'No songs found' }, SLOW)).toBeInTheDocument()
  })

  it('explains a failed search and tries again', async () => {
    const { user, ytm } = renderCatalog('/search?q=owl', { tier: 'full' })
    ytm.fail('search', new FxmError('RateLimited', 'busy', { retryAfterMs: 30_000 }))
    const alert = await screen.findByRole('alert', undefined, SLOW)
    expect(alert).toHaveTextContent(
      'Too many requests to YouTube Music for now. Try again in 30 seconds.',
    )

    ytm.fail('search', undefined)
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await findList('Songs')).toBeInTheDocument()
  })
})

describe('Search: actions', () => {
  it('plays the results from the row that was clicked', async () => {
    const { user, actions } = renderCatalog('/search?q=owl', { tier: 'full' })
    const songs = await findList('Songs')

    await user.click(
      within(songs).getByRole('button', { name: 'Play Midnight Owls by The Midnight Owls' }),
    )

    const [played] = actions.log
    expect(played).toMatchObject({
      action: 'play',
      options: { context: { type: 'search', id: 'owl', title: 'owl' } },
    })
    if (played?.action !== 'play') throw new Error('expected a play')
    expect(played.tracks[played.options.startIndex ?? 0]?.title).toBe('Midnight Owls')
  })

  it('queues a result and confirms it', async () => {
    const { user, actions } = renderCatalog('/search?q=harbor lights nova', { tier: 'full' })
    await findList('Songs')
    await menuItemsOf(user, 'More options for Harbor Lights')

    await user.click(screen.getByRole('menuitem', { name: 'Add to queue' }))

    expect(actions.log).toMatchObject([{ action: 'addToQueue' }])
    expect(screen.getByRole('status')).toHaveTextContent('Added Harbor Lights to the queue')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More options for Harbor Lights' })).toHaveFocus()
  })

  it('offers no actions that are not wired in yet', async () => {
    renderCatalog('/search?q=harbor', { tier: 'full', actions: {} })
    const songs = await findList('Songs')
    expect(within(songs).queryByRole('button', { name: /^Play / })).not.toBeInTheDocument()
    // Links to the album and artist remain, so the menu does too, without track actions.
    expect(
      within(songs).getAllByRole('button', { name: /^More options for/ }).length,
    ).toBeGreaterThan(0)
  })
})
