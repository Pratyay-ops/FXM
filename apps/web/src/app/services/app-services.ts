/**
 * The composition root (stage 2.9): the one place where the web app builds the real pieces of
 * the earlier stages and plugs them into the seams the pages use. Everything runs on the user's
 * device; FXM has no servers.
 *
 * | Piece | Stage | Built here as |
 * |---|---|---|
 * | Platform: transports, capabilities, request budget | 1.2 | `createPlatform`, injectable |
 * | YouTube session and providers, loaded lazily | 1.3 | `youtube.ts`, visitorData in IndexedDB |
 * | YouTube audio source, on the real budget | 1.4 | `youtube.ts`, the `ytm` stream source |
 * | Spotify, behind the Spotify switch | 1.5 | a lazy provider, where its secret is reachable |
 * | Internet Archive, Jamendo, MusicBrainz | 1.6 | lazy providers and stream sources |
 * | Matching engine | 1.7 | `matcher.ts` |
 * | Lyrics | 1.8 | `lyrics()`, for Now playing |
 * | Player | 2.2 | `connectPlayer(player)` |
 * | Playback policy and stream lifecycle | 2.3 | `lifecycle`, `policy` (2.5's interface) |
 * | Search and browse seams | 2.4 | the sources registry and the actions store |
 * | Library seams | 2.6 | `library.ts`, over the repository passed in (`getLibrary()`) |
 * | Audio quality | 4.3 | the lifecycle's `qualityPrefs` and `streaming`, from Settings |
 * | Matching options | 1.12 | `matchOptions`: `matchingOptions` with Settings' Auto setting |
 * | Offline copies | 4.1, 4.4 | the lifecycle's `offline`: downloads, then local files by ISRC |
 * | Signed YouTube config (and module) | 1.13 | `updates`, once YouTube's code has loaded |
 *
 * **Tiers.** The platform decides: Full with FXM Connect (or in the desktop and Android apps,
 * through their native HTTP), Lite with the sandbox documents of stage 1.10 (`sandbox`), Free
 * only otherwise. The pages read the tier from the sources registry, and every provider call gets
 * a context with the current capabilities, so nothing here branches on it. The one exception is
 * Spotify, which is registered only where its secret can be fetched (see `canReadSpotify`).
 *
 * **Testable.** Every outside dependency is an option: tests pass a platform built on a fake
 * network, their own registry and actions store, and memory storage.
 *
 * @module
 */

import {
  type AudioSource,
  type CatalogMode,
  DEFAULT_PLAYBACK_SETTINGS,
  type LyricsProvider,
  type MatchOptions,
  type MetadataProvider,
  type PlaybackSettings,
  type ProviderContext,
  type SourceId,
  type StreamOption,
} from '@fxm/core'
import {
  createKillSwitchStore,
  createPlatform,
  type FxmPlatform,
  type PlatformOptions,
  type RequestPriority,
  type SandboxTransport,
} from '@fxm/platform'
import {
  createBrowserNetworkMonitor,
  createMemoryMatchStore,
  type MatchStore,
  type NetworkMonitor,
  type OfflineStore,
  type Player,
  StreamLifecycle,
  type StreamLifecycleOptions,
  type StreamResolver,
  type StreamSource,
  type TrackMatcher,
} from '@fxm/player'
import type { MusicBrainzLookups } from '@fxm/sources/musicbrainz'
import type { SpotifyProvider } from '@fxm/sources/spotify'
import { liveQuery } from 'dexie'
import { getLocalFiles } from '../../features/local-files/local-files'
import { createLocalMetadataProvider } from '../../features/local-files/provider'
import {
  appActions,
  type MediaActions,
  type MediaActionsStore,
  playbackFromPlayer,
} from '../../features/search/actions'
import type { Sources } from '../../features/search/sources'
import { appSources } from '../../features/search/sources-context'
import { appMatchOptions } from '../../features/settings/matching-store'
import { lifecycleQualityOptions } from '../../features/settings/quality-store'
import { useSettingsStore } from '../../features/settings/settings-store'
import { secretFetchFor } from '../../features/spotify-account/secret-fetch'
import { spotifyAccountOptedIn } from '../../features/spotify-account/start'
import { buildJamendoClientId } from '../../lib/free-sources'
import { createIndexedDbStore, type DeviceStore } from './device-store'
import { createLoader, type Loader, lazyProvider } from './lazy-provider'
import {
  type LibraryRepository,
  libraryActionsFrom,
  matchStoreFrom,
  withEffectiveBands,
} from './library'
import { appOfflineStore } from './offline'
import { type AppPlaybackPolicy, createAppPlaybackPolicy } from './policy'
import {
  createYouTubeLoader,
  keepYouTubeCurrentLater,
  platformStreamBudget,
  type YouTube,
  type YouTubeHostModule,
  type YouTubeModule,
  youtubeStreamSource,
} from './youtube'

