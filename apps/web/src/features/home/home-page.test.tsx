import type { Track } from '@fxm/core'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { GET_FXM_URL } from './home-content'
import { greetingFor } from './home-page'
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
    // Without playback, nothing offers to play.
    expect(within(onRepeat).queryByRole('button')).toBeNull()
  })

  it('welcomes a new user when there is nothing to show yet', async () => {
    renderHome(homeServices('free'))
    expect(
      await screen.findByRole('heading', { name: 'Play practically any song' }),
    ).toBeInTheDocument()
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
    expect(build).toBeDisabled()
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
    await user.click(within(reminder).getByRole('button', { name: 'Pick artists' }))
    expect(await shelfNamed('What do you like to listen to?')).toBeInTheDocument()
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
