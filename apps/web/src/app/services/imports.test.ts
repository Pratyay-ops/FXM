import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppServices } from './app-services'
import { createMemoryStore } from './device-store'
import { createAppImportServices } from './imports'
import { servicesOnTier, type TierServices } from './testing/tiers'

let setups: TierServices[] = []

afterEach(() => {
  for (const setup of setups) setup.dispose()
  setups = []
})

function setUp(...args: Parameters<typeof servicesOnTier>): TierServices {
  const setup = servicesOnTier(...args)
  setups.push(setup)
  return setup
}

describe("imports on the app's services", () => {
  it("search YouTube Music on the app's platform, at the budget's bulk priority", async () => {
    const setup = setUp('full')
    await setup.ready()
    const imports = await createAppImportServices(setup.services)

    expect(imports.matching()).toBe('ready')
    expect(imports.capabilities()).toBe(setup.services.platform?.capabilities.current)
    const ctx = imports.context('music')
    const page = await imports.youtube.fetchMatchPage(
      { kind: 'text-songs', query: 'Radiohead Creep' },
      ctx,
    )

    expect(page?.kind).toBe('text-songs')
    const tracks = page !== null && 'tracks' in page ? page.tracks : []
    expect(tracks.some((track) => track.title === 'Creep')).toBe(true)
    // Through the app's platform: the InnerTube search went to the fake YouTube.
    expect(
      setup.network.requests.some((request) => request.url.includes('/youtubei/v1/search')),
    ).toBe(true)
    // The engine's descriptions, from YouTube Music's own calls (the fixtures have none).
    const facts = await imports.youtube.fetchMatchPage({ kind: 'release-facts', trackIds: [] }, ctx)
    expect(facts).toEqual({ kind: 'release-facts', facts: {} })
  })

  it('use the one Spotify provider, which follows the switch and the tier', async () => {
    const setup = setUp('full', { userHost: () => new Response('{}', { status: 404 }) })
    await setup.ready()
    const imports = await createAppImportServices(setup.services)
    const ctx = imports.context('music')

    expect(imports.spotify?.isAvailable(ctx)).toBe(true)
    setup.sources.setSpotifyEnabled(false)
    expect(imports.spotify?.isAvailable(ctx)).toBe(false)
    // Asking costs nothing: Spotify's code isn't downloaded for it.
    expect(setup.services.spotify.current).toBeUndefined()
  })

  it('say what would find songs where YouTube Music is out of reach', async () => {
    const lite = setUp('lite')
    await lite.ready()
    const free = setUp('free')
    await free.ready()

    const inLite = await createAppImportServices(lite.services)
    const inFree = await createAppImportServices(free.services)

    expect(inLite.matching()).toBe('ready')
    expect(inLite.spotify?.isAvailable(inLite.context('music'))).toBe(false)
    expect(inFree.matching()).toBe('needs-connect')
  })

  it('use the matching config: Auto stays off in this release', async () => {
    const setup = setUp('full')
    await setup.ready()
    const imports = await createAppImportServices(setup.services)

    expect(imports.autoMatch()).toBe(false)
  })

  it("can't run when the platform could not start", async () => {
    const services = createAppServices({
      createPlatform: () => Promise.reject(new Error('No transport')),
      deviceStore: createMemoryStore(),
      offline: undefined,
      localProvider: undefined,
      updates: false,
    })
    const failure = createAppImportServices(services).catch((error: unknown) => error)

    expect(isFxmError(await failure, 'Unsupported')).toBe(true)
    services.dispose()
  })
})
