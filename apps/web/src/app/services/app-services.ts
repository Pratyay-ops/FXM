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
 * | Spotify, behind the Spotify switch | 1.5 | a lazy provider, on while the switch is |
 * | Internet Archive, Jamendo, MusicBrainz | 1.6 | lazy providers and stream sources |
 * | Matching engine | 1.7 | `matcher.ts` |
 * | Lyrics | 1.8 | `lyrics()`, for Now playing |
 * | Player | 2.2 | `connectPlayer(player)` |
 * | Playback policy and stream lifecycle | 2.3 | `lifecycle`, `policy` (2.5's interface) |
 * | Search and browse seams | 2.4 | the sources registry and the actions store |
 * | Library seams | 2.6 | `library.ts`, once the repository is passed in |
 *
 * **Tiers.** The platform decides: Full with FXM Connect (or the desktop and Android apps once
 * their native HTTP exists), Lite with the sandbox documents of stage 1.10 (`sandbox`), Free
 * only otherwise. The pages read the tier from the sources registry, and every provider call gets
 * a context with the current capabilities, so nothing here branches on it.
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
  DEFAULT_QUALITY_PREFS,
  type LyricsProvider,
  type MatchSource,
  type PlaybackSettings,
  type ProviderContext,
  type SourceId,
  type StreamOption,
  type Track,
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
  type Player,
  StreamLifecycle,
  type StreamResolver,
  type StreamSource,
  type TrackMatcher,
  type TrackMatchRequest,
} from '@fxm/player'
import type { ArchiveSource } from '@fxm/sources/archive'
import type { JamendoSource } from '@fxm/sources/jamendo'
import type { MusicBrainzLookups } from '@fxm/sources/musicbrainz'
import type { SpotifyProvider } from '@fxm/sources/spotify'
import {
  appActions,
  type MediaActions,
  type MediaActionsStore,
  playbackFromPlayer,
} from '../../features/search/actions'
import {
  createStaticPlatform,
  type Sources,
  type SourcesPlatform,
} from '../../features/search/sources'
import { appSources } from '../../features/search/sources-context'
import { useSettingsStore } from '../../features/settings/settings-store'
import { createIndexedDbStore, type DeviceStore } from './device-store'
import { createLoader, type Loader, lazyProvider } from './lazy-provider'
import { type LibraryRepository, libraryActionsFrom, matchStoreFrom } from './library'
import { type AppPlaybackPolicy, createAppPlaybackPolicy } from './policy'
import {
  createYouTubeLoader,
  platformStreamBudget,
  type YouTube,
  youtubeStreamSource,
} from './youtube'

