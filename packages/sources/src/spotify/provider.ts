/**
 * The Spotify provider: metadata (search, tracks, albums, artists, related artists, playlists),
 * recommendations (track and artist radio, the home feed) and a minimal account status, read from
 * Spotify's web-player APIs on the user's own device through `ctx.fetch`.
 *
 * One instance holds the tokens, caches and pause state, so the app creates one and keeps it,
 * and applies settings and newer configs to it (`setSecretSources`, `setConfig`, `connect`,
 * `disconnect`). Every result is the caller's own copy: changing it never changes what the
 * provider has cached.
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
import {
  DEFAULT_SPOTIFY_CONFIG,
  parseSpotifyConfig,
  type SpotifyConfig,
  type SpotifyOperationName,
} from './config'
import { isSpotifyError, SpotifyError } from './errors'
import { SpotifyHttp } from './http'
import { isSpotifyId, spotifyIdOf, spotifyIdToGid, spotifyUri } from './ids'
import {
  albumTracksOnPage,
  mapAlbum,
  mapArtist,
  mapHome,
  mapHomeSection,
  mapLibraryPlaylists,
  mapLibraryTracks,
  mapPlaylist,
  mapProfile,
  mapRelatedArtists,
  mapSearch,
  mapTrack,
  mapTrackDetails,
  radioPlaylistId,
  revisionOf,
  type SpotifyAccountProfile,
  type SpotifyHomeSectionPage,
  type SpotifyLibraryPlaylist,
  type SpotifyLikedTrack,
  type SpotifyPlaylistPage,
  type SpotifySearchPages,
  type SpotifyTrackDetails,
  unionOf,
} from './mapping'
import { OperationRegistry } from './operations'
import {
  checkSpotifySecretSource,
  createSpotifySecretProvider,
  type SpotifySecretProvider,
  type SpotifySecretSource,
} from './secret'
import { isSpotifyReachable } from './settings'
import {
  type SessionTokenSource,
  type SpotifySecretPause,
  type TokenKind,
  TokenManager,
} from './token'

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
  /**
   * While minting is paused because of the TOTP secret: until when, and why. With
   * `secret-unavailable` no secret source could be read ("Spotify is paused: its secret source
   * can't be reached"); with `secret-rejected` Spotify refused every secret FXM found ("Spotify
   * is paused: its secret stopped working"). Offer to enter another source in either case.
   */
  secretPaused?: SpotifySecretPause
  /**
   * Spotify answered `403 Client/request not allowed`: it refuses this client, on native
   * transports its User-Agent. Calls keep failing until a newer config or app fixes it.
   */
  clientRejected?: true
  /** The operations Spotify rejected this session; they need a newer config. */
  brokenOperations: SpotifyOperationName[]
}

