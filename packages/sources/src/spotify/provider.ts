/**
 * The Spotify provider: metadata (search, tracks, albums, artists, related artists, playlists),
 * recommendations (track and artist radio, the home feed) and a minimal account status, read from
 * Spotify's web-player APIs on the user's own device through `ctx.fetch`.
 *
 * One instance holds the tokens, caches and pause state, so the app creates one and keeps it.
 *
 * @module
 */

import {
  type AccountProvider,
  type AccountStatus,
  type Album,
  type Artist,
  type ArtistRef,
  applyModeFilter,
  type CatalogMode,
  type EntityId,
  formatId,
  isFxmError,
  isTrackSeed,
  type MetadataProvider,
  normalizeText,
  type Page,
  type PageOptions,
  type Playlist,
  type ProviderContext,
  parseId,
  type RadioSeed,
  type RecommendationProvider,
  type SearchOptions,
  type SearchResults,
  type Shelf,
  type ShelfItem,
  splitTitle,
  stripPresentationNoise,
  type Track,
} from '@fxm/core'
import { TtlCache } from './cache'
import { type JsonRecord, SpotifyClient } from './client'
import { DEFAULT_SPOTIFY_CONFIG, type SpotifyConfig, type SpotifyOperationName } from './config'
import { isSpotifyError, SpotifyError } from './errors'
import { SpotifyHttp } from './http'
import { base62ToHex, isSpotifyId, spotifyIdOf, spotifyUri } from './ids'
import {
  albumTracksOnPage,
  type HomeSectionPage,
  mapAlbum,
  mapArtist,
  mapHome,
  mapHomeSection,
  mapLibraryPlaylists,
  mapLibraryTracks,
  mapPlaylist,
  mapProfileName,
  mapRelatedArtists,
  mapSearch,
  mapTrack,
  mapTrackDetails,
  radioPlaylistId,
  type SpotifySearchPages,
  type SpotifyTrackDetails,
  unionOf,
} from './mapping'
import { OperationRegistry } from './operations'
import { createSecretProvider, type SecretProvider, type SecretSource } from './secret'
import { isSpotifyReachable } from './settings'
import { type SessionTokenSource, type TokenKind, TokenManager } from './token'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** How long each kind of answer is cached, in milliseconds. */
export interface SpotifyCacheTtls {
  /** Search results. */
  search: number
  /** Tracks, albums, artists, related artists and playlists. */
  entity: number
  /** ISRC, label and release date from spclient. */
  details: number
  /** The home feed and its sections. */
  home: number
  /** Radio. */
  radio: number
}

/** The cache lifetimes the provider uses unless told otherwise. */
export const DEFAULT_SPOTIFY_CACHE_TTLS: Readonly<SpotifyCacheTtls> = Object.freeze({
  search: 10 * MINUTE,
  entity: 6 * HOUR,
  details: 24 * HOUR,
  home: 30 * MINUTE,
  radio: 30 * MINUTE,
})

/** What the UI can show about the provider's state. */
export interface SpotifyHealth {
  /** While Spotify is paused after repeated rate limits or server errors: when it resumes. */
  pausedUntil?: number
  /** While minting is paused because the TOTP secret was refused: when it is tried again. */
  secretPausedUntil?: number
  /** The operations Spotify rejected this session; they need a newer config. */
  brokenOperations: SpotifyOperationName[]
}

