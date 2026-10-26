import { formatId, type Track } from '@fxm/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { HomeServices } from '../../features/home/services'
import { createAppHomeServices } from './home'
import { RADIOHEAD_CHANNEL } from './testing/fixtures'
import { servicesOnTier, type TierServices } from './testing/tiers'

let setups: TierServices[] = []

afterEach(() => {
  for (const setup of setups) setup.dispose()
  setups = []
})

async function homeOn(
  ...args: Parameters<typeof servicesOnTier>
): Promise<{ setup: TierServices; home: HomeServices }> {
  const setup = servicesOnTier(...args)
  setups.push(setup)
  await setup.ready()
  const spotify = setup.sources.getSnapshot().providers.has('spotify')
  return { setup, home: createAppHomeServices(setup.services, { spotify }) }
}

/** Creep, from the recorded songs search, as Home's seed. */
async function creep(setup: TierServices): Promise<Track> {
  const { music } = await setup.services.youtube.load()
  const results = await music.search(
    'radiohead creep',
    { types: ['track'] },
    setup.sources.context({ mode: 'music' }),
  )
  const found = results.tracks?.items.find((track) => track.title === 'Creep')
  if (found === undefined) throw new Error('No Creep in the fixture')
  return found
}

describe("Home on the app's services", () => {
  it('finds artists and songs on YouTube Music, and an artist page’s top songs', async () => {
    const { setup, home } = await homeOn('lite')
    const ctx = setup.sources.context({ mode: 'music' })

    const artist = await home.catalog?.findArtist?.('Radiohead', ctx)
    const tracks = await home.catalog?.artistTracks?.({ name: 'Radiohead', artwork: [] }, ctx)
    const song = await home.catalog?.findSong?.(
      { title: 'Creep', artists: ['Radiohead'], durationMs: 238_000 },
      ctx,
    )

    expect(artist).toEqual({ id: `ytm:artist:${RADIOHEAD_CHANNEL}`, name: 'Radiohead' })
    expect(tracks?.map((track) => track.title)).toEqual([
      'Creep',
      'No Surprises',
      'Let Down',
      'Karma Police',
    ])
    // The matching engine's best song, a YouTube Music song that plays as itself.
    expect(song).toMatchObject({ source: 'ytm', title: 'Creep', kind: 'song' })
    // Only an artist of the very same name.
    expect(await home.catalog?.findArtist?.('Radiohead Tribute Band', ctx)).toBeNull()
  })

  it('collects YouTube Music radio and ListenBrainz in the Lite tier, without Spotify', async () => {
    const { setup, home } = await homeOn('lite')
    const ctx = setup.sources.context({ mode: 'music' })

    const collection = await home.recommendations?.collect(await creep(setup), ctx)

    const radio = collection?.candidates.filter((candidate) => candidate.source === 'ytm') ?? []
    expect(radio.length).toBeGreaterThan(0)
    expect(radio.every((candidate) => candidate.type === 'track')).toBe(true)
    const statuses = Object.fromEntries(
      (collection?.outcomes ?? []).map((outcome) => {
        const { source, part, status } = outcome as unknown as {
          source: string
          part: string
          status: string
        }
        return [`${source}/${part}`, status]
      }),
    )
    expect(statuses['ytm/radio']).toBe('ok')
    expect(statuses['listenbrainz/similar-artists']).toBe('ok')
    // Spotify isn't reachable in Lite, and Last.fm's stations need FXM Connect.
    expect(statuses['spotify/radio']).toBe('skipped')
    expect(statuses['lastfm/station']).toBe('skipped')
    expect(home.spotifyAccount).toBeUndefined()
  })

  it('follows the Spotify switch in the Full tier', async () => {
    const { setup, home } = await homeOn('full', {
      spotifyEnabled: false,
      userHost: () => new Response('{}', { status: 404 }),
    })
    const ctx = setup.sources.context({ mode: 'music' })

    const collection = await home.recommendations?.collect(await creep(setup), ctx, {
      parts: ['radio'],
    })

    const spotify = (collection?.outcomes ?? []).find(
      (outcome) => (outcome as unknown as { source: string }).source === 'spotify',
    ) as unknown as { status: string; reason?: string } | undefined
    expect(spotify).toMatchObject({ status: 'skipped', reason: 'switched-off' })
    // Spotify is registered here (its secret is reachable), so its account can be asked.
    expect(home.spotifyAccount).toBeDefined()
    // Its code isn't even downloaded while it is switched off.
    expect(setup.services.spotify.current).toBeUndefined()
  })

  it('recommends nothing new in the Free tier: YouTube Music is out of reach', async () => {
    const { setup, home } = await homeOn('free')
    const ctx = setup.sources.context({ mode: 'music' })
    const seed: Track = {
      id: formatId('archive', 'track', 'nineinchnails_ghosts_I_IV/01.flac'),
      source: 'archive',
      title: 'Ghosts I',
      artists: [{ name: 'Nine Inch Nails' }],
      artwork: [],
      kind: 'song',
    }

    const collection = await home.recommendations?.collect(seed, ctx, { parts: ['radio'] })

    expect(collection?.candidates).toEqual([])
    expect(setup.network.players).toEqual([])
    expect(
      setup.network.requests.some((request) =>
        new URL(request.url).hostname.endsWith('youtube.com'),
      ),
    ).toBe(false)
  })
})
