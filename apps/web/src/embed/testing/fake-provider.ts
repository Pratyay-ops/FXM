/**
 * A metadata provider that answers from fixtures, for the embed's tests and its browser tests'
 * build. It stands in for the YouTube Music, YouTube, Internet Archive and Jamendo providers
 * (stages 1.3 and 1.6), behind the same `MetadataProvider` interface.
 *
 * @module
 */

import {
  type Album,
  type Artist,
  type EntityId,
  FxmError,
  formatId,
  type MetadataProvider,
  type Playlist,
  type ProviderContext,
  type SearchResults,
  type SourceId,
  type Track,
} from '@fxm/core'

/** What a {@link FakeMetadataProvider} knows. */
export interface ProviderFixtures {
  readonly tracks?: readonly Track[]
  readonly albums?: readonly Album[]
  readonly playlists?: readonly Playlist[]
}

/** A track of `source` with sensible defaults. */
export function fixtureTrack(
  source: SourceId,
  nativeId: string,
  overrides: Partial<Omit<Track, 'id' | 'source'>> = {},
): Track {
  return {
    id: formatId(source, 'track', nativeId),
    source,
    title: `Song ${nativeId}`,
    artists: [{ name: 'Test Artist' }],
    artwork: [],
    kind: 'song',
    durationMs: 180_000,
    ...overrides,
  }
}

/**
 * Answers `getTrack`, `getAlbum` and `getPlaylist` from fixtures and rejects with `NotFound`
 * for anything else. `errors` makes an ID reject with another error, and `gate`, while set,
 * holds every answer until it resolves, so a test can look at the loading state. Every call is
 * recorded with the capabilities it saw.
 */
export class FakeMetadataProvider implements MetadataProvider {
  readonly id: SourceId
  /** Each call, as `<method> <id>`, in order. */
  readonly calls: string[] = []
  /** The contexts the calls received. */
  readonly contexts: ProviderContext[] = []
  /** IDs whose loading rejects with an error instead. */
  readonly errors = new Map<string, Error>()
  /** While set, every answer waits for it. */
  gate: Promise<void> | undefined
  readonly #fixtures: ProviderFixtures

  constructor(id: SourceId, fixtures: ProviderFixtures = {}) {
    this.id = id
    this.#fixtures = fixtures
  }

  async search(): Promise<SearchResults> {
    return {}
  }

  getTrack(id: EntityId<'track'>, ctx: ProviderContext): Promise<Track> {
    return this.#answer('getTrack', id, ctx, this.#fixtures.tracks)
  }

  getAlbum(id: EntityId<'album'>, ctx: ProviderContext): Promise<Album> {
    return this.#answer('getAlbum', id, ctx, this.#fixtures.albums)
  }

  getPlaylist(id: EntityId<'playlist'>, ctx: ProviderContext): Promise<Playlist> {
    return this.#answer('getPlaylist', id, ctx, this.#fixtures.playlists)
  }

  async getArtist(id: EntityId<'artist'>): Promise<Artist> {
    throw new FxmError('NotFound', `No artist ${id}`)
  }

  async #answer<T extends { readonly id: EntityId }>(
    method: string,
    id: EntityId,
    ctx: ProviderContext,
    items: readonly T[] | undefined,
  ): Promise<T> {
    this.calls.push(`${method} ${id}`)
    this.contexts.push(ctx)
    await this.gate
    const error = this.errors.get(id)
    if (error !== undefined) throw error
    const item = items?.find((candidate) => candidate.id === id)
    if (item === undefined) throw new FxmError('NotFound', `No ${method.slice(3)} ${id}`)
    return item
  }
}
