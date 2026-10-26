import {
  type Fetch,
  FxmError,
  formatId,
  type MetadataProvider,
  type SearchResults,
  type Track,
} from '@fxm/core'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../settings/settings-store'
import { createFakeCatalog } from './fake-catalog'
import { FEEDBACK_MS } from './feedback'
import { ONBOARDING_URL } from './onboarding'
import { searchTiming } from './search-view'
import { createStaticPlatform, TIER_CAPABILITIES } from './sources'
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

/** What the live regions on the page say: results status, confirmations. */
function statusTexts(): string[] {
  return screen.queryAllByRole('status').map((element) => element.textContent ?? '')
}

/** The labels of the "Search in" choices, in order. */
function sourceChoices(group: HTMLElement): string[] {
  return within(group)
    .getAllByRole('radio')
    .map((radio) => radio.closest('label')?.textContent ?? '')
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
    expect(screen.queryByText(/Lite tier, experimental/)).not.toBeInTheDocument()
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
    expect(screen.getByText(/Lite tier, experimental/)).toBeInTheDocument()

    const items = await menuItemsOf(user, 'More options for Harbor Lights')
    expect(items).toEqual(expect.arrayContaining(['Play next', 'Add to queue', 'Add to playlist…']))
    expect(items).not.toContain('Download')
    expect(items).not.toContain('Equalizer')
  })

  it('shows the onboarding entry point instead of results and tabs without YouTube', async () => {
    const { ytm } = renderCatalog('/search?q=harbor', { tier: 'free' })
    expect(
      await screen.findByRole(
        'heading',
        { level: 2, name: 'Search needs YouTube Music access' },
        SLOW,
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get FXM Connect/ })).toHaveAttribute(
      'href',
      ONBOARDING_URL,
    )
    // Every tab would say the same: there are none, and no heading for results either.
    expect(screen.queryByRole('tablist', { name: 'Result type' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Results for/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Search suggestions' })).not.toBeInTheDocument()
    expect(ytm.calls).toEqual([])
  })

  it('says how to reach YouTube Music on the empty search page without it', async () => {
    const free = renderCatalog('/search', { tier: 'free' })
    expect(
      await screen.findByRole(
        'heading',
        { level: 2, name: 'Search needs YouTube Music access' },
        SLOW,
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get FXM Connect/ })).toHaveAttribute(
      'href',
      ONBOARDING_URL,
    )
    expect(screen.getByRole('heading', { name: 'Browse all' })).toBeInTheDocument()
    free.unmount()

    renderCatalog('/search', { tier: 'lite' })
    expect(await screen.findByRole('heading', { name: 'Browse all' }, SLOW)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Search needs/ })).not.toBeInTheDocument()
  })

  it('follows the tier when it changes, e.g. once FXM Connect is installed', async () => {
    const { platform } = renderCatalog('/search?q=harbor', { tier: 'free' })
    await screen.findByRole('heading', { name: 'Search needs YouTube Music access' }, SLOW)

    act(() => platform.setCapabilities(TIER_CAPABILITIES.full))

    expect(await findList('Songs')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Search needs YouTube Music access' }),
    ).not.toBeInTheDocument()
  })

  it('offers the free sources in every tier, with download even without FXM Connect', async () => {
    const { user } = renderCatalog('/search?q=harbor lights nova', {
      tier: 'free',
      freeSources: true,
    })
    const sourceSwitch = await screen.findByRole('radiogroup', { name: 'Search in' }, SLOW)
    expect(sourceChoices(sourceSwitch)).toEqual(['YouTube Music', 'Internet Archive', 'Jamendo'])
    expect(await screen.findByRole('heading', { name: /^Search needs/ })).toBeInTheDocument()

    await user.click(within(sourceSwitch).getByRole('radio', { name: 'Internet Archive' }))

    const songs = await findList('Songs')
    expect(within(rows(songs)[0] as HTMLElement).getByText('Internet Archive')).toBeInTheDocument()
    const items = await menuItemsOf(user, 'More options for Harbor Lights')
    expect(items).toContain('Download')
  })

  it('searches again through a new platform, even one with the same capabilities', async () => {
    // A provider that needs the network, as the free sources do. The stand-in platform, there
    // until stage 1.2's is set, refuses every request.
    const track: Track = {
      id: formatId('archive', 'track', 'harbor-tape'),
      source: 'archive',
      title: 'Harbor Tape',
      artists: [{ name: 'Field Recordings' }],
      artwork: [],
      kind: 'song',
    }
    const archive: MetadataProvider = {
      id: 'archive',
      async search(query, _options, ctx): Promise<SearchResults> {
        await ctx.fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}`)
        return { tracks: { items: [track] } }
      },
      getTrack: () => Promise.reject(new FxmError('NotFound', 'stub')),
      getAlbum: () => Promise.reject(new FxmError('NotFound', 'stub')),
      getArtist: () => Promise.reject(new FxmError('NotFound', 'stub')),
      getPlaylist: () => Promise.reject(new FxmError('NotFound', 'stub')),
    }
    const { user, sources } = renderCatalog('/search?q=harbor', { tier: 'free' })
    act(() => {
      sources.register(archive)
    })
    const sourceSwitch = await screen.findByRole('radiogroup', { name: 'Search in' }, SLOW)
    await user.click(within(sourceSwitch).getByRole('radio', { name: 'Internet Archive' }))
    const alert = await screen.findByRole('alert', undefined, SLOW)
    expect(alert).toHaveTextContent("FXM can't reach Internet Archive here.")
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument()

    const fetch = vi.fn(async () => new Response('{}')) as unknown as Fetch
    act(() => sources.setPlatform(createStaticPlatform(TIER_CAPABILITIES.free, fetch)))

    const songs = await findList('Songs')
    expect(within(songs).getByRole('button', { name: /^Play Harbor Tape/ })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('Search: the Spotify switch', () => {
  it('offers Spotify as a source when it is switched on and reachable', async () => {
    const { user, spotify } = renderCatalog('/search?q=harbor', { tier: 'full' })
    const sourceSwitch = await screen.findByRole('radiogroup', { name: 'Search in' }, SLOW)
    expect(sourceChoices(sourceSwitch)).toEqual(['YouTube Music', 'Spotify'])

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

  it('offers every source that can be used, however many there are', async () => {
    const { user } = renderCatalog('/search?q=harbor', { tier: 'full', freeSources: true })
    const sourceSwitch = await screen.findByRole('radiogroup', { name: 'Search in' }, SLOW)
    expect(sourceChoices(sourceSwitch)).toEqual([
      'YouTube Music',
      'Spotify',
      'Internet Archive',
      'Jamendo',
    ])

    await user.click(within(sourceSwitch).getByRole('radio', { name: 'Jamendo' }))

    expect(within(sourceSwitch).getByRole('radio', { name: 'Jamendo' })).toBeChecked()
    const songs = await findList('Songs')
    await waitFor(() => expect(within(songs).getAllByText('Jamendo').length).toBeGreaterThan(1))
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

  it('waits for the first keystroke too when the search starts on another page', async () => {
    // The top bar's search box opens /search with the first letter, which must not be searched.
    searchTiming.resultsDelayMs = 1500
    searchTiming.suggestionsDelayMs = 1500
    const { user, ytm, router } = renderCatalog('/album/ytm:alb-neon-harbor', { tier: 'full' })
    await screen.findByRole('heading', { level: 1, name: 'Neon Harbor' }, SLOW)
    const box = within(screen.getByRole('banner')).getByRole('searchbox', { name: 'Search' })

    await user.type(box, 'owl hours')

    expect(router.state.location.pathname).toBe('/search')
    const songs = await findList('Songs')
    expect(within(songs).getByRole('button', { name: /^Play Owl Hours by/ })).toBeInTheDocument()
    const typed = (method: string) =>
      ytm.calls.filter((call) => call.method === method).map((call) => call.query)
    expect(typed('search')).toEqual(['owl hours'])
    await waitFor(() => expect(typed('suggest')).toEqual(['owl hours']), SLOW)
  })

  it('dims the results while a newer query waits to be searched', async () => {
    searchTiming.resultsDelayMs = 60_000
    const { user } = renderCatalog('/search?q=owl', { tier: 'full' })
    // A query in the URL from the start is searched at once.
    const songs = await findList('Songs')
    const box = screen.getAllByRole('searchbox', { name: 'Search' })[0] as HTMLElement

    await user.type(box, ' hours')

    expect(screen.getByRole('heading', { name: 'Results for “owl hours”' })).toBeInTheDocument()
    expect(songs.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true')
    expect(statusTexts()).toContain('Searching…')
    // The results for "owl" stay until the new ones are in.
    expect(within(songs).getByRole('button', { name: /^Play Rooftop Radio/ })).toBeInTheDocument()
  })

  it('suggests completions, searches the one picked and keeps keyboard focus', async () => {
    const { user, router } = renderCatalog('/search?q=neon', { tier: 'full' })
    const suggestions = await screen.findByRole('navigation', { name: 'Search suggestions' }, SLOW)

    within(suggestions).getByRole('link', { name: 'neon harbor' }).focus()
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get('q')).toBe('neon harbor'),
    )
    expect(router.state.historyAction).toBe('REPLACE')
    // The chosen suggestion is the query now, and goes: focus moves to the results' heading.
    const heading = await screen.findByRole('heading', { name: 'Results for “neon harbor”' }, SLOW)
    expect(heading).toHaveFocus()
  })

  it('shows no suggestions for a source that has none, not even the last source’s', async () => {
    const { user, spotify } = renderCatalog('/search?q=neon', { tier: 'full' })
    await screen.findByRole('navigation', { name: 'Search suggestions' }, SLOW)
    const sourceSwitch = screen.getByRole('radiogroup', { name: 'Search in' })

    await user.click(within(sourceSwitch).getByRole('radio', { name: 'Spotify' }))

    expect(within(sourceSwitch).getByRole('radio', { name: 'Spotify' })).toBeChecked()
    expect(screen.queryByRole('navigation', { name: 'Search suggestions' })).not.toBeInTheDocument()
    const box = screen.getAllByRole('searchbox', { name: 'Search' })[0] as HTMLElement
    await user.type(box, ' h')
    expect(await findList('Songs')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Search suggestions' })).not.toBeInTheDocument()
    expect(spotify.suggest).toBeUndefined()
  })

  it('never asks a source that is called only on request for suggestions', async () => {
    // Like Jamendo, whose one shared client_id has a small monthly budget.
    const fake = createFakeCatalog('jamendo')
    const suggest = vi.fn(async () => ['neon harbor'])
    const jamendo: MetadataProvider = { ...fake, requestPolicy: 'explicit', suggest }
    const { user, sources } = renderCatalog('/search?q=neon', { tier: 'full' })
    act(() => {
      sources.register(jamendo)
    })
    const sourceSwitch = await screen.findByRole('radiogroup', { name: 'Search in' }, SLOW)
    await user.click(within(sourceSwitch).getByRole('radio', { name: 'Jamendo' }))
    const box = screen.getAllByRole('searchbox', { name: 'Search' })[0] as HTMLElement
    await user.type(box, ' h')

    // Suggestions would have been asked for by the time the search, which waits longer, runs.
    await waitFor(
      () =>
        expect(fake.calls).toContainEqual(
          expect.objectContaining({ method: 'search', query: 'neon h' }),
        ),
      SLOW,
    )
    expect(await findList('Songs')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Search suggestions' })).not.toBeInTheDocument()
    expect(suggest).not.toHaveBeenCalled()
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

  it('searches only the tab that stays selected while arrowing across the tabs', async () => {
    searchTiming.tabDelayMs = 1000
    const { user, ytm } = renderCatalog('/search?q=late', { tier: 'full' })
    await findList('Songs')
    const tabs = screen.getByRole('tablist', { name: 'Result type' })
    within(tabs).getByRole('tab', { name: 'Songs' }).focus()

    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')

    expect(within(tabs).getByRole('tab', { name: 'Playlists' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(await findList('Playlists')).toBeInTheDocument()
    const searched = ytm.calls.filter((call) => call.method === 'search').map((call) => call.types)
    expect(searched).toEqual([['track'], ['playlist']])
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
    expect(
      await screen.findByRole('heading', { name: 'No artists found' }, SLOW),
    ).toBeInTheDocument()
  })

  it('tells screen readers what the search found', async () => {
    renderCatalog('/search?q=harbor', { tier: 'full' })
    await findList('Songs')
    expect(statusTexts()).toContainEqual(expect.stringMatching(/^\d+ songs for “harbor”$/))
  })

  it('loads more results on demand, keeping keyboard users in place', async () => {
    const { user, ytm } = renderCatalog('/search?q=e', { tier: 'full' })
    const songs = await findList('Songs')
    expect(rows(songs)).toHaveLength(20)
    // Slow enough that the second press below lands while the page is still loading.
    ytm.setLatency(1000)
    screen.getByRole('button', { name: 'Show more songs' }).focus()

    await user.keyboard('{Enter}')

    // While the page loads, the button keeps focus: a disabled one would drop it to the page.
    const loading = screen.getByRole('button', { name: 'Loading…' })
    expect(loading).toHaveAttribute('aria-disabled', 'true')
    expect(loading).toHaveFocus()
    await user.click(loading)
    await waitFor(() => expect(rows(songs)).toHaveLength(40), SLOW)
    // Then focus goes on with the first new row, and screen readers hear what arrived.
    const firstNew = within(rows(songs)[20] as HTMLElement).getAllByRole('button')[0]
    await waitFor(() => expect(firstNew).toHaveFocus())
    expect(statusTexts()).toContain('20 more songs loaded, 40 in all')
    expect(ytm.calls.filter((call) => call.cursor !== undefined)).toHaveLength(1)
  })

  it('says when nothing matches', async () => {
    renderCatalog('/search?q=zzzz', { tier: 'full' })
    expect(await screen.findByRole('heading', { name: 'No songs found' }, SLOW)).toBeInTheDocument()
    expect(statusTexts()).toContain('No songs found')
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
      options: { context: { type: 'search', query: 'owl', title: 'owl' } },
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
    expect(statusTexts()).toContain('Added Harbor Lights to the queue')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More options for Harbor Lights' })).toHaveFocus()
  })

  it('keeps a confirmation for its own time only, also across pages', async () => {
    const { user, router } = renderCatalog('/search?q=harbor lights nova', { tier: 'full' })
    await findList('Songs')
    await menuItemsOf(user, 'More options for Harbor Lights')
    await user.click(screen.getByRole('menuitem', { name: 'Add to queue' }))
    const confirmation = 'Added Harbor Lights to the queue'

    // Still in its time on the next page.
    await act(() => router.navigate('/album/ytm:alb-neon-harbor'))
    await screen.findByRole('heading', { level: 1, name: 'Neon Harbor' }, SLOW)
    expect(statusTexts()).toContain(confirmation)

    // Over by the time the user comes back from a page without confirmations.
    await act(() => router.navigate('/library'))
    await screen.findByRole('heading', { level: 1, name: 'Your library' }, SLOW)
    const later = Date.now() + FEEDBACK_MS + 1000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await act(() => router.navigate(-1))
    await screen.findByRole('heading', { level: 1, name: 'Neon Harbor' }, SLOW)
    expect(statusTexts()).not.toContain(confirmation)
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