/** Options for {@link createSpotifyProvider}. All are optional. */
export interface SpotifyProviderOptions {
  /** The config: endpoints, secret sources, User-Agent and hashes. Default: the bundled one. */
  config?: SpotifyConfig
  /** The source of logged-in tokens on this platform (the FXM Connect bridge, a login window). */
  session?: SessionTokenSource
  /** A custom secret provider. Default: one over `secretSources`. */
  secrets?: SecretProvider
  /** The secret sources of the default secret provider. Default: the config's URLs. */
  secretSources?: readonly SecretSource[]
  /** The `fetch` the default secret provider uses for URLs. Default: `ctx.fetch`. */
  secretFetch?: ProviderContext['fetch']
  /** The user's switch (Settings → Spotify). Default: always on. */
  isEnabled?: () => boolean
  /** Whether to send the browser User-Agent. Default: on native transports only. */
  sendUserAgent?: (ctx: ProviderContext) => boolean
  /** Cache lifetimes. Default {@link DEFAULT_SPOTIFY_CACHE_TTLS}. */
  cacheTtlMs?: Partial<SpotifyCacheTtls>
  /**
   * Whether a radio seed from another source without a Spotify ID may be looked up by title and
   * artist (one search). Default true.
   */
  lookupForeignSeeds?: boolean
  /** The IANA time zone the home feed is localized for. Default: the device's. */
  timeZone?: () => string
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  now?: () => number
  /** Waits between retries. Default: a timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** A random number in [0, 1), for jitter. Default `Math.random`. */
  random?: () => number
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number
  /** Retries after a 429 or 5xx answer. Default 3. */
  maxRetries?: number
  /**
   * How long Spotify pauses after persistent 429 or 5xx answers, and how long minting pauses
   * after the TOTP secret was refused twice. Default 5 minutes.
   */
  pauseMs?: number
  /** Called whenever {@link SpotifyProvider.health} changes. */
  onHealthChange?: (health: SpotifyHealth) => void
}

/** One page of a playlist read with offset 0 and this limit, as Spotify's web player does. */
const PLAYLIST_PAGE = 50
/** Album tracks per `getAlbum` call, and the most pages read for one album. */
const ALBUM_PAGE = 50
const ALBUM_MAX_PAGES = 10

const SEARCH_OPERATIONS = {
  track: 'searchTracks',
  album: 'searchAlbums',
  artist: 'searchArtists',
  playlist: 'searchPlaylists',
} as const satisfies Record<string, SpotifyOperationName>

type SearchKind = keyof typeof SEARCH_OPERATIONS

const SEARCH_KINDS: readonly SearchKind[] = ['track', 'album', 'artist', 'playlist']

/** The search flags FXM sends: no audiobooks, authors or pre-releases. */
const SEARCH_FLAGS = {
  includeAudiobooks: false,
  includePreReleases: false,
  includeAlbumPreReleases: false,
  includeAuthors: false,
  includeEpisodeContentRatingsV2: false,
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback
  return Math.min(max, Math.max(1, Math.floor(limit)))
}

/**
 * The offset in a cursor this provider returned (a decimal offset).
 *
 * @throws RangeError for anything else.
 */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d{1,9}$/u.test(cursor)) throw new RangeError('Not a Spotify page cursor')
  return Number(cursor)
}

function filterTracks(page: Page<Track>, mode: CatalogMode): Page<Track> {
  return { ...page, items: applyModeFilter(page.items, mode) }
}

function filterShelf(shelf: Shelf, mode: CatalogMode): Shelf {
  const items = shelf.items.filter(
    (item: ShelfItem) => item.type !== 'track' || applyModeFilter([item.track], mode).length > 0,
  )
  return { ...shelf, items }
}

/** The core of a title without a leading "Artist - " and presentation noise. */
function titleCore(title: string, artist: string): string {
  let rest = stripPresentationNoise(title)
  const dash = /\s[-–—]\s/u.exec(rest)
  if (dash && normalizeText(rest.slice(0, dash.index)) === normalizeText(artist)) {
    rest = rest.slice(dash.index + dash[0].length)
  }
  return splitTitle(rest).core
}

/** Spotify, as a metadata, recommendation and account provider. */
export class SpotifyProvider implements MetadataProvider, RecommendationProvider, AccountProvider {
  /** The source this provider reads. */
  readonly id = 'spotify'

  readonly #config: SpotifyConfig
  readonly #secrets: SecretProvider
  readonly #http: SpotifyHttp
  readonly #tokens: TokenManager
  readonly #operations: OperationRegistry
  readonly #client: SpotifyClient
  readonly #cache: TtlCache
  readonly #ttl: SpotifyCacheTtls
  readonly #isEnabled: () => boolean
  readonly #lookupForeignSeeds: boolean
  readonly #timeZone: () => string
  readonly #onHealthChange: ((health: SpotifyHealth) => void) | undefined

