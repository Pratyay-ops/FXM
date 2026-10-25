import { FxmError, type MetadataProvider, type NetworkCapabilities, type SourceId } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { FAKE_TIER_KEY, readFakeTier } from './dev-fakes'
import { createFakeCatalog } from './fake-catalog'
import {
  createMemorySpotifySwitch,
  createSources,
  createStaticPlatform,
  itemFeatures,
  providerFor,
  type SourcesSnapshot,
  searchSourceIds,
  sourceAvailability,
  sourceLabel,
  TIER_CAPABILITIES,
  tierOf,
} from './sources'
import { createSpotifySwitch, SOURCES_STORAGE_KEY } from './spotify-switch'

function stubProvider(id: SourceId): MetadataProvider {
  const fail = () => Promise.reject(new FxmError('NotFound', 'stub'))
  return {
    id,
    search: () => Promise.resolve({}),
    getTrack: fail,
    getAlbum: fail,
    getArtist: fail,
    getPlaylist: fail,
  }
}

function snapshot(
  tier: keyof typeof TIER_CAPABILITIES,
  providers: readonly SourceId[],
  spotifyEnabled = true,
): SourcesSnapshot {
  return {
    capabilities: TIER_CAPABILITIES[tier],
    spotifyEnabled,
    providers: new Map(providers.map((id) => [id, stubProvider(id)])),
  }
}

