/**
 * Home (stage 3.3) on the app's services: what `features/home/services.tsx` calls
 * `appHomeServices`, which `index.ts` sets once the player is connected.
 *
 * | Part | Built from |
 * |---|---|
 * | `sources` | The sources registry (stage 2.4): the tier, the Spotify switch, a context per call; `detecting` until the platform's first detection ends (`homeSourcesUntil`) |
 * | `recommendations` | Stage 3.2's `createRecommendationCollector` over the app's providers: YouTube Music radio, Spotify when it is switched on and reachable, Last.fm's stations (where the platform reaches them: FXM Connect, the desktop and Android apps), ListenBrainz's similar artists, and the Cover Art Archive for tracks without a cover. Loaded with Home's first build |
 * | `catalog` | `findArtist` (a YouTube Music artist search, the same name only), `artistTracks` (an artist page's top songs) and `findSong` (the matching engine over YouTube Music's song searches, stage 1.7) |
 * | `spotifyAccount` | Stage 3.5's view of the account (`spotifyAccountForHome`), where Spotify is registered: whether it is connected, and the sections its sync keeps |
 * | `playback` | The app's player, as 2.4's `PlaybackActions` |
 *
 * Every YouTube call draws on the request budget through the context Home passes (the
 * registry's `interactive` priority); classifying a Last.fm station's items draws at `prefetch`,
 * within what the budget has left above the interactive reserve.
 *
 * @module
 */

import {
  type ArtistRef,
  type EntityId,
  formatId,
  isEntityId,
  normalizeText,
  type ProviderContext,
  parseId,
  type RadioSeed,
  type SearchOptions,
  type Track,
} from '@fxm/core'
import { BUDGET_DEFAULTS, type FxmPlatform, type LiteState } from '@fxm/platform'
import type {
  CandidatePart,
  CollectOptions,
  RecommendationCollector,
  SpotifyMetadata,
  SpotifyRadio,
} from '@fxm/sources/recommend'
import type {
  HomeCatalog,
  HomePlayback,
  HomeRecommendations,
  HomeServices,
  HomeSources,
  HomeSourcesSnapshot,
  HomeSpotifyAccount,
} from '../../features/home/services'
import type { Sources, SourcesSnapshot } from '../../features/search/sources'
import { spotifyAccountForHome } from '../../features/spotify-account/start'
import type { AppServices } from './app-services'
import { createLoader, type Loader } from './lazy-provider'
import type { YouTube } from './youtube'

/** How many results an artist search reads to find the artist of a name. */
const ARTIST_SEARCH_LIMIT = 5

/** Whether two artist names are the same name, as Home compares them. */
function sameName(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b)
}

/** YouTube Music's artist of exactly `name`, or `null`: one artist search. */
async function youtubeArtist(
  youtube: YouTube,
  name: string,
  ctx: ProviderContext,
): Promise<ArtistRef | null> {
  const results = await youtube.music.search(
    name,
    { types: ['artist'], limit: ARTIST_SEARCH_LIMIT },
    ctx,
  )
  const found = results.artists?.items.find((artist) => sameName(artist.name, name))
  return found === undefined ? null : { id: found.id, name: found.name }
}

/** Home's catalog over the app's YouTube Music provider and matching engine. */
export function appHomeCatalog(app: Pick<AppServices, 'youtube' | 'matchOptions'>): HomeCatalog {
  return {
    async findArtist(name, ctx) {
      return youtubeArtist(await app.youtube.load(), name, ctx)
    },
    async artistTracks(artist, ctx) {
      const youtube = await app.youtube.load()
      let id = artist.id
      if (id === undefined || parseId(id).source !== 'ytm') {
        id = (await youtubeArtist(youtube, artist.name, ctx))?.id
      }
      if (id === undefined || !isEntityId(id, 'artist')) return []
      const page = await youtube.music.getArtist(id, ctx)
      return page.topTracks ?? []
    },
    async findSong(song, ctx) {
      const [youtube, { findSongTrack }] = await Promise.all([
        app.youtube.load(),
        import('./matcher'),
      ])
      return findSongTrack(song, youtube, ctx, app.matchOptions(ctx.mode))
    },
  }
}

/**
 * Stage 3.2's recommendation collector over the app's providers, loaded with its first use (its
 * code, Last.fm's, ListenBrainz's and the Cover Art Archive's, and YouTube's).
 */
export function recommendationLoader(
  app: Pick<
    AppServices,
    'youtube' | 'spotify' | 'spotifyAvailable' | 'sources' | 'platform' | 'matcher' | 'matchOptions'
  >,
): Loader<
  RecommendationCollector & { fillArtwork(track: Track, ctx: ProviderContext): Promise<Track> }
