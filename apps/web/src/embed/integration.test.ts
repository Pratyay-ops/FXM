import { DEFAULT_QUALITY_PREFS, formatId, type ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createFakeNetwork } from '../app/services/testing/fake-network'
import { FIXTURES } from '../app/services/testing/fixtures'
import type { EmbedPlatform } from './controller'
import {
  createEmbedServices,
  embedPlatformOptions,
  embedSandboxOptions,
  liteSelfTestRequest,
} from './integration'
import { EMBED_SOURCES } from './target'
import { CAPABILITIES, createFakePlatform } from './testing/fake-platform'
import { WIRED_SOURCES } from './wired'

/** An embed platform with FXM Connect, whose requests the composition root's fake network answers. */
function platformOnFakeNetwork() {
  const network = createFakeNetwork({ fixtures: FIXTURES })
  const platform: EmbedPlatform = {
    capabilities: { current: CAPABILITIES.full, subscribe: () => () => {} },
    context: ({ mode, signal }) =>
      ({
        fetch: network.fetch,
        platform: 'web',
        capabilities: CAPABILITIES.full,
        mode,
        ...(signal === undefined ? {} : { signal }),
      }) as ProviderContext,
    dispose: () => {},
  }
  return { network, platform }
}

describe('the integration touch-points', () => {
  it('name exactly the sources the catalog loads, each with a stream source', () => {
    const services = createEmbedServices(createFakePlatform())
    for (const source of EMBED_SOURCES) {
      expect(services.catalog.supports(source), source).toBe(WIRED_SOURCES.has(source))
    }
    // Plain YouTube plays through the YouTube Music ladder (`ytm`), as the player resolves it.
    const streams = new Set(services.sources.map((stream) => stream.id))
    for (const source of WIRED_SOURCES) {
      expect(streams.has(source === 'yt' ? 'ytm' : source), source).toBe(true)
    }
    expect([...WIRED_SOURCES].sort()).toEqual(['archive', 'yt', 'ytm'])
    expect(services.matcher).toBeDefined()
  })

  it("take the Lite tier's kill switch and self-test client from the YouTube config", () => {
    const { killSwitches } = embedPlatformOptions()
    const switches = typeof killSwitches === 'function' ? killSwitches() : killSwitches?.get()
    // The config FXM ships with leaves Lite on; a signed config can switch it off (stage 1.13).
    expect(switches).toEqual({ lite: false })
    expect(embedSandboxOptions().selfTestRequest).toBe(liteSelfTestRequest)
    const request = liteSelfTestRequest()
    expect(request.url).toBe(
      'https://music.youtube.com/youtubei/v1/music/get_search_suggestions?prettyPrint=false',
    )
    expect(JSON.parse(request.init.body as string)).toMatchObject({
      context: { client: { clientName: 'WEB_REMIX' } },
    })
  })

  it('loads an Internet Archive album with its credits, and plays its files', async () => {
    const { platform } = platformOnFakeNetwork()
    const services = createEmbedServices(platform, { updates: false })
    const ctx = platform.context({ mode: 'music', priority: 'interactive' })

    const entity = await services.catalog.load(
      { kind: 'album', id: formatId('archive', 'album', 'nineinchnails_ghosts_I_IV') },
      ctx,
    )
    const [first] = entity.tracks

    expect(entity.tracks.length).toBeGreaterThan(0)
    expect(first?.source).toBe('archive')
    expect(services.catalog.attribution?.(first as never)).toMatchObject({
      provider: 'Internet Archive',
      pageUrl: expect.stringContaining('archive.org/details/nineinchnails_ghosts_I_IV'),
    })
    const archive = services.sources.find((source) => source.id === 'archive')
    const candidates = await (
      archive as unknown as {
        resolve: (...args: unknown[]) => Promise<{ url: string }[]>
      }
    ).resolve(
      {
        source: 'archive',
        ref: (first?.id ?? '').split(':').slice(2).join(':'),
        kind: 'song',
        title: first?.title ?? '',
        artists: [],
        confidence: 1,
        evidence: [],
      },
      {
        ctx,
        prefs: DEFAULT_QUALITY_PREFS,
        rung: 'top',
        priority: 'current-track',
        signal: new AbortController().signal,
      },
    )
    expect(new URL(candidates[0]?.url ?? '').hostname).toMatch(/archive\.org$/)
  })

  it("resolves YouTube Music songs through the real ladder, the app's", async () => {
    const { network, platform } = platformOnFakeNetwork()
    const services = createEmbedServices(platform, { updates: false })
    const ladder = services.sources.find((source) => source.id === 'ytm')
    const ctx = platform.context({ mode: 'music', priority: 'current-track' })

    const options = await ladder?.resolve(
      {
        source: 'ytm',
        ref: 'zFYEYRcjK2g',
        kind: 'song',
        title: 'Creep',
        artists: ['Radiohead'],
        confidence: 1,
        evidence: [],
      },
      {
        ctx,
        prefs: DEFAULT_QUALITY_PREFS,
        rung: 'top',
        priority: 'current-track',
        signal: new AbortController().signal,
      },
    )

    expect(network.players).toEqual(['zFYEYRcjK2g'])
    expect(options?.length).toBeGreaterThan(0)
    // Bytes are readable with FXM Connect: the best URL passed the end-of-file probe.
    expect(options?.[0]?.fullLength).toBe('verified')
  })
})