/** Options for {@link createAppServices}. Every one has a default that suits the app. */
export interface AppServicesOptions {
  /**
   * Creates the platform (stage 1.2) from the app's options. Default: `createPlatform`, which
   * detects the environment and, in the desktop and Android apps, picks their native HTTP
   * (stages 7.2 and 6.2). Tests pass one over a fake network.
   */
  readonly createPlatform?: (options: PlatformOptions) => Promise<FxmPlatform>
  /** The sources registry the pages read. Default: the app's (`appSources`). */
  readonly sources?: Sources
  /** The actions the catalog pages offer. Default: the app's (`appActions`). */
  readonly actions?: MediaActionsStore
  /** Where the visitorData and the rung health are kept. Default: IndexedDB. */
  readonly deviceStore?: DeviceStore
  /** The Lite tier's sandbox documents (stage 1.10). Without them there is no Lite tier. */
  readonly sandbox?: SandboxTransport
  /**
   * The library (stage 2.6, `getLibrary()`): playlists for "Add to playlist" and the match
   * cache. Without it, decisions are kept in memory and "Add to playlist" is not offered.
   */
  readonly library?: LibraryRepository
  /**
   * Jamendo's public `client_id`, from the build (`VITE_FXM_JAMENDO_CLIENT_ID`). Without one,
   * Jamendo is not offered: its API refuses every call.
   */
  readonly jamendoClientId?: string | undefined
  /**
   * The options a match in `mode` runs with (stage 1.12): `matchingOptions` with the matching
   * config's thresholds and measured fallback, and the user's Auto setting where the config makes
   * the band available. Default: the app's (`appMatchOptions`, from Settings).
   */
  readonly matchOptions?: (mode: CatalogMode) => MatchOptions
  /**
   * Where offline copies come from, which play before anything is resolved: the downloads of
   * stage 4.1, then the user's own files tagged with the track's ISRC (stage 4.4). Default: the
   * app's (`appOfflineStore()`, which loads the downloads with the first resolution);
   * `undefined` for none.
   */
  readonly offline?: OfflineStore | undefined
  /**
   * How long before a URL expires it is resolved again: the desktop app keeps an hour (stage
   * 7.3, `DESKTOP_URL_REFRESH_MARGIN_MS`). Default: the lifecycle's 10 minutes.
   */
  readonly refreshBeforeExpiryMs?: number
  /**
   * Whether the platform reaches hosts the user added (the Spotify secret's) in a browser: the
   * app's platform does, through the sandbox's user-host document (stage 1.10). Spotify is
   * registered in a browser only then. Default: whether `sandbox` has that document.
   */
  readonly reachesUserHosts?: boolean
  /**
   * The user's own music files as a catalog (stage 4.4, source `local`, "This device"): search
   * and its album and artist pages read it like any other source, while the user has added any
   * ({@link AppServicesOptions.watchLocalFiles}). Default: the app's
   * (`createLocalMetadataProvider()`); `undefined` for none.
   */
  readonly localProvider?: MetadataProvider | undefined
  /**
   * Calls `listener` with whether the user has added music files (a folder, or files chosen),
   * now and whenever that changes; returns a function that stops it. The local catalog is
   * registered only meanwhile, so search offers "This device" only to users with music on it.
   * Default: a live query of the local files' folders (`watchLocalFiles`).
   */
  readonly watchLocalFiles?: (listener: (present: boolean) => void) => () => void
  /**
   * Keeps the YouTube config current from FXM's site, and in the desktop and Android apps the
   * resolver module too (stage 1.13), once YouTube's code has loaded: the config's kill switches
   * follow. Default: `keepYouTubeCurrent` (`updates.ts`), loaded only then
   * ({@link keepYouTubeCurrentLater}); `false` for none (tests).
   */
  readonly updates?: ((youtube: YouTube) => void) | false
  /** The catalog mode. Default: the settings'. */
  readonly catalogMode?: () => CatalogMode
  /**
   * The network monitor of the stream lifecycle. Default: the browser's events, which
   * `dispose()` stops following.
   */
  readonly network?: NetworkMonitor
  /**
   * The audio quality settings (stage 4.3): the tier ceilings and which connection's applies.
   * Default: the app's, from Settings (`lifecycleQualityOptions()`), read for every stream.
   */
  readonly quality?: Pick<StreamLifecycleOptions, 'qualityPrefs' | 'streaming'>
  /**
   * Whether the user connected their Spotify account (stage 3.5's opt-in): the Spotify
   * provider's `isAccountEnabled`. Default: the app's choice (`spotifyAccountOptedIn`).
   */
  readonly spotifyAccount?: () => boolean
  /** Imports `@fxm/sources/youtube`. Default: `import()`; tests pass one they control. */
  readonly importYouTube?: () => Promise<YouTubeModule>
  /** Imports `@fxm/sources/youtube/module`. Default: `import()`; tests pass one they control. */
  readonly importYouTubeHost?: () => Promise<YouTubeHostModule>
  /**
   * Called once YouTube's code has loaded, with its session, config and stream ladder: the app
   * shares them with stage 2.7 (the config's kill switches, the Diagnostics self-test).
   */
  readonly onYouTube?: (youtube: YouTube) => void
}

