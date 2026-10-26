/**
 * What Home needs from the rest of the app, as one small seam: what the platform reaches, the
 * recommendation sources, a catalog to turn artists and song searches into tracks, the user's
 * Spotify account and playback. Every part except `sources` is optional, and Home shows what the
 * parts that are there allow: with none of them, the user's own shelves (On repeat, Rediscover)
 * and the onboarding.
 *
 * Each part is the shape of a piece another stage builds, so wiring it in is one line:
 *
 * | Part | Stage | Wire in |
 * |---|---|---|
 * | `sources` | 2.4's `appSources` (1.2's platform inside) | `sources: appSources` |
 * | `recommendations` | 3.2's `createRecommendationCollector`, with 1.3's and 1.5's providers | `recommendations: collector` |
 * | `catalog` | 1.3's artist search and pages, 1.7's matching | `catalog: { findArtist, artistTracks, findSong }` |
 * | `spotifyAccount` | 3.5's account (`status`, and `sections` from its sync) | `spotifyAccount: spotifyAccountForHome` |
 * | `playback` | 2.2's player (2.4's `PlaybackActions`) | `playback: appActions.get().playback` |
 *
 * @module
 */

import {
  type AccountProvider,
  type ArtistRef,
  type CatalogMode,
  type Fetch,
  FxmError,
  type NetworkCapabilities,
  type ProviderContext,
  type QueueContext,
  type RadioSeed,
  type RecArtist,
  type RecCandidate,
  type Shelf,
  type Track,
} from '@fxm/core'
import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from 'react'

/** What the platform reaches and the user's Spotify switch, at one moment. */
export interface HomeSourcesSnapshot {
  /** What the platform can reach. */
  readonly capabilities: NetworkCapabilities
  /** Whether the user switched Spotify on (it is used only when it is also reachable). */
  readonly spotifyEnabled: boolean
  /**
   * Whether the tier is still being worked out (FXM Connect waking up, the first Lite check).
   * Meanwhile Home shows a placeholder instead of saying what this browser lacks, which would
   * most likely be wrong. Absent means `false`.
   */
  readonly detecting?: boolean
}

/**
 * What the platform reaches and the user's Spotify switch, kept current, and a context for
 * each provider call. Stage 2.4's `Sources` (`appSources`) has this shape.
 */
export interface HomeSources {
  /** The current state; the same object until something changes. */
  getSnapshot(): HomeSourcesSnapshot
  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** A context for one provider call. */
  context(options: { mode: CatalogMode; signal?: AbortSignal }): ProviderContext
}

/** A service's home-feed section, with the service it came from. */
export interface HomeSourceShelf {
  /** The service, e.g. `spotify`. */
  readonly source: string
  /** The section. */
  readonly shelf: Shelf
}

/** What one source did for a seed, as stage 3.2's `SourceOutcome` says. */
export interface HomeSourceOutcome {
  /** `ok`, `skipped`, `failed` or `timed-out`. */
  readonly status: string
  /** The service, e.g. `ytm`. */
  readonly source?: string
  /** The call, e.g. `radio`. */
  readonly part?: string
}

/**
 * The recommendation sources: stage 3.2's `RecommendationCollector`, which asks YouTube Music,
 * Spotify, Last.fm and ListenBrainz at once and returns their candidates in one format.
 */
export interface HomeRecommendations {
  /**
   * Candidates for one seed, from every source that can run, and what each source did (a
   * collection with a `failed` source isn't cached, and a build with one, or with a seed that
   * YouTube Music's radio skipped, doesn't keep its lists). Fails only when cancelled.
   */
  collect(
    seed: RadioSeed,
    ctx: ProviderContext,
    options?: { parts?: readonly string[]; limit?: number },
  ): Promise<{
    readonly candidates: readonly RecCandidate[]
    readonly outcomes?: readonly HomeSourceOutcome[]
  }>
  /** The home feeds of the sources that have one, filtered to the mode. */
  home(ctx: ProviderContext): Promise<{ readonly shelves: readonly HomeSourceShelf[] }>
}

/** A song known by its title and artists. */
export interface SongQuery {
  readonly title: string
  readonly artists: readonly string[]
  readonly durationMs?: number
}

/**
 * Turns what the sources suggest by name into tracks. Each costs requests, so Home asks for a
 * few only: the artists and songs the engine ranks highest (`planExpansions`).
 */
export interface HomeCatalog {
  /**
   * The artist of a name, e.g. YouTube Music's best artist match (stage 1.3), or `null`. Seeds
   * from the onboarding are names; YouTube Music's radio needs its own artist.
   */
  findArtist?(name: string, ctx: ProviderContext): Promise<ArtistRef | null>
  /** An artist's top tracks, best first, e.g. from YouTube Music's artist page (stage 1.3). */
  artistTracks?(artist: RecArtist, ctx: ProviderContext): Promise<readonly Track[]>
  /** The track of a song, or `null`: a song search through the matching engine (stage 1.7). */
  findSong?(song: SongQuery, ctx: ProviderContext): Promise<Track | null>
}