/** An in-memory stand-in for localStorage. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, String(value))
    },
  }
}

describe('tiers', () => {
  it.each([
    ['free', 'free'],
    ['lite', 'lite'],
    ['full', 'full'],
  ] as const)('reads the %s capabilities as the %s tier', (preset, tier) => {
    expect(tierOf(TIER_CAPABILITIES[preset])).toBe(tier)
  })

  it('reads media bytes only in the full tier, as NetworkCapabilities requires', () => {
    expect(TIER_CAPABILITIES.free.mediaBytes).toBe(false)
    expect(TIER_CAPABILITIES.lite.mediaBytes).toBe(false)
    expect(TIER_CAPABILITIES.full.mediaBytes).toBe(true)
  })
})

describe('sourceAvailability', () => {
  it('offers YouTube whenever it is simple or full, and onboarding when it is none', () => {
    expect(sourceAvailability(snapshot('full', ['ytm']), 'ytm').status).toBe('available')
    expect(sourceAvailability(snapshot('lite', ['ytm']), 'ytm').status).toBe('available')
    expect(sourceAvailability(snapshot('free', ['ytm']), 'ytm').status).toBe('needs-youtube')
    // The onboarding entry point wins even before a provider is registered.
    expect(sourceAvailability(snapshot('free', []), 'ytm').status).toBe('needs-youtube')
  })

  it('needs Spotify both switched on and reachable', () => {
    expect(sourceAvailability(snapshot('full', ['spotify']), 'spotify').status).toBe('available')
    expect(sourceAvailability(snapshot('full', ['spotify'], false), 'spotify').status).toBe(
      'spotify-off',
    )
    expect(sourceAvailability(snapshot('lite', ['spotify']), 'spotify').status).toBe(
      'spotify-unreachable',
    )
  })

  it('reports a source without a provider as missing', () => {
    expect(sourceAvailability(snapshot('full', []), 'ytm').status).toBe('missing')
    expect(sourceAvailability(snapshot('free', []), 'archive').status).toBe('missing')
    expect(sourceAvailability(snapshot('free', ['archive']), 'archive').status).toBe('available')
  })

  it('lets the YouTube Music provider answer for plain YouTube IDs', () => {
    const state = snapshot('full', ['ytm'])
    expect(providerFor(state, 'yt')).toBe(state.providers.get('ytm'))
    expect(sourceAvailability(state, 'yt').status).toBe('available')
  })
})

describe('searchSourceIds', () => {
  it('always offers YouTube Music first, even when it cannot be reached', () => {
    expect(searchSourceIds(snapshot('free', []))).toEqual(['ytm'])
  })

  it('adds Spotify only when it is switched on and reachable', () => {
    expect(searchSourceIds(snapshot('full', ['ytm', 'spotify']))).toEqual(['ytm', 'spotify'])
    expect(searchSourceIds(snapshot('full', ['ytm', 'spotify'], false))).toEqual(['ytm'])
    expect(searchSourceIds(snapshot('lite', ['ytm', 'spotify']))).toEqual(['ytm'])
  })

  it('orders the other sources, plugins last by name', () => {
    expect(
      searchSourceIds(
        snapshot('full', ['plugin.zeta', 'jamendo', 'plugin.alpha', 'spotify', 'archive', 'yt']),
      ),
    ).toEqual(['ytm', 'spotify', 'archive', 'jamendo', 'plugin.alpha', 'plugin.zeta'])
  })
})

describe('itemFeatures', () => {
  it('hides download and the equalizer on YouTube items in Lite', () => {
    expect(itemFeatures(TIER_CAPABILITIES.lite, 'ytm')).toEqual({
      download: false,
      equalizer: false,
    })
    expect(itemFeatures(TIER_CAPABILITIES.lite, 'yt')).toEqual({
      download: false,
      equalizer: false,
    })
    expect(itemFeatures(TIER_CAPABILITIES.full, 'ytm')).toEqual({ download: true, equalizer: true })
  })

  it('treats Spotify items like YouTube ones, and free sources as always readable', () => {
    expect(itemFeatures(TIER_CAPABILITIES.lite, 'spotify').download).toBe(false)
    expect(itemFeatures(TIER_CAPABILITIES.full, 'spotify').download).toBe(true)
    for (const source of ['archive', 'jamendo', 'local'] as const) {
      expect(itemFeatures(TIER_CAPABILITIES.free, source)).toEqual({
        download: true,
        equalizer: true,
      })
    }
    expect(itemFeatures(TIER_CAPABILITIES.full, 'plugin.radio').download).toBe(false)
  })

  it('follows mediaBytes, not just the tier name', () => {
    const fullWithoutBytes: NetworkCapabilities = {
      youtube: 'full',
      spotify: 'anonymous',
      mediaBytes: false,
      fileSystem: false,
    }
    expect(itemFeatures(fullWithoutBytes, 'ytm').download).toBe(false)
  })
})

describe('sourceLabel', () => {
  it('names the sources in plain text, plugins by their name', () => {
    expect(sourceLabel('ytm')).toBe('YouTube Music')
    expect(sourceLabel('spotify')).toBe('Spotify')
    expect(sourceLabel('archive')).toBe('Internet Archive')
    expect(sourceLabel('plugin.radio-garden')).toBe('radio-garden')
  })
})

describe('createSources', () => {
  it('starts in the Free-only tier with no providers and a fetch that refuses', async () => {
    const sources = createSources()
    expect(sources.getSnapshot().capabilities).toEqual(TIER_CAPABILITIES.free)
    expect(sources.getSnapshot().providers.size).toBe(0)
    const ctx = sources.context({ mode: 'music' })
    await expect(ctx.fetch('https://music.youtube.com/')).rejects.toMatchObject({
      code: 'Unsupported',
    })
  })

  it('registers and unregisters providers, telling subscribers', () => {
    const sources = createSources()
    const listener = vi.fn()
    sources.subscribe(listener)
    const ytm = createFakeCatalog('ytm')

    const unregister = sources.register(ytm)
    expect(sources.getSnapshot().providers.get('ytm')).toBe(ytm)
    unregister()
    expect(sources.getSnapshot().providers.has('ytm')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer provider when an older one unregisters', () => {
    const sources = createSources()
    const first = createFakeCatalog('ytm')
    const second = createFakeCatalog('ytm')
    const unregisterFirst = sources.register(first)
    sources.register(second)
    unregisterFirst()
    expect(sources.getSnapshot().providers.get('ytm')).toBe(second)
  })

  it('follows capability changes, and keeps the snapshot while nothing changes', () => {
    const platform = createStaticPlatform()
    const sources = createSources({ platform })
    const before = sources.getSnapshot()
    expect(sources.getSnapshot()).toBe(before)

    platform.setCapabilities({ ...TIER_CAPABILITIES.free })
    expect(sources.getSnapshot()).toBe(before)

    platform.setCapabilities(TIER_CAPABILITIES.full)
    expect(sources.getSnapshot().capabilities.youtube).toBe('full')
  })

  it('swaps the platform, e.g. once stage 1.2 detected the tier', () => {
    const first = createStaticPlatform(TIER_CAPABILITIES.free)
    const second = createStaticPlatform(TIER_CAPABILITIES.lite)
    const sources = createSources({ platform: first })

    sources.setPlatform(second)
    expect(sources.getSnapshot().capabilities.youtube).toBe('simple')
    expect(sources.context({ mode: 'all' }).capabilities.youtube).toBe('simple')

    // The old platform no longer moves the sources.
    first.setCapabilities(TIER_CAPABILITIES.full)
    expect(sources.getSnapshot().capabilities.youtube).toBe('simple')
    second.setCapabilities(TIER_CAPABILITIES.full)
    expect(sources.getSnapshot().capabilities.youtube).toBe('full')
  })

  it('switches Spotify through its switch', () => {
    const spotifySwitch = createMemorySpotifySwitch(true)
    const sources = createSources({ spotifySwitch })
    sources.setSpotifyEnabled(false)
    expect(sources.getSnapshot().spotifyEnabled).toBe(false)
    expect(spotifySwitch.getState().enabled).toBe(false)
  })

  it('builds contexts with the mode, signal, locale and region', () => {
    const sources = createSources({ platform: createStaticPlatform(TIER_CAPABILITIES.lite) })
    const signal = new AbortController().signal
    const ctx = sources.context({ mode: 'all', signal, locale: 'en-IN', region: 'IN' })
    expect(ctx).toMatchObject({
      platform: 'web',
      mode: 'all',
      signal,
      locale: 'en-IN',
      region: 'IN',
    })
    expect(ctx.capabilities).toEqual(TIER_CAPABILITIES.lite)
    expect(sources.context({ mode: 'music' })).not.toHaveProperty('signal')
  })
})

describe('the Spotify switch', () => {
  it('is on by default and persists a change', () => {
    const storage = memoryStorage()
    const store = createSpotifySwitch({ storage: () => storage })
    expect(store.getState().enabled).toBe(true)

    store.getState().setEnabled(false)

    expect(JSON.parse(storage.getItem(SOURCES_STORAGE_KEY) ?? 'null')).toEqual({
      state: { spotifyEnabled: false },
      version: 1,
    })
    expect(createSpotifySwitch({ storage: () => storage }).getState().enabled).toBe(false)
  })

  it.each([
    ['corrupt JSON', '{"state": '],
    ['a value of the wrong type', JSON.stringify({ state: { spotifyEnabled: 'no' }, version: 1 })],
    ['an array', '[]'],
  ])('falls back to on when storage holds %s', (_, raw) => {
    const storage = memoryStorage({ [SOURCES_STORAGE_KEY]: raw })
    expect(createSpotifySwitch({ storage: () => storage }).getState().enabled).toBe(true)
  })

  it('keeps working when storage is blocked', () => {
    const store = createSpotifySwitch({
      storage: () => {
        throw new DOMException('Access denied', 'SecurityError')
      },
    })
    store.getState().setEnabled(false)
    expect(store.getState().enabled).toBe(false)
  })

  it('drives the sources when passed to them', () => {
    const store = createSpotifySwitch({ storage: () => memoryStorage() })
    const sources = createSources({ spotifySwitch: store })
    store.getState().setEnabled(false)
    expect(sources.getSnapshot().spotifyEnabled).toBe(false)
  })
})

describe('the dev fake tier', () => {
  it('turns on with ?fake=, remembers it for the tab and turns off with ?fake=off', () => {
    const storage = memoryStorage()
    expect(readFakeTier('', () => storage)).toBeUndefined()
    expect(readFakeTier('?fake=lite', () => storage)).toBe('lite')
    expect(storage.getItem(FAKE_TIER_KEY)).toBe('lite')
    expect(readFakeTier('?q=owl', () => storage)).toBe('lite')
    expect(readFakeTier('?fake=off', () => storage)).toBeUndefined()
    expect(readFakeTier('', () => storage)).toBeUndefined()
  })

  it('ignores unknown tiers and works without storage', () => {
    expect(readFakeTier('?fake=ultra', () => memoryStorage())).toBeUndefined()
    const blocked = () => {
      throw new DOMException('Access denied', 'SecurityError')
    }
    expect(readFakeTier('?fake=full', blocked)).toBe('full')
  })
})