> {
  return createLoader(
    'recommendations',
    async () => {
      const [recommend, lastfm, listenbrainz, coverart, youtube, matcher] = await Promise.all([
        import('@fxm/sources/recommend'),
        import('@fxm/sources/lastfm'),
        import('@fxm/sources/listenbrainz'),
        import('@fxm/sources/coverart'),
        app.youtube.load(),
        import('./matcher'),
      ])
      return { recommend, lastfm, listenbrainz, coverart, youtube, matcher }
    },
    ({ recommend, lastfm, listenbrainz, coverart, youtube, matcher }) => {
      const { music } = youtube
      const brainz = listenbrainz.createListenBrainzClient()
      const spotifyNow = (ctx: Pick<ProviderContext, 'capabilities'>) => app.spotifyAvailable(ctx)
      // The Spotify provider for the collector: asked only when it may be, so its code loads
      // only then. Its availability follows the switch and the tier, as the provider's own does.
      const spotify: SpotifyRadio & SpotifyMetadata = {
        id: 'spotify',
        isAvailable: spotifyNow,
        radio: async (seed: RadioSeed, ctx: ProviderContext) =>
          (await app.spotify.load()).radio(seed, ctx),
        home: async (ctx: ProviderContext) => (await app.spotify.load()).home(ctx),
        search: async (query: string, options: SearchOptions, ctx: ProviderContext) =>
          (await app.spotify.load()).search(query, options, ctx),
        getRelatedArtists: async (id: EntityId<'artist'>, ctx: ProviderContext) =>
          (await app.spotify.load()).getRelatedArtists(id, ctx),
      }
      const collector = recommend.createRecommendationCollector({
        youtube: music,
        youtubeLookup: music,
        async youtubeSeed(seed, ctx) {
          if ('kind' in seed) {
            // A track from another source: its YouTube Music song, through the matching engine
            // and the match cache.
            const outcome = await app.matcher.match(seed, {
              target: 'song',
              ctx,
              exclude: [],
              priority: 'prefetch',
              signal: (ctx.signal as AbortSignal | undefined) ?? new AbortController().signal,
            })
            const best = outcome.best
            if (best === undefined || outcome.band === 'none' || best.source !== 'ytm') return null
            return {
              id: formatId('ytm', 'track', best.ref),
              source: 'ytm',
              title: best.title,
              artists: best.artists.map((name) => ({ name })),
              artwork: [],
              kind: best.kind,
              ...(best.durationMs === undefined ? {} : { durationMs: best.durationMs }),
            }
          }
          return youtubeArtist(youtube, seed.name, ctx)
        },
        spotify,
        spotifyMetadata: spotify,
        spotifyEnabled: () => app.sources.getSnapshot().spotifyEnabled,
        classificationBudget: {
          allowance: () => {
            const budget = app.platform?.budget
            if (budget === undefined) return 0
            return budget.snapshot().remaining - BUDGET_DEFAULTS.reserves.interactive
          },
          context: (ctx) => app.sources.context({ mode: ctx.mode, priority: 'prefetch' }),
        },
        songForVideo: (video, ctx) =>
          matcher.songForVideo(video, youtube, ctx, app.matchOptions(ctx.mode)),
        autoMatch: (ctx) => app.matchOptions(ctx.mode).auto === true,
        lastfmStations: lastfm.createLastfmStations({
          reachable: () => app.platform?.transport.canReach(lastfm.LASTFM_STATION_PREFIX) === true,
        }),
        listenbrainz: brainz,
      })
      const artwork = recommend.createArtworkFiller({
        coverArt: coverart.createCoverArtClient(),
        listenbrainz: brainz,
      })
      return Object.assign(collector, {
        fillArtwork: (track: Track, ctx: ProviderContext) =>
          artwork.fill(track, ctx, { priority: 'bulk' }),
      })
    },
  )
}

/** How many coverless tracks of one collection get a cover looked up, at most. */
const MAX_ARTWORK_LOOKUPS = 8

/**
 * Home's recommendation sources: the collector, loaded with Home's first build, with covers
 * filled in for the few candidate tracks that come without one (the Cover Art Archive, through
 * ListenBrainz's lookup of the track's release).
 */
