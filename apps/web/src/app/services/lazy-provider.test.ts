import {
  type EntityId,
  FxmError,
  isFxmError,
  type MetadataProvider,
  type ProviderContext,
} from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAppUpdatedError } from '../../lib/app-update'
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

/** The errors a browser's `import()` rejects with when a chunk does not download. */
const CHUNK_ERRORS = {
  chromium: new TypeError(
    'Failed to fetch dynamically imported module: https://fxmusic.pages.dev/app/assets/archive-BFIRBJSz.js',
  ),
  webkit: new TypeError('Importing a module script failed.'),
  firefox: new TypeError(
    'error loading dynamically imported module: https://fxmusic.pages.dev/app/assets/archive-BFIRBJSz.js',
  ),
}

describe('createLoader', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads once for concurrent calls, and keeps the value', async () => {
    const importModule = vi.fn(async () => ({ name: 'module' }))
    const build = vi.fn((module: { name: string }) => module.name)
    const loader = createLoader('the module', importModule, build)

    expect(loader.current).toBeUndefined()
    await expect(Promise.all([loader.load(), loader.load()])).resolves.toEqual(['module', 'module'])
    await loader.load()

    expect(importModule).toHaveBeenCalledOnce()
    expect(build).toHaveBeenCalledOnce()
    expect(loader.current).toBe('module')
  })

  it.each(Object.entries(CHUNK_ERRORS))(
    "says FXM was updated when a chunk doesn't download while online (%s)",
    async (_browser, chunkError) => {
      const importModule = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(chunkError)
        .mockResolvedValueOnce('module')
      const loader = createLoader('Internet Archive', importModule, (module) => module)

      const failed = await loader.load().catch((error: unknown) => error)

      // Not "Couldn't reach Internet Archive": the connection is fine, the file is gone.
      expect(isAppUpdatedError(failed)).toBe(true)
      expect(isFxmError(failed)).toBe(false)
      expect((failed as Error).cause).toBe(chunkError)
      // A failure is forgotten: the next call tries again.
      await expect(loader.load()).resolves.toBe('module')
    },
  )

  it("is a network error when the browser is offline, which 'Try again' fixes", async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const loader = createLoader(
      'YouTube Music',
      () => Promise.reject(CHUNK_ERRORS.chromium),
      (module) => module,
    )

    const failed = await loader.load().catch((error: unknown) => error)

    expect(isFxmError(failed, 'Network')).toBe(true)
    expect(isAppUpdatedError(failed)).toBe(false)
  })

  it('passes errors of building the value on as they are, and logs them', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bug = new TypeError('Not a valid secret source: ftp://example.com/')
    const build = vi.fn<(module: string) => string>().mockImplementationOnce(() => {
      throw bug
    })
    const loader = createLoader('Spotify', async () => 'module', build)

    await expect(loader.load()).rejects.toBe(bug)

    expect(error).toHaveBeenCalledWith('FXM: could not set up Spotify', bug)
    build.mockImplementation((module) => module)
    await expect(loader.load()).resolves.toBe('module')
  })

  it("keeps a provider's own FxmError as it is", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const unsupported = new FxmError('Unsupported', 'No YouTube here')
    const loader = createLoader(
      'YouTube Music',
      async () => 'module',
      () => {
        throw unsupported
      },
    )

    await expect(loader.load()).rejects.toBe(unsupported)
  })

  it('passes on a module that failed for another reason, and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = new SyntaxError('Unexpected token')
    const loader = createLoader(
      'LRCLIB',
      () => Promise.reject(broken),
      (module) => module,
    )

    await expect(loader.load()).rejects.toBe(broken)
    expect(error).toHaveBeenCalledWith('FXM: could not load LRCLIB', broken)
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
