import {
  type EntityId,
  FxmError,
  isFxmError,
  type MetadataProvider,
  type ProviderContext,
} from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { createLoader, lazyProvider } from './lazy-provider'

const ctx = {} as ProviderContext

/** A provider whose every method answers with its own name. */
function realProvider(): MetadataProvider {
  return {
    id: 'ytm',
    search: vi.fn(async () => ({ tracks: { items: [] } })),
    suggest: vi.fn(async (query: string) => [`${query} suggestion`]),
    getTrack: vi.fn(async () => {
      throw new FxmError('BotCheck', 'Sign in to confirm you’re not a bot')
    }),
    getAlbum: vi.fn(),
    getArtist: vi.fn(),
    getPlaylist: vi.fn(),
    getPlaylistTracks: vi.fn(async () => ({ items: [] })),
  }
}

describe('createLoader', () => {
  it('loads once for concurrent calls, and keeps the value', async () => {
    const load = vi.fn(async () => 'module')
    const loader = createLoader('the module', load)

    expect(loader.current).toBeUndefined()
    await expect(Promise.all([loader.load(), loader.load()])).resolves.toEqual(['module', 'module'])
    await loader.load()

    expect(load).toHaveBeenCalledOnce()
    expect(loader.current).toBe('module')
  })

  it('tries again after a failure, which is a network error for the pages', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce('module')
    const loader = createLoader('YouTube Music', load)

    const failed = await loader.load().catch((error: unknown) => error)

    expect(isFxmError(failed, 'Network')).toBe(true)
    expect((failed as Error).message).toBe('Could not load YouTube Music')
    await expect(loader.load()).resolves.toBe('module')
  })

  it("keeps a provider's own FxmError as it is", async () => {
    const error = new FxmError('Unsupported', 'No YouTube here')
    const loader = createLoader('YouTube Music', () => Promise.reject(error))

    await expect(loader.load()).rejects.toBe(error)
  })
})

describe('lazyProvider', () => {
  it('loads the real provider on the first call, not before', async () => {
    const real = realProvider()
    const load = vi.fn(async () => real)
    const provider = lazyProvider({ id: 'ytm', load })

    expect(load).not.toHaveBeenCalled()
    await provider.search('creep', { types: ['track'] }, ctx)

    expect(load).toHaveBeenCalledOnce()
    expect(real.search).toHaveBeenCalledWith('creep', { types: ['track'] }, ctx)
  })

  it('has exactly the optional members it is given', () => {
    const load = async () => realProvider()

    const youtube = lazyProvider({ id: 'ytm', suggest: true, getPlaylistTracks: true, load })
    const jamendo = lazyProvider({ id: 'jamendo', requestPolicy: 'explicit', load })

    expect(youtube.suggest).toBeTypeOf('function')
    expect(youtube.getPlaylistTracks).toBeTypeOf('function')
    expect(youtube.getRelatedArtists).toBeUndefined()
    expect(youtube.requestPolicy).toBeUndefined()
    expect(jamendo.suggest).toBeUndefined()
    expect(jamendo.requestPolicy).toBe('explicit')
  })

  it('passes optional calls on with their arguments', async () => {
    const real = realProvider()
    const provider = lazyProvider({
      id: 'ytm',
      suggest: true,
      getPlaylistTracks: true,
      load: async () => real,
    })
    const id = 'ytm:playlist:PL1' as EntityId<'playlist'>

    await expect(provider.suggest?.('cre', ctx)).resolves.toEqual(['cre suggestion'])
    await provider.getPlaylistTracks?.(id, { cursor: 'next' }, ctx)

    expect(real.getPlaylistTracks).toHaveBeenCalledWith(id, { cursor: 'next' }, ctx)
  })

  it('reports every error, so the budget hears of bot checks', async () => {
    const report = vi.fn()
    const provider = lazyProvider({ id: 'ytm', load: async () => realProvider(), report })

    const error = await provider
      .getTrack('ytm:track:zFYEYRcjK2g' as EntityId<'track'>, ctx)
      .catch((caught: unknown) => caught)

    expect(isFxmError(error, 'BotCheck')).toBe(true)
    expect(report).toHaveBeenCalledWith(error)
  })

  it('refuses a member the real provider lacks after all', async () => {
    // The real provider has no related artists.
    const real = realProvider()
    const provider = lazyProvider({ id: 'ytm', getRelatedArtists: true, load: async () => real })

    await expect(
      provider.getRelatedArtists?.('ytm:artist:UC1' as EntityId<'artist'>, ctx),
    ).rejects.toSatisfy((error: unknown) => isFxmError(error, 'Unsupported'))
  })
})