/**
 * The user's Spotify account (stages 1.5 and 3.5): whether it is connected (the Spotify
 * provider's `status`) and, from stage 3.5's sync, the account's personal home sections
 * (`sections`). Without `sections`, Home takes Spotify's sections from the recommendation
 * sources' home feeds.
 */
export interface HomeSpotifyAccount extends Pick<AccountProvider, 'status'> {
  /** The account's personal home sections, filtered to the context's catalog mode. */
  sections?(ctx: ProviderContext): Promise<readonly Shelf[]>
}

/** Playback: 2.4's `PlaybackActions`. Call it straight from the click that asked for it. */
export interface HomePlayback {
  /** Replaces the queue with `tracks` and plays. */
  play(
    tracks: readonly Track[],
    options?: { readonly startIndex?: number; readonly context?: QueueContext },
  ): void
}

/** Everything Home uses from the rest of the app. */
export interface HomeServices {
  /** What the platform reaches, and the Spotify switch. */
  readonly sources: HomeSources
  /** The recommendation sources. Without them, Home recommends nothing new. */
  readonly recommendations?: HomeRecommendations
  /** Artists and song searches to tracks. Without it, those candidates stay unused. */
  readonly catalog?: HomeCatalog
  /** The user's Spotify account. Without it, Spotify's personal sections never show. */
  readonly spotifyAccount?: HomeSpotifyAccount
  /** Playback. Without it, Home shows no play buttons. */
  readonly playback?: HomePlayback
}

/** The capabilities of a browser page without FXM Connect or the Lite tier: Free only. */
export const FREE_ONLY: NetworkCapabilities = Object.freeze({
  youtube: 'none',
  spotify: 'unreachable',
  mediaBytes: false,
  fileSystem: false,
})

/** The `fetch` of sources that reach nothing: every request fails as `Unsupported`. */
const refuseFetch: Fetch = () =>
  Promise.reject(new FxmError('Unsupported', 'FXM has no network transport here yet'))

/**
 * Sources with fixed capabilities (Free only unless told otherwise) and the Spotify switch on:
 * Home's default until the composition root sets the app's services (stage 2.9b), after it
 * takes them back, and what tests use.
 */
export function staticSources(
  capabilities: NetworkCapabilities = FREE_ONLY,
  { spotifyEnabled = true, fetch = refuseFetch }: { spotifyEnabled?: boolean; fetch?: Fetch } = {},
): HomeSources {
  const snapshot: HomeSourcesSnapshot = { capabilities, spotifyEnabled }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    context: ({ mode, signal }) => ({
      fetch,
      platform: 'web',
      capabilities,
      mode,
      ...(signal === undefined ? {} : { signal }),
    }),
  }
}

/** Holds the current {@link HomeServices}, so they can be wired in after the app started. */
export interface HomeServicesStore {
  /** The current services; the same object until {@link HomeServicesStore.set} is called. */
  get(): HomeServices
  /** Replaces the services. */
  set(services: HomeServices): void
  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** Creates a {@link HomeServicesStore}. */
export function createHomeServicesStore(
  initial: HomeServices = { sources: staticSources() },
): HomeServicesStore {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(services) {
      current = services
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * The app's Home services. Until the platform, the providers and the player are wired in
 * (`appHomeServices.set({ … })`), Home reaches nothing: the Free-only tier, no recommendation
 * sources, no playback.
 */
export const appHomeServices: HomeServicesStore = createHomeServicesStore()

// Development only (and screenshot builds made with VITE_FXM_FAKE_CATALOG=on): `?fake-home=lite`
// or `full` plugs fake services into Home (see dev-fakes.ts). Production builds drop this
// branch, and with it the fakes.
if (import.meta.env.DEV || import.meta.env.VITE_FXM_FAKE_CATALOG === 'on') {
  void import('./dev-fakes').then(({ installHomeDevFakes }) => installHomeDevFakes(appHomeServices))
}

const HomeServicesContext = createContext<HomeServicesStore>(appHomeServices)

/** Provides other services to the pages below it: tests pass fakes. */
export function HomeServicesProvider({
  services,
  children,
}: {
  services: HomeServices | HomeServicesStore
  children: ReactNode
}) {
  const [store] = useState(() =>
    'subscribe' in services ? services : createHomeServicesStore(services),
  )
  return <HomeServicesContext value={store}>{children}</HomeServicesContext>
}

/** The services in use here; re-renders when they change. */
export function useHomeServices(): HomeServices {
  const store = useContext(HomeServicesContext)
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** What the services' sources reach now; re-renders when it changes. */
export function useHomeReach(services: HomeServices): HomeSourcesSnapshot {
  const { sources } = services
  return useSyncExternalStore(sources.subscribe, sources.getSnapshot, sources.getSnapshot)
}

/**
 * Whether Home can recommend new music: the recommendation sources are wired in, and YouTube
 * Music can be reached (Lite or Full), whose songs are what plays. In the Free-only tier Home
 * keeps to the user's own music.
 */
export function canRecommend(services: HomeServices, snapshot: HomeSourcesSnapshot): boolean {
  return services.recommendations !== undefined && snapshot.capabilities.youtube !== 'none'
}