  constructor(options: SpotifyProviderOptions = {}) {
    const now = options.now ?? Date.now
    const notify = () => this.#onHealthChange?.(this.health())
    this.#config = options.config ?? DEFAULT_SPOTIFY_CONFIG
    this.#onHealthChange = options.onHealthChange
    this.#isEnabled = options.isEnabled ?? (() => true)
    this.#lookupForeignSeeds = options.lookupForeignSeeds ?? true
    this.#timeZone = options.timeZone ?? defaultTimeZone
    this.#ttl = { ...DEFAULT_SPOTIFY_CACHE_TTLS, ...options.cacheTtlMs }
    this.#cache = new TtlCache({ now })
    this.#secrets =
      options.secrets ??
      createSecretProvider({
        sources: options.secretSources ?? this.#config.secretSources.map((url) => ({ url })),
        now,
        ...(options.secretFetch ? { fetch: options.secretFetch } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
    this.#http = new SpotifyHttp({
      userAgent: this.#config.userAgent,
      now,
      onPause: notify,
      ...pick(options, ['sendUserAgent', 'sleep', 'random', 'timeoutMs', 'maxRetries', 'pauseMs']),
    })
    this.#tokens = new TokenManager({
      config: this.#config,
      http: this.#http,
      secrets: this.#secrets,
      now,
      onSecretPause: notify,
      ...(options.session ? { session: options.session } : {}),
      ...(options.pauseMs === undefined ? {} : { secretPauseMs: options.pauseMs }),
    })
    this.#operations = new OperationRegistry(this.#config, notify)
    this.#client = new SpotifyClient({
      config: this.#config,
      http: this.#http,
      tokens: this.#tokens,
      operations: this.#operations,
    })
  }

  // --- State ----------------------------------------------------------------------------

  /** Pauses and broken operations, for the UI ("Spotify is paused: …"). */
  health(): SpotifyHealth {
    const pausedUntil = this.#http.pausedUntil
    const secretPausedUntil = this.#tokens.secretPausedUntil
    return {
      ...(pausedUntil === undefined ? {} : { pausedUntil }),
      ...(secretPausedUntil === undefined ? {} : { secretPausedUntil }),
      brokenOperations: this.#operations.broken(),
    }
  }

  /** Ends both pauses early, e.g. when the user taps "Try again". */
  resume(): void {
    this.#http.resume()
    this.#tokens.resumeSecret()
    this.#onHealthChange?.(this.health())
  }

  /** Forgets which operations broke, e.g. after loading a newer config into a new provider. */
  resetOperations(): void {
    this.#operations.reset()
  }

  /** Uses other secret sources from now on, e.g. a URL or JSON from Settings, and resumes. */
  setSecretSources(sources: readonly SecretSource[]): void {
    this.#secrets.setSources(sources)
    this.resume()
  }

  /** Forgets the account token and every personal answer, e.g. on "Disconnect". */
  disconnect(): void {
    this.#tokens.clear('account')
    this.#cache.clear('home:account')
    this.#cache.clear('home-section:account')
    this.#cache.clear('profile')
  }

  // --- MetadataProvider -----------------------------------------------------------------

  /**
   * Searches Spotify, one page per requested type. Several types on a first page take one
   * `searchDesktop` call; a single type, or a later page, takes that type's own search. Spotify
   * has no videos for FXM, so `video` is always an empty page.
   */
  async search(
    query: string,
    options: SearchOptions,
    ctx: ProviderContext,
  ): Promise<SearchResults> {
    this.#gate(ctx)
    const types = new Set(options.types)
    const kinds = SEARCH_KINDS.filter((kind) => types.has(kind))
    const term = query.trim()
    const limit = clampLimit(options.limit, 20, 50)
    const offset = offsetOf(options.cursor)
    let pages: SpotifySearchPages = {}
    if (term !== '' && kinds.length > 0) {
      if (kinds.length === 1 || offset > 0) {
        const parts = await Promise.all(
          kinds.map((kind) => this.#typedSearch(kind, term, offset, limit, ctx)),
        )
        for (const part of parts) Object.assign(pages, part)
      } else {
        pages = await this.#desktopSearch(term, limit, ctx)
      }
    }
    const empty = { items: [] }
    return {
      ...(types.has('track') ? { tracks: filterTracks(pages.tracks ?? empty, ctx.mode) } : {}),
      ...(types.has('video') ? { videos: { items: [] } } : {}),
      ...(types.has('album') ? { albums: pages.albums ?? empty } : {}),
      ...(types.has('artist') ? { artists: pages.artists ?? empty } : {}),
      ...(types.has('playlist') ? { playlists: pages.playlists ?? empty } : {}),
    }
  }

  #desktopSearch(term: string, limit: number, ctx: ProviderContext): Promise<SpotifySearchPages> {
    return this.#cache.getOrLoad(
      `search:all:${limit}:${term}`,
      this.#ttl.search,
      async () => {
        const data = await this.#client.query(
          'searchDesktop',
          {
            searchTerm: term,
            offset: 0,
            limit,
            numberOfTopResults: 5,
            includeArtistHasConcertsField: false,
            isPrefix: null,
            sectionFilters: ['GENERIC'],
            ...SEARCH_FLAGS,
          },
          ctx,
        )
        return mapSearch(this.#expectRecord(data.searchV2, 'searchDesktop'), 0, limit)
      },
      ctx.signal,
    )
  }

  /** A typed search, whose answer holds only that type's page. */
  #typedSearch(
    kind: SearchKind,
    term: string,
    offset: number,
    limit: number,
    ctx: ProviderContext,
  ): Promise<SpotifySearchPages> {
    const operation = SEARCH_OPERATIONS[kind]
    return this.#cache.getOrLoad(
      `search:${kind}:${offset}:${limit}:${term}`,
      this.#ttl.search,
      async () => {
        const variables = { searchTerm: term, offset, limit, ...SEARCH_FLAGS }
        const data = await this.#client.query(operation, variables, ctx)
        return mapSearch(this.#expectRecord(data.searchV2, operation), offset, limit)
      },
      ctx.signal,
    )
  }

  /** Loads a track. Its ISRC is included when a details lookup already found it. */
  async getTrack(id: EntityId<'track'>, ctx: ProviderContext): Promise<Track> {
    this.#gate(ctx)
    const nativeId = spotifyIdOf(id, 'track')
    const track = await this.#cache.getOrLoad(
      `track:${nativeId}`,
      this.#ttl.entity,
      async () => {
        const data = await this.#client.query(
          'getTrack',
          { uri: spotifyUri('track', nativeId) },
          ctx,
        )
        return this.#entity(data.trackUnion, 'Track', mapTrack, `track ${nativeId}`)
      },
      ctx.signal,
    )
    return this.#withKnownDetails(track)
  }

  /** Loads an album with all its tracks (in pages of 50, up to 500 tracks). */
  async getAlbum(id: EntityId<'album'>, ctx: ProviderContext): Promise<Album> {
    this.#gate(ctx)
    const nativeId = spotifyIdOf(id, 'album')
    return this.#cache.getOrLoad(
      `album:${nativeId}`,
      this.#ttl.entity,
      async () => {
        const uri = spotifyUri('album', nativeId)
        const page = (offset: number) =>
          this.#client.query('getAlbum', { uri, locale: '', offset, limit: ALBUM_PAGE }, ctx)
        const first = await page(0)
        const album = this.#entity(first.albumUnion, 'Album', mapAlbum, `album ${nativeId}`)
        let tracks = album.tracks ?? []
        let onPage = albumTracksOnPage(first.albumUnion)
        const total = album.trackCount ?? 0
        for (
          let n = 1;
          onPage === ALBUM_PAGE && n * ALBUM_PAGE < total && n < ALBUM_MAX_PAGES;
          n++
        ) {
          const next = await page(n * ALBUM_PAGE)
          onPage = albumTracksOnPage(next.albumUnion)
          tracks = tracks.concat(mapAlbum(next.albumUnion)?.tracks ?? [])
        }
        return { ...album, tracks }
      },
      ctx.signal,
    )
  }

  /** Loads an artist: profile, biography, top tracks, releases and 20 related artists. */
  async getArtist(id: EntityId<'artist'>, ctx: ProviderContext): Promise<Artist> {
    this.#gate(ctx)
    const nativeId = spotifyIdOf(id, 'artist')
    return this.#cache.getOrLoad(
      `artist:${nativeId}`,
      this.#ttl.entity,
      async () => {
        const data = await this.#client.query(
          'queryArtistOverview',
          { uri: spotifyUri('artist', nativeId), locale: '', preReleaseV2: false },
          ctx,
        )
        return this.#entity(data.artistUnion, 'Artist', mapArtist, `artist ${nativeId}`)
      },
      ctx.signal,
    )
  }

  /** Lists up to 40 artists similar to one. */
  async getRelatedArtists(id: EntityId<'artist'>, ctx: ProviderContext): Promise<Artist[]> {
    this.#gate(ctx)
    const nativeId = spotifyIdOf(id, 'artist')
    return this.#cache.getOrLoad(
      `related:${nativeId}`,
      this.#ttl.entity,
      async () => {
        const data = await this.#client.query(
          'queryArtistRelated',
          { uri: spotifyUri('artist', nativeId) },
          ctx,
        )
        this.#entity(data.artistUnion, 'Artist', mapArtist, `artist ${nativeId}`)
        return mapRelatedArtists(data.artistUnion)
      },
      ctx.signal,
    )
  }

  /** Loads a playlist with its first 50 tracks. */
  async getPlaylist(id: EntityId<'playlist'>, ctx: ProviderContext): Promise<Playlist> {
    this.#gate(ctx)
    const nativeId = spotifyIdOf(id, 'playlist')
    const playlist = await this.#cache.getOrLoad(
      `playlist:${nativeId}`,
      this.#ttl.entity,
      () => this.#fetchPlaylist(nativeId, 0, PLAYLIST_PAGE, ctx),
      ctx.signal,
    )
    return playlist.tracks
      ? { ...playlist, tracks: filterTracks(playlist.tracks, ctx.mode) }
      : playlist
  }

  /** Loads a further page of a playlist's tracks (up to 100 per page; default 50). */
  async getPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>> {
    this.#gate(ctx)
    const nativeId = spotifyIdOf(id, 'playlist')
    const limit = clampLimit(options.limit, PLAYLIST_PAGE, 100)
    const offset = offsetOf(options.cursor)
    const page = await this.#cache.getOrLoad(
      `playlist-tracks:${nativeId}:${offset}:${limit}`,
      this.#ttl.entity,
      async () => {
        const playlist = await this.#fetchPlaylist(nativeId, offset, limit, ctx)
        return playlist.tracks ?? { items: [] }
      },
      ctx.signal,
    )
    return filterTracks(page, ctx.mode)
  }

  async #fetchPlaylist(
    nativeId: string,
    offset: number,
    limit: number,
    ctx: ProviderContext,
  ): Promise<Playlist> {
    const data = await this.#client.query(
      'fetchPlaylist',
      {
        uri: spotifyUri('playlist', nativeId),
        offset,
        limit,
        enableWatchFeedEntrypoint: false,
        includeEpisodeContentRatingsV2: false,
      },
      ctx,
    )
    return this.#entity(
      data.playlistV2,
      'Playlist',
      (value) => mapPlaylist(value, { offset, limit }),
      `playlist ${nativeId}`,
    )
  }

  // --- RecommendationProvider -----------------------------------------------------------

  /**
   * Spotify's radio for a track or an artist: the 50-track "… Radio" playlist Spotify makes for
   * the seed, without the seed track itself. A seed from another source uses its
   * `externalIds.spotify`, or is looked up by title and artist (see `lookupForeignSeeds`).
   */
  async radio(seed: RadioSeed, ctx: ProviderContext): Promise<Track[]> {
    this.#gate(ctx)
    const uri = await this.#seedUri(seed, ctx)
    const tracks = await this.#cache.getOrLoad(
      `radio:${uri}`,
      this.#ttl.radio,
      async () => {
        const answer = await this.#client.spclient(
          `/inspiredby-mix/v2/seed_to_playlist/${uri}?response-format=json`,
          ctx,
        )
        const playlistId = radioPlaylistId(answer)
        if (!playlistId) {
          throw new SpotifyError('NotFound', 'not-found', `Spotify has no radio for ${uri}`)
        }
        const playlist = await this.#fetchPlaylist(playlistId, 0, PLAYLIST_PAGE, ctx)
        return playlist.tracks?.items ?? []
      },
      ctx.signal,
    )
    // A Spotify track's FXM ID is spelled like its URI, so this drops the seed track.
    return applyModeFilter(
      tracks.filter((track) => track.id !== uri),
      ctx.mode,
    )
  }

  /**
   * Spotify's home feed as shelves: the personal one when the user is logged in (and the
   * platform has a login), else the generic one for the user's market.
   */
  async home(ctx: ProviderContext): Promise<Shelf[]> {
    this.#gate(ctx)
    const kind = await this.#homeTokenKind(ctx)
    const shelves = await this.#cache.getOrLoad(
      `home:${kind}`,
      this.#ttl.home,
      async () => {
        const data = await this.#client.query(
          'home',
          {
            includeHomeChapterVideoCards: false,
            homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
            timeZone: this.#timeZone(),
            sp_t: '',
            facet: '',
            sectionItemsLimit: 10,
            includeEpisodeContentRatingsV2: false,
          },
          ctx,
          kind,
        )
        return mapHome(this.#expectRecord(data.home, 'home'))
      },
      ctx.signal,
    )
    return shelves.map((shelf) => filterShelf(shelf, ctx.mode))
  }

  /**
   * One page of a home section (a shelf's `id`, `spotify:section:…`), for its "Show all" view.
   * Pages hold 20 items by default (at most 50).
   */
  async getHomeSection(
    sectionId: string,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<HomeSectionPage> {
    this.#gate(ctx)
    if (!/^spotify:section:[0-9A-Za-z]+$/u.test(sectionId)) {
      throw new SpotifyError('NotFound', 'not-found', `Not a Spotify home section: ${sectionId}`)
    }
    const limit = clampLimit(options.limit, 20, 50)
    const offset = offsetOf(options.cursor)
    const kind = await this.#homeTokenKind(ctx)
    const page = await this.#cache.getOrLoad(
      `home-section:${kind}:${sectionId}:${offset}:${limit}`,
      this.#ttl.home,
      async () => {
        const data = await this.#client.query(
          'homeSection',
          {
            includeHomeChapterVideoCards: false,
            uri: sectionId,
            homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
            timeZone: this.#timeZone(),
            sp_t: '',
            sectionItemsOffset: offset,
            sectionItemsLimit: limit,
            includeEpisodeContentRatingsV2: false,
          },
          ctx,
          kind,
        )
        const section = mapHomeSection(data.homeSections)
        if (!section) {
          throw new SpotifyError('NotFound', 'not-found', `Spotify has no section ${sectionId}`)
        }
        return section
      },
      ctx.signal,
    )
    return { ...page, shelf: filterShelf(page.shelf, ctx.mode) }
  }

  // --- AccountProvider ------------------------------------------------------------------

  /**
   * Whether the user is logged in to Spotify through this platform's login (FXM Connect's
   * bridge, a login window), with the account's display name when Spotify gives it. Without a
   * login source, or while Spotify is off or unreachable, it answers "not connected".
   */
  async status(ctx: ProviderContext): Promise<AccountStatus> {
    if (!this.#isEnabled() || !isSpotifyReachable(ctx) || !this.#tokens.hasSession(ctx)) {
      return { connected: false }
    }
    try {
      await this.#tokens.get('account', ctx)
    } catch (error) {
      if (isFxmError(error, 'AuthRequired') || isSpotifyError(error, 'account-unavailable')) {
        return { connected: false }
      }
      throw error
    }
    const displayName = await this.#displayName(ctx)
    return displayName === undefined ? { connected: true } : { connected: true, displayName }
  }

  async #displayName(ctx: ProviderContext): Promise<string | undefined> {
    try {
      return await this.#cache.getOrLoad(
        'profile',
        this.#ttl.entity,
        async () =>
          mapProfileName(await this.#client.query('profileAttributes', {}, ctx, 'account')),
        ctx.signal,
      )
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      return undefined
    }
  }

  // --- Library (logged in) --------------------------------------------------------------

  /**
   * One page of the user's liked songs (at most 50), newest first. Needs a login.
   *
   * Implemented from the request and field paths of Spotify's own web player; not yet checked
   * against a live logged-in session (stage 3.5 does).
   */
  async getLibraryTracks(options: PageOptions, ctx: ProviderContext): Promise<Page<Track>> {
    this.#gate(ctx)
    const limit = clampLimit(options.limit, 50, 50)
    const offset = offsetOf(options.cursor)
    const data = await this.#client.query('fetchLibraryTracks', { offset, limit }, ctx, 'account')
    const page = mapLibraryTracks(data, offset, limit)
    if (!page) throw new SpotifyError('Parse', 'bad-response', 'fetchLibraryTracks sent no tracks')
    return filterTracks(page, ctx.mode)
  }

  /**
   * One page of the playlists in the user's library (at most 50), folders flattened. Needs a
   * login. Like {@link SpotifyProvider.getLibraryTracks}, not yet checked against a live session.
   */
  async getLibraryPlaylists(options: PageOptions, ctx: ProviderContext): Promise<Page<Playlist>> {
    this.#gate(ctx)
    const limit = clampLimit(options.limit, 50, 50)
    const offset = offsetOf(options.cursor)
    const data = await this.#client.query(
      'libraryV3',
      {
        filters: ['Playlists'],
        order: null,
        textFilter: null,
        features: ['EVENTS'],
        limit,
        offset,
        flatten: true,
        folderUri: null,
        includeFoldersWhenFlattening: true,
      },
      ctx,
      'account',
    )
    const page = mapLibraryPlaylists(data, offset, limit)
    if (!page) throw new SpotifyError('Parse', 'bad-response', 'libraryV3 sent no library page')
    return page
  }

  // --- Track details (ISRC, label, release date) ----------------------------------------

  /**
   * The ISRC, label, release date and popularity of a Spotify track, from spclient. One request
   * per track, cached for a day: call it only for tracks being played, prefetched or imported.
   */
  async getTrackDetails(id: EntityId<'track'>, ctx: ProviderContext): Promise<SpotifyTrackDetails> {
    this.#gate(ctx)
    const nativeId = spotifyIdOf(id, 'track')
    return this.#cache.getOrLoad(
      `details:${nativeId}`,
      this.#ttl.details,
      async () =>
        mapTrackDetails(
          await this.#client.spclient(
            `/metadata/4/track/${base62ToHex(nativeId)}?market=from_token`,
            ctx,
          ),
        ),
      ctx.signal,
    )
  }

  /**
   * `track` with what {@link SpotifyProvider.getTrackDetails} adds and it lacks: the ISRC, the
   * release date and the popularity. A track of another source uses its `externalIds.spotify`;
   * one without a Spotify ID comes back unchanged.
   */
  async enrichTrack(track: Track, ctx: ProviderContext): Promise<Track> {
    const own = track.source === 'spotify' ? parseId(track.id)?.nativeId : undefined
    const nativeId = isSpotifyId(own) ? own : track.externalIds?.spotify
    if (!isSpotifyId(nativeId)) return track
    const details = await this.getTrackDetails(formatId('spotify', 'track', nativeId), ctx)
    return withDetails(track, details)
  }

  #withKnownDetails(track: Track): Track {
    const nativeId = track.id.slice('spotify:track:'.length)
    const details = this.#cache.get<SpotifyTrackDetails>(`details:${nativeId}`)
    return details ? withDetails(track, details) : track
  }

  // --- Helpers --------------------------------------------------------------------------

  #gate(ctx: ProviderContext): void {
    if (!this.#isEnabled()) {
      throw new SpotifyError('Unsupported', 'disabled', 'Spotify is switched off in the settings')
    }
    if (!isSpotifyReachable(ctx)) {
      throw new SpotifyError('Unsupported', 'unreachable', 'This platform cannot reach Spotify')
    }
  }

  /** The token the home feed uses: the account's when logged in, else anonymous. */
  async #homeTokenKind(ctx: ProviderContext): Promise<TokenKind> {
    if (!this.#tokens.hasSession(ctx)) return 'anonymous'
    try {
      await this.#tokens.get('account', ctx)
      return 'account'
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      return 'anonymous'
    }
  }

  /** The entity in a union field, or the typed error for what Spotify sent instead. */
  #entity<T>(
    union: unknown,
    typename: string,
    map: (value: unknown) => T | undefined,
    what: string,
  ): T {
    const found = unionOf(union, typename)
    if (!found.found) {
      if (found.typename === 'NotFound') {
        throw new SpotifyError('NotFound', 'not-found', `Spotify has no ${what}`)
      }
      throw new SpotifyError(
        'Unavailable',
        'graphql',
        `Spotify answered ${found.typename} for ${what}`,
      )
    }
    const entity = map(union)
    if (entity === undefined) {
      throw new SpotifyError('Parse', 'bad-response', `Spotify sent an unreadable ${what}`)
    }
    return entity
  }

  #expectRecord(value: unknown, operation: SpotifyOperationName): JsonRecord {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as JsonRecord
    }
    throw new SpotifyError('Parse', 'bad-response', `${operation} sent an unexpected answer`)
  }

  async #seedUri(seed: RadioSeed, ctx: ProviderContext): Promise<string> {
    if (isTrackSeed(seed)) {
      const own = seed.source === 'spotify' ? parseId(seed.id)?.nativeId : undefined
      if (isSpotifyId(own)) return spotifyUri('track', own)
      const external = seed.externalIds?.spotify
      if (isSpotifyId(external)) return spotifyUri('track', external)
      return spotifyUri('track', await this.#lookupTrack(seed, ctx))
    }
    const own = seed.id === undefined ? null : parseId(seed.id)
    if (own?.source === 'spotify' && own.kind === 'artist' && isSpotifyId(own.nativeId)) {
      return spotifyUri('artist', own.nativeId)
    }
    return spotifyUri('artist', await this.#lookupArtist(seed, ctx))
  }

  async #lookupTrack(seed: Track, ctx: ProviderContext): Promise<string> {
    const artist = seed.artists[0]?.name
    if (!this.#lookupForeignSeeds || artist === undefined) throw unsupportedSeed(seed.title)
    const title = titleCore(seed.title, artist)
    const results = await this.search(`${artist} ${title}`, { types: ['track'], limit: 5 }, ctx)
    const wantTitle = normalizeText(title)
    const wantArtist = normalizeText(artist)
    const hit = results.tracks?.items.find(
      (track) =>
        normalizeText(titleCore(track.title, track.artists[0]?.name ?? '')) === wantTitle &&
        track.artists.some((a) => normalizeText(a.name) === wantArtist),
    )
    if (!hit) throw unsupportedSeed(seed.title)
    return hit.id.slice('spotify:track:'.length)
  }

  async #lookupArtist(seed: ArtistRef, ctx: ProviderContext): Promise<string> {
    if (!this.#lookupForeignSeeds) throw unsupportedSeed(seed.name)
    const results = await this.search(seed.name, { types: ['artist'], limit: 5 }, ctx)
    const want = normalizeText(seed.name)
    const hit = results.artists?.items.find((artist) => normalizeText(artist.name) === want)
    if (!hit) throw unsupportedSeed(seed.name)
    return hit.id.slice('spotify:artist:'.length)
  }
}