/** What one provider call's context is built from (see {@link AppServices.context}). */
export interface AppContextOptions {
  /** What the call is for, for the request budget. */
  readonly priority: RequestPriority
  /** The catalog mode. Default: the current one. */
  readonly mode?: CatalogMode
  /** Cancels the call. */
  readonly signal?: AbortSignal
}

/** The app's services: see the module documentation. */
export interface AppServices {
  /** The sources registry the pages read: providers, tier and the Spotify switch. */
  readonly sources: Sources
  /** The stream lifecycle (stage 2.3). */
  readonly lifecycle: StreamLifecycle
  /**
   * The resolver for the app's player: the lifecycle, once the platform is ready. A player can
   * use it before {@link AppServices.start} finished: its first resolution waits for the platform.
   */
  readonly resolver: StreamResolver
  /** The playback policy as stage 2.5's player and Now playing use it. */
  readonly policy: AppPlaybackPolicy
  /** YouTube, loaded on first use. */
  readonly youtube: Loader<YouTube>
  /**
   * Spotify (stage 1.5), loaded on first use: the one provider of the app, which follows the
   * Spotify switch. Ask {@link AppServices.spotifyAvailable} before using it. Stage 3.5's account
   * feature uses it too, where it is registered, so its `isAccountEnabled` is the account's opt-in.
   */
  readonly spotify: Loader<SpotifyProvider>
  /** MusicBrainz (stage 1.6), loaded on first use. */
  readonly musicBrainz: Loader<MusicBrainzLookups>
  /**
   * Whether Spotify may be asked in a call with `ctx`: registered here (its secret can be
   * fetched), switched on and reachable. Its code isn't downloaded to find out.
   */
  spotifyAvailable(ctx: Pick<ProviderContext, 'capabilities'>): boolean
  /**
   * The stream sources the lifecycle resolves with: the YouTube ladder (`ytm`), Internet Archive
   * and, where set up, Jamendo. Downloads resolve with the same ones (stage 4.1).
   */
  readonly streamSources: readonly StreamSource[]
  /** The matching engine with its searches (stage 1.7). */
  readonly matcher: TrackMatcher
  /** The match cache (stage 2.6), with the Auto setting applied to what it reads. */
  readonly matches: MatchStore
  /** The playback settings the lifecycle reads: "prefer lossless", "Play best guesses". */
  playbackSettings(): PlaybackSettings
  /** The options a match in `mode` runs with (see {@link AppServicesOptions.matchOptions}). */
  matchOptions(mode: CatalogMode): MatchOptions
  /** The current catalog mode. */
  catalogMode(): CatalogMode
  /** The platform, once {@link AppServices.start} created it. */
  readonly platform: FxmPlatform | undefined
  /**
   * A context for one provider call, with the platform's `fetch` at `priority`. It comes from
   * the sources registry, like the pages' contexts, so search and playback ask YouTube with the
   * same language and region (none: YouTube's defaults and the region of the IP address).
   */
  context(options: AppContextOptions): ProviderContext
  /** The lyrics provider (stage 1.8), loaded on first use. Call it with {@link context}. */
  lyrics(): Promise<LyricsProvider>
  /**
   * Connects the app's player: the lifecycle follows it (prefetching, Smart Replace), the ladder
   * learns which URLs started playing, and the catalog pages' play buttons drive it. Returns a
   * function that disconnects it, which leaves a player connected after it alone.
   */
  connectPlayer(player: Player): () => void
  /**
   * Creates the platform, then registers the providers and the library's actions. Resolves with
   * the platform, or `undefined` when it could not be created (the app then stays in the Free
   * tier's stand-in, which reaches nothing). Safe to call more than once.
   */
  start(): Promise<FxmPlatform | undefined>
  /** Stops everything: the lifecycle, the platform's watchers and the registrations. */
  dispose(): void
}