/** Options for {@link createSpotifyProvider}. All are optional. */
export interface SpotifyProviderOptions {
  /** The config: endpoints, secret sources, User-Agent and hashes. Default: the bundled one. */
  config?: SpotifyConfig
  /**
   * The user's switch, Settings → Spotify (e.g. `() => sanitizeSpotifySettings(stored).enabled`).
   * Wire it: the default, always on, ignores a stored `enabled: false`.
   */
  isEnabled?: () => boolean
  /** The source of logged-in tokens on this platform (the FXM Connect bridge, a login window). */
  session?: SessionTokenSource
  /**
   * Settings → Spotify → Connect your account: whether the user's own login may be used (e.g.
   * `() => sanitizeSpotifySettings(stored).account`). Default: never, so the account stays
   * unused until the app wires its opt-in.
   */
  isAccountEnabled?: () => boolean
  /** A custom secret provider. Default: one over `secretSources`. */
  secrets?: SpotifySecretProvider
  /**
   * The secret sources of the default secret provider, e.g. from Settings. Default: the config's
   * URLs. An invalid source makes the constructor throw a `TypeError`.
   */
  secretSources?: readonly SpotifySecretSource[]
  /**
   * The `fetch` the default secret provider uses for URLs. Default: `ctx.fetch`. The web app
   * passes one that goes through its sandboxed user-host document.
   */
  secretFetch?: ProviderContext['fetch']
  /** Whether to send the browser User-Agent. Default: on native transports only. */
  sendUserAgent?: (ctx: ProviderContext) => boolean
  /** Cache lifetimes, in milliseconds. Default {@link DEFAULT_SPOTIFY_CACHE_TTLS}. */
  cacheTtls?: Partial<SpotifyCacheTtls>
  /**
   * Whether a radio seed from another source without a Spotify ID may be looked up by its title
   * and artist (one Spotify search, which sends them to Spotify). Default true.
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
  /** Per-request timeout for Spotify. Default 15 s. The secret source has its own (5 s). */
  timeoutMs?: number
  /** Retries after a 429 or 5xx answer. Default 3. */
  maxRetries?: number
  /**
   * How long Spotify pauses after persistent 429 or 5xx answers, how long minting pauses after
   * the TOTP secret was refused, and the longest pause after failed secret loads. Default
   * 5 minutes.
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

/** The cache keys of answers that belong to the user's account. */
const PERSONAL_KEYS = ['home:account', 'home-section:account', 'profile']

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback
  return Math.min(max, Math.max(1, Math.floor(limit)))
}

/**
 * The offset in a cursor this provider returned (a decimal offset).
 *
 * @throws SpotifyError `bad-cursor` for anything else, e.g. a damaged cursor from storage.
 */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (typeof cursor !== 'string' || !/^\d{1,9}$/u.test(cursor)) {
    throw new SpotifyError('bad-cursor', 'Not a Spotify page cursor; load the first page again')
  }
  return Number(cursor)
}