/** Options for {@link createAppServices}. Every one has a default that suits the app. */
export interface AppServicesOptions {
  /**
   * Creates the platform (stage 1.2) from the app's options. Default: `createPlatform`, which
   * detects the environment. Tests pass one over a fake network, desktop and Android their
   * native HTTP (stages 7.2 and 6.2).
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
  /** The Auto setting of the matching engine, which stage 1.12's report turns on. Default: off. */
  readonly autoMatch?: () => boolean
  /** The catalog mode. Default: the settings'. */
  readonly catalogMode?: () => CatalogMode
  /**
   * The network monitor of the stream lifecycle. Default: the browser's events, which
   * `dispose()` stops following.
   */
  readonly network?: NetworkMonitor
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
  /** The resolver for the app's player: the lifecycle, once the platform is ready. */
  readonly resolver: StreamResolver
  /** The playback policy as stage 2.5's player and Now playing use it. */
  readonly policy: AppPlaybackPolicy
  /** YouTube, loaded on first use. */
  readonly youtube: Loader<YouTube>
  /** The platform, once {@link AppServices.start} created it. */
  readonly platform: FxmPlatform | undefined
  /** A context for one provider call, with the platform's `fetch` at `priority`. */
  context(options: AppContextOptions): ProviderContext
  /** The lyrics provider (stage 1.8), loaded on first use. Call it with {@link context}. */
  lyrics(): Promise<LyricsProvider>
  /**
   * Connects the app's player: the lifecycle follows it (prefetching, Smart Replace), the ladder
   * learns which URLs started playing, and the catalog pages' play buttons drive it. Returns a
   * function that disconnects it.
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

/** The user's language and region, e.g. `en-IN` and `IN`, for `hl` and `gl`. */
function userLocale(): { locale?: string; region?: string } {
  const locale = typeof navigator === 'undefined' ? undefined : navigator.language
  if (!locale) return {}
  try {
    const region = new Intl.Locale(locale).region
    return region ? { locale, region } : { locale }
  } catch {
    return {}
  }
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

/** Creates the app's services. Nothing is fetched or imported until they are used. */
export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const sources = options.sources ?? appSources
  const actions = options.actions ?? appActions
  const store = options.deviceStore ?? createIndexedDbStore()
  const catalogMode = options.catalogMode ?? (() => useSettingsStore.getState().catalogMode)
  const ownNetwork = options.network === undefined ? createBrowserNetworkMonitor() : undefined
  const network = options.network ?? (ownNetwork as NetworkMonitor)
  const jamendoClientId =
    'jamendoClientId' in options
      ? options.jamendoClientId
      : (import.meta.env.VITE_FXM_JAMENDO_CLIENT_ID as string | undefined) || undefined
  const killSwitches = createKillSwitchStore()
  const playback: PlaybackSettings = { ...DEFAULT_PLAYBACK_SETTINGS }
  const standIn = createStaticPlatform()
  let platform: FxmPlatform | undefined
  let started: Promise<FxmPlatform | undefined> | undefined
  const unregister: (() => void)[] = []
  const report = (error: unknown) => {
    platform?.report(error)
  }

  function context({ priority, mode = catalogMode(), signal }: AppContextOptions) {
    const current: SourcesPlatform = platform ?? standIn
    return current.context({
      mode,
      priority,
      ...userLocale(),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  const youtube = createYouTubeLoader({
    store,
    budget: platformStreamBudget(() => platform?.budget),
    // The config's kill switches turn the Lite tier off (stage 1.10).
    onLoad: (loaded) => killSwitches.set(loaded.session.config.killSwitches),
  })
  /** Hosts outside the platform's table that FXM may fetch from: the Spotify secret's. */
  let userHosts: readonly string[] = []
  const spotify = createLoader('Spotify', async (): Promise<SpotifyProvider> => {
    const { createSpotifyProvider, SPOTIFY_SECRET_SOURCE_HOSTS } = await import(
      '@fxm/sources/spotify'
    )
    // Only Spotify fetches from them, so they are known before the first such fetch.
    userHosts = SPOTIFY_SECRET_SOURCE_HOSTS
    const session = platform?.spotifySession
    return createSpotifyProvider({
      isEnabled: () => sources.getSnapshot().spotifyEnabled,
      ...(session === undefined ? {} : { session }),
    })
  })
  const archive = createLoader('Internet Archive', async (): Promise<ArchiveSource> => {
    const { createArchiveSource } = await import('@fxm/sources/archive')
    return createArchiveSource()
  })
  const jamendo =
    jamendoClientId === undefined
      ? undefined
      : createLoader('Jamendo', async (): Promise<JamendoSource> => {
          const { createJamendoSource } = await import('@fxm/sources/jamendo')
          return createJamendoSource({
            publicClientId: jamendoClientId,
            preferLossless: () => playback.preferLossless,
          })
        })
  const musicBrainz = createLoader('MusicBrainz', async (): Promise<MusicBrainzLookups> => {
    const { createMusicBrainzClient } = await import('@fxm/sources/musicbrainz')
    return createMusicBrainzClient()
  })
  const lrclib = createLoader('LRCLIB', async (): Promise<LyricsProvider> => {
    const { createLrclibProvider } = await import('@fxm/sources/lrclib')
    return createLrclibProvider()
  })

  /**
   * What the matching engine reads about a Spotify track beyond the track itself: its ISRC,
   * label, release date and album type from Spotify, or failing that its ISRC from MusicBrainz's
   * exact path (an ISRC-verified input). Nothing for other sources' tracks.
   */
  async function details(
    track: Track,
    { ctx, priority }: TrackMatchRequest,
  ): Promise<Partial<MatchSource> | undefined> {
    if (track.source !== 'spotify') return undefined
    try {
      const provider = await spotify.load()
      if (provider.isAvailable(ctx)) return await provider.getTrackDetails(track.id, ctx)
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      report(error)
    }
    if (track.isrc !== undefined) return undefined
    try {
      const { findExactIsrc } = await import('@fxm/sources/musicbrainz')
      const found = await findExactIsrc(await musicBrainz.load(), track.id, ctx, { priority })
      const lengthMs = found?.recording.lengthMs
      return {
        ...(found?.isrc === undefined ? {} : { isrc: found.isrc, isrcOrigin: found.origin }),
        ...(track.durationMs === undefined && lengthMs !== undefined
          ? { durationMs: lengthMs }
          : {}),
      }
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      return undefined
    }
  }

  // The matching engine runs only for tracks without audio of their own (Spotify's, say), so
  // it loads with the first of them.
  const engine = createLoader('the matching engine', async (): Promise<TrackMatcher> => {
    const { createTrackMatcher } = await import('./matcher')
    return createTrackMatcher({
      youtube: () => youtube.load(),
      lossless: async () => {
        const found: AudioSource[] = [await archive.load()]
        if (jamendo !== undefined) found.push(await jamendo.load())
        return found
      },
      details,
      ...(options.autoMatch === undefined ? {} : { autoMatch: options.autoMatch }),
      report,
    })
  })
  const matcher: TrackMatcher = {
    match: async (track, request) => (await engine.load()).match(track, request),
  }
  const matches: MatchStore =
    options.library === undefined ? createMemoryMatchStore() : matchStoreFrom(options.library)
  const lifecycle = new StreamLifecycle({
    sources: [
      youtubeStreamSource(youtube),
      lazyStreamSource('archive', archive),
      ...(jamendo === undefined ? [] : [lazyStreamSource('jamendo', jamendo)]),
    ],
    matcher,
    matches,
    context: (priority) => context({ priority }),
    qualityPrefs: () => DEFAULT_QUALITY_PREFS,
    settings: () => playback,
    network,
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
   * probed, that is what makes a rung count as working (stage 1.4's `reportPlaybackSuccess`).
   */
  function reportPlaybackStarts(player: Player): () => void {
    let reported: string | undefined
    return player.subscribe((state) => {
      const stream: StreamOption | undefined = state.stream
      if (state.status !== 'playing' || stream === undefined || stream.url === reported) return
      reported = stream.url
      const loaded = youtube.current
      if (loaded?.module.isYouTubeStreamOption(stream)) {
        loaded.audio.reportPlaybackSuccess(stream, context({ priority: 'current-track' }))
      }
    })
  }

  /** Registers the providers with the registry, the YouTube ones loading on first use. */
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
      sources.register(
        lazyProvider({
          id: 'spotify',
          getPlaylistTracks: true,
          getRelatedArtists: true,
          load: () => spotify.load(),
          report,
        }),
      ),
      sources.register(lazyProvider({ id: 'archive', load: () => archive.load() })),
    )
    if (jamendo !== undefined) {
      unregister.push(
        sources.register(
          lazyProvider({ id: 'jamendo', requestPolicy: 'explicit', load: () => jamendo.load() }),
        ),
      )
    }
  }

  /** Loads YouTube in the background as soon as it can be reached, so the first search is fast. */
  function warmYouTube(current: FxmPlatform): void {
    const warm = () => {
      if (current.capabilities.current.youtube !== 'none') youtube.load().catch(() => {})
    }
    warm()
    unregister.push(current.capabilities.subscribe(warm))
  }

  async function startPlatform(): Promise<FxmPlatform | undefined> {
    const create = options.createPlatform ?? createPlatform
    // With a Lite tier, the YouTube config's kill switch must be known before the platform runs
    // the tier's self-test, a request to YouTube that a set switch forbids.
    if (options.sandbox !== undefined) await youtube.load().catch(() => {})
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
    // The platform first, then the providers: no page calls a provider through the stand-in.
    if (platform !== undefined) sources.setPlatform(platform)
    registerProviders()
    if (options.library !== undefined) {
      actions.set({ ...actions.get(), library: libraryActionsFrom(options.library) })
    }
    if (platform !== undefined) warmYouTube(platform)
    return platform
  }

  return {
    sources,
    lifecycle,
    resolver,
    policy,
    youtube,
    get platform() {
      return platform
    },
    context,
    lyrics: () => lrclib.load(),
    connectPlayer(player) {
      const stops = [lifecycle.attach(player), reportPlaybackStarts(player)]
      actions.set({ ...actions.get(), playback: playbackFromPlayer(player) })
      return () => {
        for (const stop of stops) stop()
        actions.set(withoutPlayback(actions.get()))
      }
    },
    start,
    dispose() {
      for (const stop of unregister.splice(0)) stop()
      lifecycle.destroy()
      ownNetwork?.destroy()
      platform?.dispose()
    },
  }
}
