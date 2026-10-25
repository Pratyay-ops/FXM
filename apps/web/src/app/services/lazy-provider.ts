/**
 * Metadata providers that load their code on first use. The YouTube providers carry youtubei.js
 * (about 193 KB gzipped), and Spotify only matters with FXM Connect, so neither belongs in the
 * app's first bundle. The sources registry (stage 2.4) still needs a provider object at once, to
 * list the source and its features: {@link lazyProvider} is one, and loads the real provider
 * the first time a page calls it.
 *
 * @module
 */

import {
  type EntityId,
  FxmError,
  isFxmError,
  type MetadataProvider,
  type PageOptions,
  type ProviderContext,
  type SourceId,
} from '@fxm/core'

/** Loads a module once, and again after a failure (a chunk that did not download, say). */
export interface Loader<T> {
  /** The loaded value, loading it first if needed. */
  load(): Promise<T>
  /** The value once it loaded, else `undefined`. */
  readonly current: T | undefined
}

/**
 * A {@link Loader} over `load`. Concurrent calls share one load. A load that fails is forgotten,
 * so the next call tries again, and its error becomes a `Network` `FxmError`: offline, a code
 * chunk can't download, and the pages offer "Try again" for network errors.
 */
export function createLoader<T>(what: string, load: () => Promise<T>): Loader<T> {
  let current: T | undefined
  let pending: Promise<T> | undefined
  return {
    get current() {
      return current
    },
    load() {
      if (current !== undefined) return Promise.resolve(current)
      pending ??= load().then(
        (value) => {
          current = value
          pending = undefined
          return value
        },
        (cause: unknown) => {
          pending = undefined
          throw isFxmError(cause)
            ? cause
            : new FxmError('Network', `Could not load ${what}`, { cause })
        },
      )
      return pending
    },
  }
}

/** The optional members of {@link MetadataProvider} a lazy provider offers. */
export interface LazyProviderShape {
  /** It has `suggest`: completions as the user types. */
  readonly suggest?: boolean
  /** It has `getPlaylistTracks`: further pages of a playlist. */
  readonly getPlaylistTracks?: boolean
  /** It has `getRelatedArtists`. */
  readonly getRelatedArtists?: boolean
  /** Its `requestPolicy`, e.g. `explicit` for Jamendo. */
  readonly requestPolicy?: 'any' | 'explicit'
}

/** Options for {@link lazyProvider}. */
export interface LazyProviderOptions extends LazyProviderShape {
  /** The source it reads. */
  readonly id: SourceId
  /** Loads the real provider. */
  readonly load: () => Promise<MetadataProvider>
  /**
   * Hears every error a call rejects with, e.g. `FxmPlatform.report`, so that a bot check a
   * provider noticed itself pauses the request budget's bulk work too.
   */
  readonly report?: (error: unknown) => void
}

/**
 * A {@link MetadataProvider} that loads the real one on its first call and then passes every
 * call on. It has exactly the optional members `options` names, so the pages offer what the real
 * provider can do (suggestions only where it has them, say).
 */
export function lazyProvider(options: LazyProviderOptions): MetadataProvider {
  const { load, report } = options
  async function call<T>(use: (provider: MetadataProvider) => Promise<T>): Promise<T> {
    try {
      return await use(await load())
    } catch (error) {
      report?.(error)
      throw error
    }
  }
  /** A member the real provider was promised to have. */
  function member<K extends keyof MetadataProvider>(
    provider: MetadataProvider,
    name: K,
  ): NonNullable<MetadataProvider[K]> {
    const value = provider[name]
    if (value === undefined) {
      throw new FxmError('Unsupported', `The ${options.id} provider has no ${String(name)}`)
    }
    return value as NonNullable<MetadataProvider[K]>
  }

  const provider: MetadataProvider = {
    id: options.id,
    ...(options.requestPolicy === undefined ? {} : { requestPolicy: options.requestPolicy }),
    search: (query, searchOptions, ctx) => call((p) => p.search(query, searchOptions, ctx)),
    getTrack: (id, ctx) => call((p) => p.getTrack(id, ctx)),
    getAlbum: (id, ctx) => call((p) => p.getAlbum(id, ctx)),
    getArtist: (id, ctx) => call((p) => p.getArtist(id, ctx)),
    getPlaylist: (id, ctx) => call((p) => p.getPlaylist(id, ctx)),
  }
  if (options.suggest) {
    provider.suggest = (query: string, ctx: ProviderContext) =>
      call((p) => member(p, 'suggest').call(p, query, ctx))
  }
  if (options.getPlaylistTracks) {
    provider.getPlaylistTracks = (
      id: EntityId<'playlist'>,
      pageOptions: PageOptions,
      ctx: ProviderContext,
    ) => call((p) => member(p, 'getPlaylistTracks').call(p, id, pageOptions, ctx))
  }
  if (options.getRelatedArtists) {
    provider.getRelatedArtists = (id: EntityId<'artist'>, ctx: ProviderContext) =>
      call((p) => member(p, 'getRelatedArtists').call(p, id, ctx))
  }
  return provider
}