/**
 * Whether the user has added music files (stage 4.4: a folder, or files chosen), as a live query
 * of the local files' folders, kept current across tabs. A database the browser blocks has none.
 */
export function watchLocalFiles(listener: (present: boolean) => void): () => void {
  const subscription = liveQuery(
    async () => (await getLocalFiles().repo.listRoots()).length > 0,
  ).subscribe({ next: listener, error: () => listener(false) })
  return () => subscription.unsubscribe()
}

/** A stream source for a plain audio source that loads on first use (2.3's `fromAudioSource`). */
function lazyStreamSource(id: SourceId, source: Loader<AudioSource>): StreamSource {
  return {
    id,
    resolve: async (candidate, { ctx, prefs, signal }) =>
      (await source.load()).resolve(candidate, { ...ctx, signal }, prefs),
  }
}

/** `actions` without its playback group. */
function withoutPlayback({ playback: _playback, ...rest }: MediaActions): MediaActions {
  return rest
}

/** `actions` without its library group. */
function withoutLibrary({ library: _library, ...rest }: MediaActions): MediaActions {
  return rest
}

/** A loader of what `loader` loads, passed through `map`. */
function mapLoader<T, U>(loader: Loader<T>, map: (value: T) => U): Loader<U> {
  return {
    load: async () => map(await loader.load()),
    get current() {
      const value = loader.current
      return value === undefined ? undefined : map(value)
    },
  }
}

