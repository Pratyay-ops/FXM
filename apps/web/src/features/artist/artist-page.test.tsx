import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TIER_CAPABILITIES } from '../search/sources'
import { renderCatalog, resetCatalogState } from '../search/testing'

// The page is a lazy chunk and the machine running the tests may be busy.
const SLOW = { timeout: 5000 }

afterEach(() => resetCatalogState())

function findTitle(name: string) {
  return screen.findByRole('heading', { level: 1, name }, SLOW)
}

describe('Artist page', () => {
  it('shows popular songs, releases, similar artists and the biography', async () => {
    const { user } = renderCatalog('/artist/ytm:art-nova-lane')
    expect(await findTitle('Nova Lane')).toBeInTheDocument()
    expect(screen.getAllByText('Artist')[0]).toBeInTheDocument()

    const popular = screen.getByRole('list', { name: 'Popular songs' })
    expect(within(popular).getAllByRole('listitem')).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: 'Show more' }))
    expect(within(popular).getAllByRole('listitem')).toHaveLength(10)
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    const releases = screen.getByRole('list', { name: 'Albums and singles' })
    expect(within(releases).getByRole('link', { name: /Glass Weather/ })).toHaveAttribute(
      'href',
      '/album/ytm:alb-glass-weather',
    )
    expect(within(releases).getByText('EP · 2019')).toBeInTheDocument()

    const similar = screen.getByRole('list', { name: 'Similar artists' })
    expect(within(similar).getByRole('link', { name: /The Midnight Owls/ })).toHaveAttribute(
      'href',
      '/artist/ytm:art-midnight-owls',
    )
    expect(screen.getByText(/written on night ferries/)).toBeInTheDocument()
  })

  it('loads similar artists separately where the source lists them apart (Spotify)', async () => {
    const { spotify } = renderCatalog('/artist/spotify:art-nova-lane')
    await findTitle('Nova Lane')
    const similar = await screen.findByRole('list', { name: 'Similar artists' }, SLOW)
    expect(within(similar).getByRole('link', { name: /Aurora Fields/ })).toBeInTheDocument()
    expect(spotify.calls.map((call) => call.method)).toEqual(['getArtist', 'getRelatedArtists'])
  })

  it('plays the popular songs with the artist as context', async () => {
    const { user, actions } = renderCatalog('/artist/ytm:art-midnight-owls')
    await findTitle('The Midnight Owls')

    await user.click(screen.getByRole('button', { name: 'Play The Midnight Owls' }))

    expect(actions.log).toMatchObject([
      {
        action: 'play',
        options: { context: { type: 'artist', id: 'ytm:artist:art-midnight-owls' } },
      },
    ])
  })

  it('shows the onboarding entry point without YouTube, until it is reachable', async () => {
    const { platform } = renderCatalog('/artist/ytm:art-nova-lane', { tier: 'free' })
    expect(await findTitle('This artist is on YouTube Music')).toBeInTheDocument()

    act(() => platform.setCapabilities(TIER_CAPABILITIES.full))

    expect(await findTitle('Nova Lane')).toBeInTheDocument()
  })

  it('says when an artist does not exist', async () => {
    renderCatalog('/artist/ytm:art-nobody')
    expect(await findTitle('Artist not found')).toBeInTheDocument()
  })
})