function emptyPage<T>(): Page<T> {
  return { items: [] }
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

/** Whether a failure says the account cannot be used for this call. */
function isAccountFailure(error: unknown): boolean {
  return (
    isFxmError(error, 'AuthRequired') ||
    isSpotifyError(error, 'account-unsupported') ||
    isSpotifyError(error, 'account-disabled')
  )
}

/** Spotify, as a metadata, recommendation and account provider. */
export class SpotifyProvider implements MetadataProvider, RecommendationProvider, AccountProvider {
  /** The source this provider reads. */
  readonly id = 'spotify'

  #config: SpotifyConfig
  readonly #secrets: SpotifySecretProvider
  /** Whether the secret sources follow the config: none were given or set. */
  #defaultSecretSources: boolean
  readonly #http: SpotifyHttp
  readonly #tokens: TokenManager
  readonly #operations: OperationRegistry
  readonly #client: SpotifyClient
  readonly #cache: TtlCache
  readonly #ttl: SpotifyCacheTtls
  readonly #isEnabled: () => boolean
  readonly #isAccountEnabled: () => boolean
  readonly #lookupForeignSeeds: boolean
  readonly #timeZone: () => string
  readonly #onHealthChange: ((health: SpotifyHealth) => void) | undefined
  #disconnected = false
  #clientRejected = false

  /** @throws TypeError when `config` or a secret source is not valid. */
  constructor(options: SpotifyProviderOptions = {}) {
    const now = options.now ?? Date.now
    const notify = () => this.#notify()
    this.#config = options.config ? parseSpotifyConfig(options.config) : DEFAULT_SPOTIFY_CONFIG
    this.#onHealthChange = options.onHealthChange
    this.#isEnabled = options.isEnabled ?? (() => true)
    this.#isAccountEnabled = options.isAccountEnabled ?? (() => false)
    this.#lookupForeignSeeds = options.lookupForeignSeeds ?? true
    this.#timeZone = options.timeZone ?? defaultTimeZone
    this.#ttl = { ...DEFAULT_SPOTIFY_CACHE_TTLS, ...options.cacheTtls }
    this.#cache = new TtlCache({ now })
    this.#defaultSecretSources = options.secrets === undefined && !options.secretSources
    this.#secrets =
      options.secrets ??
      createSpotifySecretProvider({
        sources: options.secretSources ?? this.#configSecretSources(),
        now,
        ...(options.secretFetch ? { fetch: options.secretFetch } : {}),
      })
    this.#http = new SpotifyHttp({
      userAgent: () => this.#config.userAgent,
      now,
      onPause: notify,
      ...pick(options, ['sendUserAgent', 'sleep', 'random', 'timeoutMs', 'maxRetries', 'pauseMs']),
    })
    const markClientRejected = () => {
      if (this.#clientRejected) return
      this.#clientRejected = true
      notify()
    }
    this.#tokens = new TokenManager({
      config: () => this.#config,
      http: this.#http,
      secrets: this.#secrets,
      now,
      isAccountEnabled: () => !this.#disconnected && this.#isAccountEnabled(),
      onSecretPause: notify,
      onClientRejected: markClientRejected,
      onAccountChange: () => this.#clearPersonal(),
      ...(options.session ? { session: options.session } : {}),
      ...(options.pauseMs === undefined ? {} : { secretPauseMs: options.pauseMs }),
    })
    this.#operations = new OperationRegistry(this.#config, notify)
    this.#client = new SpotifyClient({
      config: () => this.#config,
      http: this.#http,
      tokens: this.#tokens,
      operations: this.#operations,
      onClientRejected: markClientRejected,
    })
  }

  // --- State ----------------------------------------------------------------------------

  /**
   * Whether FXM should use Spotify now: the user's switch (`isEnabled`) is on and the platform
   * can reach Spotify. Use it to decide whether to show Spotify results, radio and the source
   * switch; it agrees with the provider's own check on every call.
   */
  isAvailable(ctx: Pick<ProviderContext, 'capabilities'>): boolean {
    return this.#isEnabled() && isSpotifyReachable(ctx)
  }

  /** Pauses, a refused client and broken operations, for the UI ("Spotify is paused: …"). */
  health(): SpotifyHealth {
    const pausedUntil = this.#http.pausedUntil
    const secretPaused = this.#tokens.secretPause
    return {
      ...(pausedUntil === undefined ? {} : { pausedUntil }),
      ...(secretPaused === undefined ? {} : { secretPaused: { ...secretPaused } }),
      ...(this.#clientRejected ? { clientRejected: true as const } : {}),
      brokenOperations: this.#operations.broken(),
    }
  }

  /**
   * Ends both pauses early and forgets a refused client, e.g. when the user taps "Try again".
   * Broken operations stay broken (see {@link SpotifyProvider.resetOperations}).
   */
  resume(): void {
    this.#http.resume()
    this.#tokens.resumeSecret()
    this.#clientRejected = false
    this.#notify()
  }

  /**
   * Forgets which operations broke, so FXM calls them again, e.g. from a "Try again" button.
   * {@link SpotifyProvider.setConfig} already clears the marks of the operations whose hash it
   * changes.
   */
  resetOperations(): void {
    this.#operations.reset()
  }

  /**
   * Uses a newer config from now on, e.g. the result of `loadSpotifyConfig`: its endpoints,
   * User-Agent and hashes. Operations whose hash changed lose their broken mark. When the default
   * secret sources changed and the user set none of their own, the cached secret is dropped.
   * Tokens, caches and the pauses are kept; a refused client is forgotten, since a new
   * User-Agent may fix it.
   *
   * @throws TypeError when `config` is not valid (see `parseSpotifyConfig`).
   */
  setConfig(config: SpotifyConfig): void {
    const previous = this.#config
    const next = parseSpotifyConfig(config)
    this.#config = next
    this.#operations.setConfig(next)
    const sources = (c: SpotifyConfig) => c.secretSources.join('\n')
    if (this.#defaultSecretSources && sources(previous) !== sources(next)) {
      this.#secrets.setSources(this.#configSecretSources())
    }
    this.#clientRejected = false
    this.#notify()
  }

  /**
   * Uses other secret sources from now on, e.g. a URL or JSON from Settings (see
   * `parseSpotifySecretSource`), or the config's default sources when called without any, and
   * ends a secret pause. A pause after Spotify's rate limits stays: a new secret does not change
   * them.
   *
   * @throws TypeError when a source is not valid; nothing changes then.
   */
  setSecretSources(sources?: readonly SpotifySecretSource[]): void {
    const checked = sources ? sources.map(checkSpotifySecretSource) : this.#configSecretSources()
    this.#secrets.setSources(checked)
    this.#defaultSecretSources = sources === undefined
    this.#tokens.resumeSecret()
    this.#notify()
  }

  /**
   * Allows the account again after {@link SpotifyProvider.disconnect}, and forgets a remembered
   * logged-out answer, so the next call asks the login source at once. Call it when the user
   * turns Settings → Spotify → Connect your account on, and right after they logged in to
   * Spotify. `isAccountEnabled` must say yes too.
   */
  connect(): void {
    this.#disconnected = false
    this.#tokens.clear('account')
    this.#clearPersonal()
  }

  /**
   * Stops using the account at once (Settings → Spotify → Disconnect): forgets the account
   * token, the remembered login state and every personal answer, and refuses account calls with
   * `account-disabled` until {@link SpotifyProvider.connect}. Store the setting as off too, so
   * `isAccountEnabled` agrees after a restart.
   */
  disconnect(): void {
    this.#disconnected = true
    this.#tokens.clear('account')
    this.#clearPersonal()
  }

  #notify(): void {
    this.#onHealthChange?.(this.health())
  }

  #clearPersonal(): void {
    for (const key of PERSONAL_KEYS) this.#cache.clear(key)
  }

  #configSecretSources(): SpotifySecretSource[] {
    return this.#config.secretSources.map((url) => ({ url }))
  }

  // --- MetadataProvider -----------------------------------------------------------------

  /**
   * Searches Spotify, one page per requested type. Several types on a first page take one
   * `searchDesktop` call; a single type, a later page, or a `searchDesktop` that is broken or
   * missing from the config takes each type's own search. Spotify has no videos for FXM, so
   * `video` is always an empty page.
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
      const desktop =
        kinds.length > 1 && offset === 0 && this.#operations.isAvailable('searchDesktop')
      pages = desktop
        ? await this.#desktopSearch(kinds, term, limit, ctx)
        : await this.#typedSearches(kinds, term, offset, limit, ctx)
    }
    return {
      ...(types.has('track')
        ? { tracks: filterTracks(pages.tracks ?? emptyPage(), ctx.mode) }
        : {}),
      ...(types.has('video') ? { videos: emptyPage() } : {}),
      ...(types.has('album') ? { albums: pages.albums ?? emptyPage() } : {}),
      ...(types.has('artist') ? { artists: pages.artists ?? emptyPage() } : {}),
      ...(types.has('playlist') ? { playlists: pages.playlists ?? emptyPage() } : {}),
    }
  }

  async #desktopSearch(
    kinds: readonly SearchKind[],
    term: string,
    limit: number,
    ctx: ProviderContext,
  ): Promise<SpotifySearchPages> {
    try {
      return await this.#cache.getOrLoad(
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
    } catch (error) {
      // Spotify rejected searchDesktop (or the config lacks it): the typed searches still work.
      if (
        isSpotifyError(error, 'operation-broken') ||
        isSpotifyError(error, 'operation-unsupported')
      ) {
        return this.#typedSearches(kinds, term, 0, limit, ctx)
      }
      throw error
    }
  }

  async #typedSearches(
    kinds: readonly SearchKind[],
    term: string,
    offset: number,
    limit: number,
    ctx: ProviderContext,
  ): Promise<SpotifySearchPages> {
    const parts = await Promise.all(
      kinds.map((kind) => this.#typedSearch(kind, term, offset, limit, ctx)),
    )
    return Object.assign({}, ...parts) as SpotifySearchPages
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
        return playlist.tracks ?? emptyPage<Track>()
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
        if (!playlistId) throw new SpotifyError('not-found', `Spotify has no radio for ${uri}`)
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
   * Spotify's home feed as shelves: the personal one when the account is connected and logged
   * in, else the generic one for the user's market.
   */
  async home(ctx: ProviderContext): Promise<Shelf[]> {
    this.#gate(ctx)
    const shelves = await this.#withHomeToken(ctx, (kind) => this.#loadHome(kind, ctx))
    return shelves.map((shelf) => filterShelf(shelf, ctx.mode))
  }

  /**
   * The connected account's personal home feed, never the generic one: unlike
   * {@link SpotifyProvider.home}, it fails like the other account calls when the account can't
   * be used (`account-unsupported`, `account-disabled`, `login-required`). A sync stores it as
   * the user's own. Cached like the home feed, with the personal answers.
   */
  async getAccountHome(ctx: ProviderContext): Promise<Shelf[]> {
    this.#gate(ctx)
    // The token first: a new account token drops the personal answers, a load in flight too.
    await this.#tokens.get('account', ctx)
    const shelves = await this.#loadHome('account', ctx)
    return shelves.map((shelf) => filterShelf(shelf, ctx.mode))
  }

  #loadHome(kind: TokenKind, ctx: ProviderContext): Promise<Shelf[]> {
    return this.#cache.getOrLoad(
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
  }

  /**
   * One page of a home section (a shelf's `id`, `spotify:section:…`), for its "Show all" view.
   * Pages hold 20 items by default (at most 50).
   *
   * @throws SpotifyError `foreign-id` for an ID that is not a Spotify section, `not-found` for a
   * malformed one or a section Spotify does not have, `bad-cursor` for a cursor it did not make.
   */
  async getHomeSection(
    sectionId: string,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<SpotifyHomeSectionPage> {
    this.#gate(ctx)
    if (typeof sectionId !== 'string' || !sectionId.startsWith('spotify:section:')) {
      throw new SpotifyError('foreign-id', `Not a Spotify home section: ${String(sectionId)}`)
    }
    if (!/^spotify:section:[0-9A-Za-z]+$/u.test(sectionId)) {
      throw new SpotifyError('not-found', `Malformed Spotify home section: ${sectionId}`)
    }
    const limit = clampLimit(options.limit, 20, 50)
    const offset = offsetOf(options.cursor)
    const page = await this.#withHomeToken(ctx, (kind) =>
      this.#cache.getOrLoad(
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
          if (!section) throw new SpotifyError('not-found', `Spotify has no section ${sectionId}`)
          return section
        },
        ctx.signal,
      ),
    )
    return { ...page, shelf: filterShelf(page.shelf, ctx.mode) }
  }

  // --- AccountProvider ------------------------------------------------------------------

  /**
   * Whether the user is logged in to Spotify through this platform's login (FXM Connect's
   * bridge, a login window), with the account's display name when Spotify gives it. While
   * Spotify is off or unreachable, the platform has no login source, or the account is not
   * connected in FXM (`isAccountEnabled`, `disconnect`), it answers "not connected" without a
   * request.
   */
  async status(ctx: ProviderContext): Promise<AccountStatus> {
    if (!this.isAvailable(ctx) || !this.#tokens.canUseAccount(ctx)) return { connected: false }
    try {
      await this.#tokens.get('account', ctx)
    } catch (error) {
      if (!ctx.signal?.aborted && isAccountFailure(error)) return { connected: false }
      throw error
    }
    const displayName = await this.#displayName(ctx)
    return displayName === undefined ? { connected: true } : { connected: true, displayName }
  }

  async #displayName(ctx: ProviderContext): Promise<string | undefined> {
    try {
      return (await this.getAccountProfile(ctx)).displayName
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      return undefined
    }
  }

  /**
   * Who is logged in: the account's user name, which never changes, and its display name. Needs
   * a connected account; without one it fails before any request. Cached like an entity, and
   * forgotten whenever the account token changes, so another account never gets this one's.
   *
   * @throws SpotifyError `bad-response` when Spotify sends no profile.
   */
  async getAccountProfile(ctx: ProviderContext): Promise<SpotifyAccountProfile> {
    this.#gate(ctx)
    // The token first: a new account token drops the personal answers, a profile load in flight
    // included, which would then be asked for twice.
    await this.#tokens.get('account', ctx)
    return this.#cache.getOrLoad(
      'profile',
      this.#ttl.entity,
      async () => {
        const profile = mapProfile(
          await this.#client.query('profileAttributes', {}, ctx, 'account'),
        )
        if (!profile) throw new SpotifyError('bad-response', 'profileAttributes sent no profile')
        return profile
      },
      ctx.signal,
    )
  }

  // --- Library (logged in) --------------------------------------------------------------

  /**
   * One page of the user's liked songs (at most 50), newest first, each with when it was liked.
   * Needs a connected account; without one it fails before any request. Never cached: a sync
   * wants what Spotify holds now.
   *
   * @experimental The request and field paths follow Spotify's own web player, rechecked on
   * 2026-10-26 (see the clean-room log), but no live logged-in session has confirmed them yet.
   */
  async getLibraryTracks(
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<SpotifyLikedTrack>> {
    this.#gate(ctx)
    const limit = clampLimit(options.limit, 50, 50)
    const offset = offsetOf(options.cursor)
    const data = await this.#client.query('fetchLibraryTracks', { offset, limit }, ctx, 'account')
    const page = mapLibraryTracks(data, offset, limit)
    if (!page) throw new SpotifyError('bad-response', 'fetchLibraryTracks sent no tracks')
    const items = page.items.filter((liked) => applyModeFilter([liked.track], ctx.mode).length > 0)
    return { ...page, items }
  }

  /**
   * One page of the playlists in the user's library (at most 50), folders flattened, each with
   * its revision, which tells a sync whether the playlist changed since it last read it.
   * Playlists Spotify's own player can't show (no revision, or not viewable) are left out.
   * Needs a connected account; without one it fails before any request. Never cached.
   *
   * @experimental Like {@link SpotifyProvider.getLibraryTracks}.
   */
  async getLibraryPlaylists(
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<SpotifyLibraryPlaylist>> {
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
    if (!page) throw new SpotifyError('bad-response', 'libraryV3 sent no library page')
    return page
  }

  /**
   * One page of a playlist's tracks (up to 100 per page; default 100), read with the user's
   * account, so the user's private, collaborative and personal ("Made for you") playlists can be
   * read too, with the playlist's revision. Needs a connected account; without one it fails
   * before any request. Never cached. Unlike {@link SpotifyProvider.getPlaylistTracks}, it keeps
   * every track, whatever the catalog mode: Spotify's tracks are all songs.
   *
   * @experimental Like {@link SpotifyProvider.getLibraryTracks}; `fetchPlaylist` itself is
   * confirmed anonymously.
   */
  async getLibraryPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<SpotifyPlaylistPage> {
    this.#gate(ctx)
    const nativeId = spotifyIdOf(id, 'playlist')
    const limit = clampLimit(options.limit, 100, 100)
    const offset = offsetOf(options.cursor)
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
      'account',
    )
    const playlist = this.#entity(
      data.playlistV2,
      'Playlist',
      (value) => mapPlaylist(value, { offset, limit }),
      `playlist ${nativeId}`,
    )
    const revisionId = revisionOf((data.playlistV2 as JsonRecord).revisionId)
    const tracks = playlist.tracks ?? emptyPage<Track>()
    return revisionId === undefined ? { tracks } : { tracks, revisionId }
  }

  // --- Track details (ISRC, label, release date) ----------------------------------------

  /**
   * The ISRC, label, release date, album type and popularity of a Spotify track, from spclient.
   * One request per track, cached for a day: call it only for tracks being played, prefetched or
   * imported. The matching engine reads them alongside the track:
   * `{ ...track, ...(await spotify.getTrackDetails(track.id, ctx)) }`.
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
            `/metadata/4/track/${spotifyIdToGid(nativeId)}?market=from_token`,
            ctx,
          ),
        ),
      ctx.signal,
    )
  }

  /**
   * `track` with what {@link SpotifyProvider.getTrackDetails} adds and it lacks. A Spotify track
   * gets the ISRC, the release date and the popularity. A track of another source, found through
   * its `externalIds.spotify`, gets only the ISRC: that names the recording, while the release
   * date and popularity belong to the release Spotify lists it on, which may not be the
   * compilation or remaster the other source has. A track without a Spotify ID comes back
   * unchanged.
   */
  async enrichTrack(track: Track, ctx: ProviderContext): Promise<Track> {
    const own = track.source === 'spotify' ? parseId(track.id)?.nativeId : undefined
    const ownId = isSpotifyId(own)
    const nativeId = ownId ? own : track.externalIds?.spotify
    if (!isSpotifyId(nativeId)) return track
    const details = await this.getTrackDetails(formatId('spotify', 'track', nativeId), ctx)
    return withDetails(track, details, ownId)
  }

  #withKnownDetails(track: Track): Track {
    const nativeId = track.id.slice('spotify:track:'.length)
    const details = this.#cache.get<SpotifyTrackDetails>(`details:${nativeId}`)
    return details ? withDetails(track, details, true) : track
  }

  // --- Helpers --------------------------------------------------------------------------

  #gate(ctx: ProviderContext): void {
    if (!this.#isEnabled()) {
      throw new SpotifyError('disabled', 'Spotify is switched off in the settings')
    }
    if (!isSpotifyReachable(ctx)) {
      throw new SpotifyError('unreachable', 'This platform cannot reach Spotify')
    }
  }

  /**
   * Runs a home call with the account's token when the account is connected and logged in,
   * else anonymously, also when the account turns out to be unusable during the call.
   */
  async #withHomeToken<T>(ctx: ProviderContext, load: (kind: TokenKind) => Promise<T>): Promise<T> {
    if (!this.#tokens.canUseAccount(ctx)) return load('anonymous')
    try {
      await this.#tokens.get('account', ctx)
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      return load('anonymous')
    }
    try {
      return await load('account')
    } catch (error) {
      if (ctx.signal?.aborted || !isAccountFailure(error)) throw error
      return load('anonymous')
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
        throw new SpotifyError('not-found', `Spotify has no ${what}`)
      }
      throw new SpotifyError('graphql', `Spotify answered ${found.typename} for ${what}`)
    }
    const entity = map(union)
    if (entity === undefined) {
      throw new SpotifyError('bad-response', `Spotify sent an unreadable ${what}`)
    }
    return entity
  }

  #expectRecord(value: unknown, operation: SpotifyOperationName): JsonRecord {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as JsonRecord
    }
    throw new SpotifyError('bad-response', `${operation} sent an unexpected answer`)
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
    'unsupported-seed',
    `No Spotify track or artist matches the radio seed "${name}"`,
  )
}

/**
 * `track` with the details it lacks: always the ISRC (a property of the recording); the release
 * date and popularity only when `release` says the details describe the track's own release.
 */
function withDetails(track: Track, details: SpotifyTrackDetails, release: boolean): Track {
  return {
    ...track,
    ...(details.isrc !== undefined && track.isrc === undefined ? { isrc: details.isrc } : {}),
    ...(release && details.releaseDate !== undefined && track.releaseDate === undefined
      ? { releaseDate: details.releaseDate }
      : {}),
    ...(release && details.popularity !== undefined && track.popularity === undefined
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

/**
 * Creates the Spotify provider. Create one per app and keep it: it holds tokens and caches.
 *
 * @throws TypeError when `options.config` or a secret source is not valid.
 */
export function createSpotifyProvider(options: SpotifyProviderOptions = {}): SpotifyProvider {
  return new SpotifyProvider(options)
}
