import type { Track } from '@fxm/core'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { GET_FXM_URL } from './home-content'
import { greetingFor } from './home-page'
import type { HomeRecommendations, HomeSourceShelf } from './services'
import { useTasteStore } from './taste-store'
import {
  fakePlayback,
  fakeRecommendations,
  fakeSpotifyAccount,
  homeServices,
  renderHome,
  resetTaste,
  song,
  variedSongs,
  ytmArtist,
} from './testing'

afterEach(resetTaste)

const DAY = 24 * 60 * 60 * 1000

const favourites: Track[] = [
  song('a1', 'Copper Sun', 'Aurora Lane'),
  song('a2', 'Glass River', 'Aurora Lane'),
  song('b1', 'Static Bloom', 'Basalt'),
  song('c1', 'Harbor Lights', 'Cinder'),
]

/** Plays every favourite on three days this week. */
async function listen() {
  const now = Date.now()
  await getLibrary().recordPlays(
    favourites.flatMap((track, index) =>
      [1, 2, 3].map((days) => ({
        track,
        playedAt: now - (days + index / 10) * DAY,
        playedMs: 200_000,
        completed: true,
        skipped: false,
      })),
    ),
  )
}

const shelfNamed = (name: string) => screen.findByRole('region', { name })

describe('the greeting', () => {
  it('says good morning, afternoon or evening', () => {
    expect(greetingFor(8)).toBe('Good morning')
    expect(greetingFor(13)).toBe('Good afternoon')
    expect(greetingFor(21)).toBe('Good evening')
    expect(greetingFor(3)).toBe('Good evening')
  })
})

