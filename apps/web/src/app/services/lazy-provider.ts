/**
 * Metadata providers that load their code on first use. The YouTube providers carry youtubei.js
 * (about 165 KB gzipped, the providers another 25 KB), and Spotify only matters where its secret
 * can be fetched, so neither belongs in the app's first bundle. The sources registry (stage 2.4)
 * still needs a provider object at once, to list the source and its features: {@link lazyProvider}
 * is one, and loads the real provider the first time a page calls it.
 *
 * @module
 */

import {
  type EntityId,
  FxmError,
  type MetadataProvider,
  type PageOptions,
  type ProviderContext,
  type SourceId,
} from '@fxm/core'
import { AppUpdatedError } from '../../lib/app-update'
import { isChunkLoadError } from '../errors'

/** Loads a module once, and again after a failure (a chunk that did not download, say). */
export interface Loader<T> {
  /** The loaded value, loading it first if needed. */
  load(): Promise<T>
  /** The value once it loaded, else `undefined`. */
  readonly current: T | undefined
}

/** Whether the browser says it is offline. Without a `navigator`, it counts as online. */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * What a failed `import()` becomes:
 *
 * - offline, a `Network` `FxmError`: the pages say "Couldn't reach …" and offer "Try again";
 * - online, a code file that did not download is an `AppUpdatedError`: the build names its
 *   files after their content, so a file that is gone means a new version replaced it, and only
 *   a reload helps (a tab opened before a deploy, say);
 * - anything else, e.g. a module whose own code threw, is a bug: it is logged and passes on.
 */
function importError(what: string, cause: unknown): unknown {
  if (isOffline()) return new FxmError('Network', `Could not load ${what}: offline`, { cause })
  if (isChunkLoadError(cause)) {
    return new AppUpdatedError(`Could not load ${what}: FXM was most likely updated`, { cause })
  }
  console.error(`FXM: could not load ${what}`, cause)
  return cause
}

/**
 * A {@link Loader} that imports a module with `importModule` and builds the value from it with
 * `build`. Concurrent calls share one load. A load that fails is forgotten, so the next call
 * tries again. The two halves fail differently:
 *
 * - **the import** is a download, whose failure says what helps (see `importError`): the
 *   connection back, or a reload after an update;
 * - **building** runs FXM's own code, whose errors pass on as they are and are logged, so a bug
 *   shows as one, not as a network problem with a "Try again" that can never work.
 */
export function createLoader<M, T>(
  what: string,
  importModule: () => Promise<M>,
  build: (module: M) => T | Promise<T>,
): Loader<T> {
  let current: T | undefined
  let pending: Promise<T> | undefined

  async function load(): Promise<T> {
    let module: M
    try {
      module = await importModule()
    } catch (cause) {
      throw importError(what, cause)
    }
    try {
      return await build(module)
    } catch (error) {
      console.error(`FXM: could not set up ${what}`, error)
      throw error
    }
  }

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
        (error: unknown) => {
          pending = undefined
          throw error
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