/** Creates the app's services. Nothing is fetched or imported until they are used. */
export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const sources = options.sources ?? appSources
  const actions = options.actions ?? appActions
  const store = options.deviceStore ?? createIndexedDbStore()
  const catalogMode = options.catalogMode ?? (() => useSettingsStore.getState().catalogMode)
  const matchOptions = options.matchOptions ?? ((mode: CatalogMode) => appMatchOptions(mode))
  const ownNetwork = options.network === undefined ? createBrowserNetworkMonitor() : undefined
  const network = options.network ?? (ownNetwork as NetworkMonitor)
  const jamendoClientId =
    'jamendoClientId' in options ? options.jamendoClientId : buildJamendoClientId()
  const offline = 'offline' in options ? options.offline : appOfflineStore()
  const localProvider =
    'localProvider' in options ? options.localProvider : createLocalMetadataProvider()
  const updates = options.updates === undefined ? keepYouTubeCurrentLater : options.updates
  const reachesUserHosts = options.reachesUserHosts ?? options.sandbox?.userHost !== undefined
  // With a Lite tier, its self-test is a request to YouTube that the YouTube config's kill
  // switch may forbid: the tier waits, switched off, until that config has loaded.
  const killSwitches = createKillSwitchStore(options.sandbox === undefined ? {} : { lite: true })
  const playback: PlaybackSettings = { ...DEFAULT_PLAYBACK_SETTINGS }
  let platform: FxmPlatform | undefined
  let started: Promise<FxmPlatform | undefined> | undefined
  let disposed = false
  /** Whether Spotify is registered: only where its secret can be fetched. */
  let spotifyRegistered = false
  const unregister: (() => void)[] = []
  const report = (error: unknown) => {
    platform?.report(error)
  }

  function context({ priority, mode = catalogMode(), signal }: AppContextOptions) {
    return sources.context({ mode, priority, ...(signal === undefined ? {} : { signal }) })
  }

  const youtube = createYouTubeLoader({
    store,
    budget: platformStreamBudget(() => platform?.budget),
    ...(options.importYouTube === undefined ? {} : { importModule: options.importYouTube }),
    ...(options.importYouTubeHost === undefined ? {} : { importHost: options.importYouTubeHost }),
    // The config's kill switches, the Lite tier's included (stage 1.10), from the config in use:
    // the bundled one, or a newer signed one from FXM's site (stage 1.13).
    onLoad: (loaded) => {
      killSwitches.set(loaded.killSwitches())
      unregister.push(loaded.subscribe(() => killSwitches.set(loaded.killSwitches())))
      options.onYouTube?.(loaded)
      if (updates !== false && !disposed) updates(loaded)
    },
  })
  /** Hosts outside the platform's table that FXM may fetch from: the Spotify secret's. */
  let userHosts: readonly string[] = []
  const spotify = createLoader(
    'Spotify',
    () => import('@fxm/sources/spotify'),
    ({ createSpotifyProvider, SPOTIFY_SECRET_SOURCE_HOSTS }) => {
      // Only Spotify fetches from them, so they are known before the first such fetch.
      userHosts = SPOTIFY_SECRET_SOURCE_HOSTS
      const session = platform?.spotifySession
      // In a browser the secret goes through the sandbox's user-host document: the services'
      // own, or the platform's (stage 2.7's, which the app passes in without its options).
      const secretFetch =
        platform === undefined
          ? undefined
          : secretFetchFor(platform, SPOTIFY_SECRET_SOURCE_HOSTS, options.sandbox)
      return createSpotifyProvider({
        isEnabled: () => sources.getSnapshot().spotifyEnabled,
        isAccountEnabled: options.spotifyAccount ?? spotifyAccountOptedIn,
        ...(session === undefined ? {} : { session }),
        ...(secretFetch === undefined ? {} : { secretFetch }),
      })
    },
  )
  const archive = createLoader(
    'Internet Archive',
    () => import('@fxm/sources/archive'),
    ({ createArchiveSource }) => createArchiveSource(),
  )
  const jamendo =
    jamendoClientId === undefined
      ? undefined
      : createLoader(
          'Jamendo',
          () => import('@fxm/sources/jamendo'),
          ({ createJamendoSource }) =>
            createJamendoSource({
              publicClientId: jamendoClientId,
              preferLossless: () => playback.preferLossless,
            }),
        )
  const musicBrainz = createLoader(
    'MusicBrainz',
    () => import('@fxm/sources/musicbrainz'),
    (module) => ({ module, client: module.createMusicBrainzClient() }),
  )
  const lrclib = createLoader(
    'LRCLIB',
    () => import('@fxm/sources/lrclib'),
    ({ createLrclibProvider }): LyricsProvider => createLrclibProvider(),
  )

  /**
   * Whether Spotify may be asked in this call: Spotify is registered here, switched on and
   * reachable. Otherwise its code isn't even downloaded.
   */
  function spotifyMayBeAsked(ctx: Pick<ProviderContext, 'capabilities'>): boolean {
    return (
      spotifyRegistered &&
      sources.getSnapshot().spotifyEnabled &&
      ctx.capabilities.spotify !== 'unreachable'
    )
  }

  // The matching engine runs only for tracks without audio of their own (Spotify's, say), so
  // it loads with the first of them.
  const engine = createLoader(
    'the matching engine',
    () => import('./matcher'),
    ({ createTrackMatcher, matchDetails }): TrackMatcher =>
      createTrackMatcher({
        youtube: () => youtube.load(),
        lossless: async () => {
          const found: AudioSource[] = [await archive.load()]
          if (jamendo !== undefined) found.push(await jamendo.load())
          return found
        },
        details: matchDetails({
          spotify: async (ctx) => (spotifyMayBeAsked(ctx) ? spotify.load() : undefined),
          exactIsrc: async (track, { ctx, priority }) => {
            const { module, client } = await musicBrainz.load()
            return module.findExactIsrc(client, track.id, ctx, { priority })
          },
          report,
        }),
        matchOptions,
        report,
      }),
  )
  const matcher: TrackMatcher = {
    match: async (track, request) => (await engine.load()).match(track, request),
  }
  // What the cache reads follows the Auto setting as it is now (core's `MatchVerdict`): a guess
  // the engine was sure of plays unasked only while the setting is on.
  const matches: MatchStore = withEffectiveBands(
    options.library === undefined ? createMemoryMatchStore() : matchStoreFrom(options.library),
    () => matchOptions(catalogMode()).auto === true,
  )
  const streamSources: readonly StreamSource[] = [
    youtubeStreamSource(youtube),
    lazyStreamSource('archive', archive),
    ...(jamendo === undefined ? [] : [lazyStreamSource('jamendo', jamendo)]),
  ]
  const lifecycle = new StreamLifecycle({
    sources: [...streamSources],
    matcher,
    matches,
    context: (priority) => context({ priority }),
    ...(options.quality ?? lifecycleQualityOptions()),
    settings: () => playback,
    network,
    ...(offline === undefined ? {} : { offline }),
    ...(options.refreshBeforeExpiryMs === undefined
      ? {}
      : { refreshBeforeExpiryMs: options.refreshBeforeExpiryMs }),
  })

  function start(): Promise<FxmPlatform | undefined> {
    started ??= startPlatform()
    return started
  }

  const resolver: StreamResolver = {
    async resolve(item, request) {
      // The first resolution may come before the platform is ready (a play within the moment
      // FXM Connect takes to answer): wait for it, so it never goes through the stand-in.
      await start()
      return lifecycle.resolve(item, request)
    },
  }

  const policy = createAppPlaybackPolicy({
    lifecycle,
    resolver,
    matcher,
    matches,
    mode: catalogMode,
    context: async (signal) => {
      await start()
      return context({ priority: 'interactive', signal })
    },
    setPlayBestGuesses: (on) => {
      playback.playBestGuesses = on
    },
  })

  /**
   * Tells the ladder which of its URLs started playing: in the Lite tier, where nothing could be
   * probed, that is what makes a rung count as working (stage 1.4's `reportPlaybackSuccess`, on
   * the media element's first `playing` event). Only the engine confirms that: the player says
   * `playing` with `buffering` as soon as it asks the engine to play, before a byte arrived.
   */
  function reportPlaybackStarts(player: Player): () => void {
    let reported: string | undefined
    return player.subscribe((state) => {
      const stream: StreamOption | undefined = state.stream
      if (state.status !== 'playing' || state.buffering) return
      if (stream === undefined || stream.url === reported) return
      reported = stream.url
      const loaded = youtube.current
      if (loaded?.module.isYouTubeStreamOption(stream)) {
        loaded.audio.reportPlaybackSuccess(stream, context({ priority: 'current-track' }))
      }
    })
  }

  /**
   * Whether Spotify can work here at all. Its anonymous token needs a TOTP secret from hosts
   * outside the platform's table: the desktop and Android apps reach them directly, the web app
   * only through the sandbox's user-host document (stage 1.10), without which every Spotify call
   * fails at once. Where it can't work, Spotify isn't registered, so the pages never offer it:
   * a Spotify link then says that this version can't read Spotify yet.
   */
  function canReadSpotify(current: FxmPlatform | undefined): boolean {
    if (current === undefined) return false
    return current.environment !== 'browser' || reachesUserHosts
  }

  /** Registers the providers with the registry, each loading its code on first use. */
  function registerProviders(): void {
    unregister.push(
      sources.register(
        lazyProvider({
          id: 'ytm',
          suggest: true,
          getPlaylistTracks: true,
          load: async () => (await youtube.load()).music,
          report,
        }),
      ),
      sources.register(
        lazyProvider({
          id: 'yt',
          suggest: true,
          getPlaylistTracks: true,
          load: async () => (await youtube.load()).video,
          report,
        }),
      ),
      sources.register(lazyProvider({ id: 'archive', load: () => archive.load() })),
    )
    if (localProvider !== undefined) {
      // Only while there is music on the device: "This device" with nothing on it finds nothing.
      let unregisterLocal: (() => void) | undefined
      const watch = options.watchLocalFiles ?? watchLocalFiles
      unregister.push(
        watch((present) => {
          if (present && unregisterLocal === undefined) {
            unregisterLocal = sources.register(localProvider)
          } else if (!present && unregisterLocal !== undefined) {
            unregisterLocal()
            unregisterLocal = undefined
          }
        }),
        () => unregisterLocal?.(),
      )
    }
    if (canReadSpotify(platform)) {
      spotifyRegistered = true
      unregister.push(
        sources.register(
          lazyProvider({
            id: 'spotify',
            getPlaylistTracks: true,
            getRelatedArtists: true,
            load: () => spotify.load(),
            report,
          }),
        ),
      )
    }
    if (jamendo !== undefined) {
      unregister.push(
        sources.register(
          lazyProvider({ id: 'jamendo', requestPolicy: 'explicit', load: () => jamendo.load() }),
        ),
      )
    }
  }

  /**
   * Loads YouTube's providers in the background as soon as YouTube can be reached, so the first
   * search doesn't wait for their chunk. youtubei.js, which the session imports on its first
   * InnerTube call, still loads with that call.
   */
  function warmYouTube(current: FxmPlatform): void {
    const warm = () => {
      if (current.capabilities.current.youtube !== 'none') youtube.load().catch(() => {})
    }
    warm()
    unregister.push(current.capabilities.subscribe(warm))
  }

  /**
   * With a Lite tier, loads YouTube for its config, whose kill switch the tier waits for. Its
   * self-test runs once the config is in, if the switch allows it. A load that fails (offline,
   * say) is tried again on the next change of network.
   */
  function loadLiteConfig(): void {
    youtube.load().catch(() => {
      if (disposed) return
      const stop = network.subscribe(() => {
        stop()
        if (!disposed) loadLiteConfig()
      })
      unregister.push(stop)
    })
  }

  /**
   * Ends the registry's `detecting`, which `main.tsx` sets while FXM Connect's marker is on the
   * page (`connecting.ts`), once FXM Connect has answered, at whatever version. An answer after
   * the platform's 800 ms wait counts too: its client still hears it. The grace period of
   * `connecting.ts` ends the wait for an FXM Connect that never answers.
   */
  function followDetection(current: FxmPlatform): void {
    if (sources.getSnapshot().detecting !== true) return
    const { connect } = current
    const answered = () => {
      const state = connect?.status?.state
      return state === 'present' || state === 'outdated'
    }
    if (connect === undefined || answered()) {
      sources.setDetecting(false)
      return
    }
    const stop = connect.subscribe(() => {
      if (!answered()) return
      stop()
      // The capabilities follow the new status a few microtasks later: end the wait after them,
      // so that the pages never show the Free tier in between.
      const timer = setTimeout(() => sources.setDetecting(false), 0)
      unregister.push(() => clearTimeout(timer))
    })
    unregister.push(stop)
  }

  async function startPlatform(): Promise<FxmPlatform | undefined> {
    const create = options.createPlatform ?? createPlatform
    try {
      platform = await create({
        // The stream ladder reports the bot checks it tells apart from age gates itself.
        reportLoginRequired: false,
        killSwitches,
        // The Spotify secret's hosts: the sandbox's user-host document on the web (stage 1.10).
        userHosts: () => userHosts,
        ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      })
    } catch (error) {
      console.error('FXM: the platform could not start, so only the Free tier works', error)
    }
    if (disposed) {
      platform?.dispose()
      return platform
    }
    // The platform first, then the providers: no page calls a provider through the stand-in.
    if (platform !== undefined) sources.setPlatform(platform)
    registerProviders()
    if (options.library !== undefined) {
      const library = libraryActionsFrom(options.library)
      actions.set({ ...actions.get(), library })
      unregister.push(() => {
        if (actions.get().library === library) actions.set(withoutLibrary(actions.get()))
      })
    }
    if (platform === undefined) {
      sources.setDetecting(false)
      return platform
    }
    followDetection(platform)
    warmYouTube(platform)
    if (options.sandbox !== undefined) loadLiteConfig()
    return platform
  }

  return {
    sources,
    lifecycle,
    resolver,
    policy,
    youtube,
    spotify,
    musicBrainz: mapLoader(musicBrainz, ({ client }) => client),
    spotifyAvailable: spotifyMayBeAsked,
    streamSources,
    matcher,
    matches,
    playbackSettings: () => playback,
    matchOptions,
    catalogMode,
    get platform() {
      return platform
    },
    context,
    lyrics: () => lrclib.load(),
    connectPlayer(player) {
      const own = playbackFromPlayer(player)
      const stops = [lifecycle.attach(player), reportPlaybackStarts(player)]
      actions.set({ ...actions.get(), playback: own })
      return () => {
        for (const stop of stops) stop()
        // A player connected since keeps its play buttons.
        if (actions.get().playback === own) actions.set(withoutPlayback(actions.get()))
      }
    },
    start,
    dispose() {
      disposed = true
      for (const stop of unregister.splice(0)) stop()
      lifecycle.destroy()
      ownNetwork?.destroy()
      platform?.dispose()
    },
  }
}
