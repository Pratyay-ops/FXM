import { formatId, type Track } from '@fxm/core'
import type { LiteState } from '@fxm/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HomeServices } from '../../features/home/services'
import {
  createSources,
  createStaticPlatform,
  TIER_CAPABILITIES,
} from '../../features/search/sources'
import { spotifyAccountForHome } from '../../features/spotify-account/start'
import { createAppHomeServices, homeSourcesUntil, tierKnown } from './home'
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
    // Spotify is registered here (its secret is reachable), so its account can be asked: stage
    // 3.5's view of it, with the sections its sync keeps.
    expect(home.spotifyAccount).toBe(spotifyAccountForHome)
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

describe("Home's view of the sources", () => {
  it('says the tier is unknown until the platform is ready, then follows the registry', async () => {
    const sources = createSources()
    let ready: () => void = () => {}
    const home = homeSourcesUntil(
      sources,
      new Promise<void>((resolve) => {
        ready = resolve
      }),
    )
    const listener = vi.fn()
    home.subscribe(listener)

    // Free-only capabilities, but not yet known to be the tier: Home waits.
    const unknown = home.getSnapshot()
    expect(unknown).toMatchObject({ capabilities: sources.getSnapshot().capabilities })
    expect(unknown.detecting).toBe(true)
    // The same object until something changes, as useSyncExternalStore needs.
    expect(home.getSnapshot()).toBe(unknown)
    sources.setSpotifyEnabled(false)
    expect(listener).toHaveBeenCalledOnce()
    expect(home.getSnapshot()).toMatchObject({ spotifyEnabled: false, detecting: true })

    ready()
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
    expect(home.getSnapshot()).toBe(sources.getSnapshot())
    // FXM Connect waking up later: the registry's own `detecting`.
    sources.setDetecting(true)
    expect(home.getSnapshot().detecting).toBe(true)
    expect(home.context({ mode: 'music' }).capabilities).toEqual(sources.getSnapshot().capabilities)
  })

  it('knows the tier also when the platform could not start', async () => {
    const home = homeSourcesUntil(createSources(), Promise.reject(new Error('No platform')))
    await vi.waitFor(() => expect(home.getSnapshot().detecting).not.toBe(true))
  })
})

describe('when Home knows the tier', () => {
  /** A Lite tier whose self-test the test ends. */
  function fakeLite(initial: LiteState = 'checking') {
    let state = initial
    const listeners = new Set<(state: LiteState) => void>()
    const lite = {
      get state() {
        return state
      },
      subscribe(listener: (next: LiteState) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    return {
      platform: { lite } as never,
      set(next: LiteState) {
        state = next
        for (const listener of [...listeners]) listener(next)
      },
    }
  }

  /** Whether `promise` has settled, after the microtasks queued so far. */
  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false
    void promise.then(() => {
      done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    return done
  }

  it('waits for the first Lite self-test, and for the registry to follow a pass', async () => {
    const platform = createStaticPlatform()
    const sources = createSources({ platform })
    const lite = fakeLite()
    const known = tierKnown(Promise.resolve(lite.platform), sources)

    expect(await settled(known)).toBe(false)
    // It passed: Home waits for the capabilities, a moment later.
    lite.set('passed')
    expect(await settled(known)).toBe(false)
    platform.setCapabilities(TIER_CAPABILITIES.lite)
    expect(await settled(known)).toBe(true)
  })

  it('knows at once where Lite was refused, or YouTube is reachable without it', async () => {
    const refused = fakeLite()
    const known = tierKnown(Promise.resolve(refused.platform), createSources())
    refused.set('refused')
    expect(await settled(known)).toBe(true)

    // FXM Connect answered while the self-test still ran.
    const platform = createStaticPlatform()
    const sources = createSources({ platform })
    const withConnect = tierKnown(Promise.resolve(fakeLite().platform), sources)
    platform.setCapabilities(TIER_CAPABILITIES.full)
    expect(await settled(withConnect)).toBe(true)
  })

  it('knows at once without a Lite tier, or a platform', async () => {
    expect(await settled(tierKnown(Promise.resolve({ lite: undefined }), createSources()))).toBe(
      true,
    )
    expect(await settled(tierKnown(Promise.resolve(undefined), createSources()))).toBe(true)
    expect(
      await settled(tierKnown(Promise.reject(new Error('No platform')), createSources())),
    ).toBe(true)
  })

  it('waits for a slow self-test only so long', async () => {
    const known = tierKnown(Promise.resolve(fakeLite().platform), createSources(), 20)
    expect(await settled(known)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await settled(known)).toBe(true)
  })
})