export function appHomeRecommendations(
  collector: Loader<
    RecommendationCollector & { fillArtwork(track: Track, ctx: ProviderContext): Promise<Track> }
  >,
): HomeRecommendations {
  return {
    async collect(seed, ctx, options) {
      const loaded = await collector.load()
      const call: CollectOptions = {
        ...(options?.parts === undefined
          ? {}
          : { parts: options.parts as readonly CandidatePart[] }),
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
      }
      const collection = await loaded.collect(seed, ctx, call)
      let lookups = 0
      const candidates = await Promise.all(
        collection.candidates.map(async (candidate) => {
          if (candidate.type !== 'track' || candidate.track.artwork.length > 0) return candidate
          if (lookups >= MAX_ARTWORK_LOOKUPS) return candidate
          lookups += 1
          try {
            return { ...candidate, track: await loaded.fillArtwork(candidate.track, ctx) }
          } catch {
            return candidate
          }
        }),
      )
      return { ...collection, candidates }
    },
    async home(ctx) {
      return (await collector.load()).home(ctx)
    },
  }
}

/**
 * The Spotify account, where Spotify is registered: stage 3.5's view of it, over the app's one
 * Spotify provider. It says whether the account is connected and brings the sections its sync
 * keeps, and loads nothing until the user connects the account.
 */
export function appSpotifyAccount(): HomeSpotifyAccount {
  return spotifyAccountForHome
}

/** How long Home waits for the first Lite self-test at most, before it shows what is known. */
export const LITE_WAIT_MS = 4000

/** The Lite self-test's states that say it has ended, one way or the other. */
const LITE_SETTLED: ReadonlySet<LiteState> = new Set([
  'unchecked',
  'passed',
  'refused',
  'unreachable',
  'killed',
])

/**
 * Resolves once the tier is known as far as Home tells the tiers apart: `platform` is ready
 * (FXM Connect has answered, or the platform stopped waiting for it) and, where it has a Lite
 * tier and YouTube isn't reachable otherwise, the first Lite self-test has ended and the
 * registry follows it. The platform doesn't wait for that self-test itself, which a slow sandbox
 * stretches to seconds, so Home waits for it here, `maxWaitMs` at most. Never rejects.
 */
export async function tierKnown(
  platform: Promise<Pick<FxmPlatform, 'lite'> | undefined>,
  sources: Pick<Sources, 'getSnapshot' | 'subscribe'>,
  maxWaitMs = LITE_WAIT_MS,
): Promise<void> {
  const lite = (await platform.catch(() => undefined))?.lite
  if (lite === undefined) return
  const known = () =>
    sources.getSnapshot().capabilities.youtube !== 'none' ||
    (LITE_SETTLED.has(lite.state) && lite.state !== 'passed')
  if (known()) return
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      stopLite()
      stopSources()
      resolve()
    }
    const check = () => {
      if (known()) done()
    }
    const timer = setTimeout(done, maxWaitMs)
    const stopLite = lite.subscribe(check)
    const stopSources = sources.subscribe(check)
  })
}

/**
 * Home's view of the sources registry: the registry itself, except that its snapshot says
 * `detecting` until `ready` settles, the platform's first detection (FXM Connect's answer, then
 * the Lite self-test where FXM Connect gives no full access, `tierKnown`); after that, whenever
 * the registry says so (FXM Connect waking up). While the tier is unknown, Home shows a
 * placeholder rather than the Free tier's install pitch, which would most likely be wrong.
 */
export function homeSourcesUntil(sources: Sources, ready: Promise<unknown>): HomeSources {
  let settled = false
  let seen: SourcesSnapshot | undefined
  let unknown: HomeSourcesSnapshot | undefined
  const listeners = new Set<() => void>()
  const settle = () => {
    settled = true
    for (const listener of [...listeners]) listener()
  }
  ready.then(settle, settle)
  return {
    getSnapshot() {
      const current = sources.getSnapshot()
      if (settled) return current
      // The same object until the registry changes, for `useSyncExternalStore`.
      if (current !== seen || unknown === undefined) {
        seen = current
        unknown = { ...current, detecting: true }
      }
      return unknown
    },
    subscribe(listener) {
      listeners.add(listener)
      const stop = sources.subscribe(listener)
      return () => {
        listeners.delete(listener)
        stop()
      }
    },
    context: (options) => sources.context(options),
  }
}

/** Home's services on the app's services (see the module documentation). */
export function createAppHomeServices(
  app: AppServices,
  options: {
    /** What Home reads the tier from. Default: the registry (`app.sources`). */
    readonly sources?: HomeSources | undefined
    readonly playback?: HomePlayback | undefined
    readonly spotify: boolean
  },
): HomeServices {
  return {
    sources: options.sources ?? app.sources,
    recommendations: appHomeRecommendations(recommendationLoader(app)),
    catalog: appHomeCatalog(app),
    ...(options.spotify ? { spotifyAccount: appSpotifyAccount() } : {}),
    ...(options.playback === undefined ? {} : { playback: options.playback }),
  }
}