function unsupportedSeed(name: string): SpotifyError {
  return new SpotifyError(
    'Unsupported',
    'unsupported-seed',
    `No Spotify track or artist matches the radio seed "${name}"`,
  )
}

function withDetails(track: Track, details: SpotifyTrackDetails): Track {
  return {
    ...track,
    ...(details.isrc !== undefined && track.isrc === undefined ? { isrc: details.isrc } : {}),
    ...(details.releaseDate !== undefined && track.releaseDate === undefined
      ? { releaseDate: details.releaseDate }
      : {}),
    ...(details.popularity !== undefined && track.popularity === undefined
      ? { popularity: details.popularity }
      : {}),
  }
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The entries of `options` named in `keys` that are set. */
function pick<T extends object, K extends keyof T>(
  options: T,
  keys: readonly K[],
): { [P in K]?: Exclude<T[P], undefined> } {
  const picked: { [P in K]?: Exclude<T[P], undefined> } = {}
  for (const key of keys) {
    const value = options[key]
    if (value !== undefined) picked[key] = value as Exclude<T[K], undefined>
  }
  return picked
}

/** Creates the Spotify provider. Create one per app and keep it: it holds tokens and caches. */
export function createSpotifyProvider(options: SpotifyProviderOptions = {}): SpotifyProvider {
  return new SpotifyProvider(options)
}