describe('Home', () => {
  it('shows what the user plays, and how to get recommendations, in the Free-only tier', async () => {
    await listen()
    renderHome(homeServices('free'))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /^Good (morning|afternoon|evening)$/,
    )
    const onRepeat = await shelfNamed('On repeat')
    expect(within(onRepeat).getAllByRole('listitem')).toHaveLength(4)
    expect(within(onRepeat).getByText('Copper Sun')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Recommendations need YouTube Music' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get FXM Connect/ })).toHaveAttribute(
      'href',
      GET_FXM_URL,
    )
    expect(screen.queryByRole('heading', { name: 'What do you like to listen to?' })).toBeNull()
    // The user's own music comes first, the note after it.
    const note = screen.getByRole('region', { name: 'Recommendations need YouTube Music' })
    expect(onRepeat.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Without playback, nothing offers to play, and a row takes focus itself, so the keyboard
    // can scroll it.
    expect(within(onRepeat).queryByRole('button')).toBeNull()
    expect(within(onRepeat).getByRole('list')).toHaveAttribute('tabindex', '0')
  })

  it('welcomes a new user when there is nothing to show yet, with one card', async () => {
    renderHome(homeServices('free'))
    const welcome = await shelfNamed('Play practically any song')
    // In the Free-only tier, it says how to get the catalog instead of promising it.
    expect(within(welcome).getByRole('link', { name: /Get FXM Connect/ })).toHaveAttribute(
      'href',
      GET_FXM_URL,
    )
    expect(within(welcome).getByRole('link', { name: 'Search music' })).toBeInTheDocument()
    expect(welcome).not.toHaveTextContent('Clean album audio')
    expect(screen.queryByRole('region', { name: 'Recommendations need YouTube Music' })).toBeNull()
  })

  it('shows the user their own shelves at once, while the sources are still asked', async () => {
    await listen()
    const silent: HomeRecommendations = {
      collect: () => new Promise(() => {}),
      home: async () => ({ shelves: [] }),
    }
    renderHome(homeServices('lite', { recommendations: silent }))
    expect(await shelfNamed('On repeat')).toBeInTheDocument()
    expect(screen.getByText('Finding music for you…')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Quick picks' })).toBeNull()
  })

  it('asks a new user what they like, and builds Home from the picks', async () => {
    const recommendations = fakeRecommendations({
      radio: { '*': variedSongs('r', 60) },
      home: [
        {
          source: 'ytm',
          shelf: {
            id: 'popular',
            title: 'Popular artists',
            items: [
              {
                type: 'artist',
                artist: { ...ytmArtist('Halcyon', 'UCh'), source: 'ytm', artwork: [] } as never,
              },
              { type: 'track', track: song('k1', 'Signal', 'Kestrel') },
            ],
          },
        },
      ],
    })
    const { user } = renderHome(homeServices('lite', { recommendations }))
    const onboarding = await shelfNamed('What do you like to listen to?')
    const build = within(onboarding).getByRole('button', { name: 'Build my Home' })
    expect(build).toHaveAttribute('aria-disabled', 'true')
    expect(within(onboarding).getByText('Pick 3 more artists')).toBeInTheDocument()

    await user.click(
      await within(onboarding).findByRole('button', { name: 'Halcyon', pressed: false }),
    )
    await user.click(within(onboarding).getByRole('button', { name: 'Kestrel' }))
    await user.type(
      within(onboarding).getByRole('textbox', { name: 'Add an artist' }),
      'Fable Kin{Enter}',
    )
    expect(
      within(onboarding).getByRole('button', { name: 'Fable Kin', pressed: true }),
    ).toBeInTheDocument()
    await user.click(within(onboarding).getByRole('button', { name: 'Jazz' }))
    expect(within(onboarding).getByText('3 artists picked')).toBeInTheDocument()

    await user.click(build)

    expect(await shelfNamed('Quick picks')).toBeInTheDocument()
    // Focus moves from the button that went to the Home built from the picks.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Quick picks' })).toHaveFocus())
    expect(screen.queryByRole('region', { name: 'What do you like to listen to?' })).toBeNull()
    const seeds = recommendations.calls.map(({ seed }) =>
      'title' in seed ? seed.title : seed.name,
    )
    expect(seeds).toEqual(expect.arrayContaining(['Halcyon', 'Kestrel', 'Fable Kin']))
  })

  it('puts the onboarding off with "Not now", and brings it back', async () => {
    const { user } = renderHome(homeServices('lite', { recommendations: fakeRecommendations() }))
    const onboarding = await shelfNamed('What do you like to listen to?')
    await user.click(within(onboarding).getByRole('button', { name: 'Not now' }))
    const reminder = await shelfNamed('Get recommendations sooner')
    // Focus stays on the page: on what took the button's place.
    const pick = within(reminder).getByRole('button', { name: 'Pick artists' })
    expect(pick).toHaveFocus()
    // Home isn't left empty: the welcome says what to do meanwhile.
    expect(await shelfNamed('Play practically any song')).toBeInTheDocument()
    await user.click(pick)
    expect(
      await screen.findByRole('heading', { name: 'What do you like to listen to?' }),
    ).toHaveFocus()
    expect(screen.queryByRole('region', { name: 'Play practically any song' })).toBeNull()
  })

  it('lists an artist once, with the ID a suggestion gives it, whenever the suggestion comes', async () => {
    const fake = fakeRecommendations({ radio: { '*': variedSongs('r', 60) } })
    let suggest = (_answer: { shelves: readonly HomeSourceShelf[] }) => {}
    const recommendations: HomeRecommendations = {
      collect: fake.collect,
      home: () =>
        new Promise((resolve) => {
          suggest = resolve
        }),
    }
    const { user } = renderHome(homeServices('lite', { recommendations }))
    const onboarding = await shelfNamed('What do you like to listen to?')
    const field = within(onboarding).getByRole('textbox', { name: 'Add an artist' })
    // Typed while the suggestions are still on their way.
    await user.type(field, 'halcyon{Enter}')
    suggest({
      shelves: [
        {
          source: 'ytm',
          shelf: {
            id: 'popular',
            title: 'Popular artists',
            items: [
              {
                type: 'artist',
                artist: { ...ytmArtist('Halcyon', 'UCh'), source: 'ytm', artwork: [] } as never,
              },
              {
                type: 'artist',
                artist: { ...ytmArtist('Kestrel', 'UCk'), source: 'ytm', artwork: [] } as never,
              },
            ],
          },
        },
      ],
    })
    await within(onboarding).findByRole('button', { name: 'Kestrel' })
    expect(within(onboarding).getAllByRole('button', { name: /^halcyon$/i })).toHaveLength(1)
    expect(within(onboarding).getByRole('button', { name: 'Halcyon' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // Typing a suggested name picks the suggestion.
    await user.type(field, 'KESTREL{Enter}')
    expect(within(onboarding).getAllByRole('button', { name: /^kestrel$/i })).toHaveLength(1)
    await user.type(field, 'Fable Kin{Enter}')
    await user.click(within(onboarding).getByRole('button', { name: 'Build my Home' }))
    expect(useTasteStore.getState().picks?.artists).toEqual([
      { name: 'Halcyon', id: 'ytm:artist:UCh' },
      { name: 'Kestrel', id: 'ytm:artist:UCk' },
      { name: 'Fable Kin' },
    ])
  })

  it('lets the user change or clear the artists they picked', async () => {
    await listen()
    useTasteStore.getState().savePicks(
      {
        artists: [{ name: 'Halcyon' }, { name: 'Kestrel' }, { name: 'Fable Kin' }],
        genres: ['Jazz'],
      },
      Date.now(),
    )
    const { user } = renderHome(
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs('r', 60) } }),
      }),
    )
    const section = await shelfNamed('Your artists')
    expect(section).toHaveTextContent('Halcyon, Kestrel and Fable Kin, plus Jazz')
    await user.click(within(section).getByRole('button', { name: 'Change' }))
    const editor = await shelfNamed('Your artists and genres')
    expect(within(editor).getByRole('heading', { name: 'Your artists and genres' })).toHaveFocus()
    expect(within(editor).getByRole('button', { name: 'Jazz' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(within(editor).getByRole('button', { name: 'Kestrel', pressed: true }))
    await user.type(
      within(editor).getByRole('textbox', { name: 'Add an artist' }),
      'Iris Vale{Enter}',
    )
    await user.click(within(editor).getByRole('button', { name: 'Save' }))
    expect(useTasteStore.getState().picks?.artists.map((artist) => artist.name)).toEqual([
      'Halcyon',
      'Fable Kin',
      'Iris Vale',
    ])
    const saved = await shelfNamed('Your artists')
    expect(within(saved).getByRole('button', { name: 'Change' })).toHaveFocus()
    expect(saved).toHaveTextContent('Halcyon, Fable Kin and Iris Vale, plus Jazz')

    await user.click(within(saved).getByRole('button', { name: 'Clear picks' }))
    expect(useTasteStore.getState().picks).toBeUndefined()
    const cleared = await shelfNamed('Your artists')
    expect(within(cleared).getByRole('button', { name: 'Pick artists' })).toHaveFocus()
  })

  it('gives focus back to the picks saved while Home is still being built', async () => {
    await listen()
    const artists = [{ name: 'Halcyon' }, { name: 'Kestrel' }, { name: 'Fable Kin' }]
    useTasteStore.getState().savePicks({ artists, genres: [] }, Date.now())
    // The sources answer only when the test says so: until then Home shows its first pass.
    let answer = () => {}
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    const fake = fakeRecommendations({ radio: { '*': variedSongs('r', 60) } })
    const recommendations: HomeRecommendations = {
      async collect(seed, ctx, options) {
        await answered
        return fake.collect(seed, ctx, options)
      },
      home: (ctx) => fake.home(ctx),
    }
    const { user } = renderHome(homeServices('lite', { recommendations }))
    const section = await shelfNamed('Your artists')
    await user.click(within(section).getByRole('button', { name: 'Change' }))
    const editor = await shelfNamed('Your artists and genres')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))
    // Home is built again from the picks: their section comes back, and takes focus.
    const saved = await shelfNamed('Your artists')
    expect(within(saved).getByRole('button', { name: 'Change' })).toHaveFocus()

    answer()
    await shelfNamed('Discover')
    expect(
      within(await shelfNamed('Your artists')).getByRole('button', { name: 'Change' }),
    ).toHaveFocus()
  })

  it('plays a shelf from the song clicked, with where it plays from', async () => {
    await listen()
    const playback = fakePlayback()
    const { user } = renderHome(
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs('r', 80) } }),
        playback,
      }),
    )
    const picks = await shelfNamed('Quick picks')
    // Its songs take focus: the row itself doesn't.
    expect(within(picks).getByRole('list')).not.toHaveAttribute('tabindex')
    const buttons = within(picks).getAllByRole('button', { name: /^Play / })
    await user.click(buttons[2] as HTMLElement)
    expect(playback.plays[0]?.startIndex).toBe(2)
    expect(playback.plays[0]?.titles).toHaveLength(buttons.length)
    expect(playback.plays[0]?.context).toEqual({
      type: 'library',
      id: 'home:quick-picks',
      title: 'Quick picks',
    })

    await user.click(screen.getByRole('button', { name: 'Play Discover' }))
    expect(playback.plays[1]).toMatchObject({ startIndex: 0, context: { id: 'home:discover' } })

    const because = await shelfNamed('Because you listened to Copper Sun')
    await user.click(within(because).getAllByRole('button', { name: /^Play / })[0] as HTMLElement)
    expect(playback.plays[2]?.context).toEqual({
      type: 'radio',
      seed: 'ytm:track:a1',
      title: 'Because you listened to Copper Sun',
    })
  })

  it('opens a Daily Mix and plays it', async () => {
    await listen()
    const playback = fakePlayback()
    const { user } = renderHome(
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs('r', 80) } }),
        playback,
      }),
    )
    const mixes = await shelfNamed('Daily Mixes')
    await user.click(within(mixes).getByRole('button', { name: /^Daily Mix 1/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Daily Mix 1' })
    const songs = within(dialog).getByRole('list', { name: 'Songs in Daily Mix 1' })
    expect(within(songs).getAllByRole('listitem').length).toBeGreaterThanOrEqual(10)
    await user.click(within(dialog).getByRole('button', { name: 'Play Daily Mix 1' }))
    expect(playback.plays[0]).toMatchObject({
      startIndex: 0,
      context: { type: 'library', id: 'home:daily-mix-1', title: 'Daily Mix 1' },
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it("shows a connected Spotify account's own sections", async () => {
    await listen()
    renderHome(
      homeServices('full', {
        recommendations: fakeRecommendations({
          radio: { '*': variedSongs('r', 40) },
          home: [
            {
              source: 'spotify',
              shelf: {
                id: 'made-for-you',
                title: 'Made For You',
                items: [{ type: 'track', track: song('s1', 'Somewhere', 'Halcyon') }],
              },
            },
          ],
        }),
        spotifyAccount: fakeSpotifyAccount(true),
      }),
    )
    const section = await shelfNamed('Made For You')
    expect(within(section).getByText('From your Spotify account.')).toBeInTheDocument()
    expect(within(section).getByText('Somewhere')).toBeInTheDocument()
  })
})
