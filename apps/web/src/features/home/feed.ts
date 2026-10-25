/**
 * Building Home: the library reads and network calls around the pure engine of `@fxm/core`
 * (stage 3.3, `packages/core/src/recommend`).
 *
 * 1. **The taste profile** from the library (stage 3.1): the top tracks, artists and tags of the
 *    listening affinity, the tracks' cached metadata, the recent plays, plus the onboarding
 *    picks.
 * 2. **The seeds** the engine plans (`planSeeds`), with YouTube Music's own artist for an
 *    artist known only by name (`findArtist`), and for each seed the recommendation sources'
 *    candidates (`collect`, stage 3.2), a few seeds at a time. Collections are cached for half
 *    an hour, so rebuilding Home costs nothing new.
 * 3. **Expansions:** the few similar artists and song searches the engine ranks highest
 *    (`planExpansions`) become tracks through the catalog.
 * 4. **Spotify's personal sections**, when Spotify is switched on, reachable and the account is
 *    connected (stage 3.5).
 * 5. **The shelves** (`buildHome`), with Discover and the Daily Mixes kept for their week and
 *    day in storage.
 *
 * Only YouTube Music's songs can play from recommendations, so Home recommends new music only
 * where YouTube Music is reachable (Lite or Full); in the Free-only tier it keeps to the user's
 * own music. A source that fails adds nothing; only a cancellation rejects.
 *
 * @module
 */

import {
  type ArtistRef,
  artistKeyOf,
  artistTrackCandidates,
  buildHome,
  type CatalogMode,
  type HomeFeed,
  indexTaste,
  isEntityId,
  isTrackSeed,
  type PlannedSeed,
  type ProfileTrack,
  type ProviderContext,
  parseId,
  planExpansions,
  planSeeds,
  poolCandidates,
  type RandomSource,
  type RecCandidate,
  type RecentPlay,
  seedKey,
  seedWeight,
  songTrackCandidates,
  type TasteIndex,
  type TastePicks,
  type TasteProfile,
} from '@fxm/core'
import type { LibraryRepo } from '../../db/repo'
import {
  canRecommend,
  type HomeCatalog,
  type HomeRecommendations,
  type HomeServices,
  type HomeSourceShelf,
  type HomeSourcesSnapshot,
} from './services'
import type { StableStore } from './stable-storage'

/** How much of the library the profile reads. */
export const PROFILE_LIMITS = Object.freeze({
  /** Tracks by affinity: enough to hold old favourites for Rediscover. */
  tracks: 400,
  artists: 120,
  tags: 60,
  /** Distinct recently played tracks, for the history filters. */
  recent: 200,
})

/** How much the network steps may do in one build. */
export const FEED_LIMITS = Object.freeze({
  /** Candidates per seed and source. */
  perSource: 30,
  /** Seeds collected at the same time. */
  concurrency: 3,
  /** Similar artists turned into songs. */
  artists: 4,
  /** Song searches turned into tracks. */
  songs: 6,
})

/** How long a seed's collection is reused. */
export const COLLECTION_TTL_MS = 30 * 60_000

/** The taste profile the library holds, with the onboarding picks. */
export async function loadTasteProfile(
  repo: LibraryRepo,
  picks?: TastePicks,
  limits: typeof PROFILE_LIMITS = PROFILE_LIMITS,
): Promise<TasteProfile> {
  const [tracks, artists, tags, recent] = await Promise.all([
    repo.topAffinity('track', limits.tracks),
    repo.topAffinity('artist', limits.artists),
    repo.topAffinity('tag', limits.tags),
    repo.recentlyPlayed(limits.recent),
  ])
  const cached = await Promise.all(
    tracks.map(({ entry }) => {
      const id = entry.ids.find((one) => isEntityId(one, 'track'))
      return id === undefined ? undefined : repo.getTrack(id)
    }),
  )
  const profileTracks: ProfileTrack[] = tracks.map(({ entry }, index) => {
    const track = cached[index]
    return track === undefined ? { entry } : { entry, track }
  })
  const recentPlays: RecentPlay[] = recent.map((row) =>
    row.track === undefined
      ? { trackId: row.id, playedAt: row.playedAt }
      : { trackId: row.id, playedAt: row.playedAt, track: row.track },
  )
  return {
    tracks: profileTracks,
    artists: artists.map(({ entry }) => entry),
    tags: tags.map(({ entry }) => entry),
    recent: recentPlays,
    ...(picks === undefined ? {} : { picks }),
  }
}

/** Seed collections reused between builds, for {@link COLLECTION_TTL_MS}. */
export interface CollectionCache {
  get(key: string, now: number): readonly RecCandidate[] | undefined
  set(key: string, candidates: readonly RecCandidate[], now: number): void
}

/** A {@link CollectionCache} in memory, holding at most `size` collections. */
export function createCollectionCache(ttlMs = COLLECTION_TTL_MS, size = 64): CollectionCache {
  const entries = new Map<string, { at: number; candidates: readonly RecCandidate[] }>()
  return {
    get(key, now) {
      const entry = entries.get(key)
      if (entry === undefined || now - entry.at > ttlMs || now < entry.at) return undefined
      return entry.candidates
    },
    set(key, candidates, now) {
      entries.delete(key)
      entries.set(key, { at: now, candidates })
      while (entries.size > size) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}

/**
 * The app's collection caches, one per recommendation sources object, so that wiring other
 * sources in never serves what the old ones collected.
 */
const appCollections = new WeakMap<HomeRecommendations, CollectionCache>()

function collectionsOf(recommendations: HomeRecommendations): CollectionCache {
  let cache = appCollections.get(recommendations)
  if (cache === undefined) {
    cache = createCollectionCache()
    appCollections.set(recommendations, cache)
  }
  return cache
}

/** Artists found by name, per catalog, for the session: an artist's ID doesn't change. */
const appArtists = new WeakMap<HomeCatalog, Map<string, ArtistRef | null>>()
const MAX_FOUND_ARTISTS = 200

function artistsOf(catalog: HomeCatalog): Map<string, ArtistRef | null> {
  let found = appArtists.get(catalog)
  if (found === undefined) {
    found = new Map()
    appArtists.set(catalog, found)
  }
  return found
}

/** What one Home build needs. */
export interface FeedRequest {
  readonly mode: CatalogMode
  readonly services: HomeServices
  readonly repo: LibraryRepo
  /** Where Discover and the mixes are kept. */
  readonly stable: StableStore
  /** The onboarding picks. */
  readonly picks?: TastePicks
  /** Cancels the build. */
  readonly signal?: AbortSignal
  /** The time. Default: now. */
  readonly now?: number
  /** Local time's offset from UTC in minutes. Default: the browser's. */
  readonly utcOffsetMinutes?: number
  /** Noise for Quick picks. Default: the engine's, seeded with the hour. */
  readonly random?: RandomSource
  /** Collections reused between builds. Default: the app's, for these recommendation sources. */
  readonly cache?: CollectionCache
  /** Artists found by name, reused between builds. Default: the app's, for this catalog. */
  readonly artists?: Map<string, ArtistRef | null>
}

/** A built Home and what it could reach. */
export interface HomeFeedResult extends HomeFeed {
  /** Whether recommendation sources ran: wired in, and YouTube Music reachable. */
  readonly recommending: boolean
  /** Whether a connected Spotify account's sections were asked for. */
  readonly spotifyConnected: boolean
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('Home was not needed any more', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

/** `work` for every item, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Runs `work`; a failure counts as `fallback`, unless the build was cancelled. */
async function quietly<R>(signal: AbortSignal | undefined, fallback: R, work: () => Promise<R>) {
  try {
    return await work()
  } catch {
    if (signal?.aborted) throw abortReason(signal)
    return fallback
  }
}

/**
 * The cache key of a seed's collection: the seed (with the artist found for it, if any), its
 * parts and what the sources could reach.
 */
function collectionKey(seed: PlannedSeed, mode: CatalogMode, reach: HomeSourcesSnapshot): string {
  const { youtube, spotify, mediaBytes } = reach.capabilities
  const artistId = isTrackSeed(seed.seed) ? '' : (seed.seed.id ?? '')
  const parts = seed.parts.join('+')
  const switches = `${youtube},${spotify},${mediaBytes},${reach.spotifyEnabled}`
  return [seed.key, artistId, parts, mode, switches].join('|')
}

/** Whether a seed names a YouTube artist or track, which YouTube Music's radio starts from. */
function hasYouTubeId(seed: PlannedSeed): boolean {
  if (isTrackSeed(seed.seed)) return true
  const source = seed.seed.id === undefined ? undefined : parseId(seed.seed.id).source
  return source === 'ytm' || source === 'yt'
}

/**
 * Artist seeds with YouTube Music's own artist, found by name (onboarding picks are names):
 * only an artist with the same name counts, so the seed keeps its key. Seeds that can't be
 * found stay as they are, for the sources that work from names.
 */
async function withYouTubeArtists(
  request: FeedRequest,
  seeds: readonly PlannedSeed[],
  ctx: ProviderContext,
): Promise<PlannedSeed[]> {
  const catalog = request.services.catalog
  const findArtist = catalog?.findArtist?.bind(catalog)
  if (catalog === undefined || findArtist === undefined || ctx.capabilities.youtube === 'none') {
    return [...seeds]
  }
  const found = request.artists ?? artistsOf(catalog)
  return mapLimit(seeds, FEED_LIMITS.concurrency, async (seed) => {
    if (hasYouTubeId(seed) || isTrackSeed(seed.seed)) return seed
    const { name } = seed.seed
    const key = artistKeyOf(name)
    if (key === undefined) return seed
    let artist = found.get(key)
    if (artist === undefined) {
      try {
        artist = await findArtist(name, ctx)
        // Only answers are kept: after a failure, the next build asks again.
        if (found.size >= MAX_FOUND_ARTISTS) found.clear()
        found.set(key, artist)
      } catch {
        throwIfAborted(request.signal)
        artist = null
      }
    }
    if (artist === null || artistKeyOf(artist.name) !== key || !isEntityId(artist.id, 'artist')) {
      return seed
    }
    return { ...seed, seed: { name, id: artist.id } }
  })
}

/** The candidates the sources suggest for every seed. */
async function collectAll(
  request: FeedRequest,
  seeds: readonly PlannedSeed[],
  ctx: ProviderContext,
  reach: HomeSourcesSnapshot,
  now: number,
): Promise<RecCandidate[]> {
  const recommendations = request.services.recommendations
  if (recommendations === undefined) return []
  const cache = request.cache ?? collectionsOf(recommendations)
  const collections = await mapLimit(seeds, FEED_LIMITS.concurrency, (seed) => {
    const key = collectionKey(seed, request.mode, reach)
    const cached = cache.get(key, now)
    if (cached !== undefined) return Promise.resolve(cached)
    return quietly(request.signal, [] as readonly RecCandidate[], async () => {
      const { candidates, outcomes = [] } = await recommendations.collect(seed.seed, ctx, {
        parts: seed.parts,
        limit: FEED_LIMITS.perSource,
      })
      // A source that failed (a network blip, a pause) may answer next time: keep only whole
      // collections.
      if (!outcomes.some((outcome) => outcome.status === 'failed')) {
        cache.set(key, candidates, now)
      }
      return candidates
    })
  })
  return collections.flat()
}

/** The tracks of the similar artists and song searches worth fetching, as candidates. */
async function expansions(
  request: FeedRequest,
  candidates: readonly RecCandidate[],
  taste: TasteIndex,
  seeds: readonly PlannedSeed[],
  ctx: ProviderContext,
): Promise<RecCandidate[]> {
  const catalog = request.services.catalog
  if (catalog === undefined) return []
  const weights = new Map(seeds.map((seed) => [seed.key, seed.weight]))
  const pool = poolCandidates(candidates, {
    mode: request.mode,
    seedWeight: (seed) => weights.get(seedKey(seed) ?? '') ?? seedWeight(taste, seed),
  })
  const plan = planExpansions(pool, taste, {
    maxArtists: catalog.artistTracks === undefined ? 0 : FEED_LIMITS.artists,
    maxSongs: catalog.findSong === undefined ? 0 : FEED_LIMITS.songs,
  })
  const jobs: Array<() => Promise<RecCandidate[]>> = [
    ...plan.artists.map((artist) => async () => {
      const tracks = (await catalog.artistTracks?.(artist.artist, ctx)) ?? []
      return artistTrackCandidates(artist, tracks)
    }),
    ...plan.songs.map((song) => async () => {
      const track = await catalog.findSong?.(
        {
          title: song.title,
          artists: song.artists,
          ...(song.durationMs === undefined ? {} : { durationMs: song.durationMs }),
        },
        ctx,
      )
      return track === undefined || track === null ? [] : songTrackCandidates(song, track)
    }),
  ]
  const results = await mapLimit(jobs, 2, (job) => quietly(request.signal, [], job))
  return results.flat()
}

/**
 * Spotify's personal sections: only when Spotify is switched on and reachable and the account
 * is connected. Anything that fails means none.
 */
async function spotifySections(
  request: FeedRequest,
  ctx: ProviderContext,
  reach: HomeSourcesSnapshot,
): Promise<{ connected: boolean; shelves: readonly HomeSourceShelf[] }> {
  const { recommendations, spotifyAccount } = request.services
  if (
    recommendations === undefined ||
    spotifyAccount === undefined ||
    !reach.spotifyEnabled ||
    reach.capabilities.spotify === 'unreachable'
  ) {
    return { connected: false, shelves: [] }
  }
  const connected = await quietly(request.signal, false, async () => {
    return (await spotifyAccount.status(ctx)).connected === true
  })
  if (!connected) return { connected: false, shelves: [] }
  const shelves = await quietly(request.signal, [] as readonly HomeSourceShelf[], async () =>
    (await recommendations.home(ctx)).shelves.filter((shelf) => shelf.source === 'spotify'),
  )
  return { connected: true, shelves }
}

/** Builds Home (see the module documentation). */
export async function buildHomeFeed(request: FeedRequest): Promise<HomeFeedResult> {
  const { mode, services, signal } = request
  const now = request.now ?? Date.now()
  const utcOffsetMinutes = request.utcOffsetMinutes ?? -new Date(now).getTimezoneOffset()
  const profile = await loadTasteProfile(request.repo, request.picks)
  throwIfAborted(signal)
  const taste = indexTaste(profile, now)
  const seeds = planSeeds(taste, { mode })
  const reach = services.sources.getSnapshot()
  const recommending = canRecommend(services, reach)
  const ctx = services.sources.context({ mode, ...(signal === undefined ? {} : { signal }) })

  const candidates: RecCandidate[] = []
  if (recommending) {
    const sought = await withYouTubeArtists(request, seeds, ctx)
    candidates.push(...(await collectAll(request, sought, ctx, reach, now)))
    candidates.push(...(await expansions(request, candidates, taste, seeds, ctx)))
  }
  const spotify = await spotifySections(request, ctx, reach)
  throwIfAborted(signal)

  const feed = buildHome({
    profile,
    candidates,
    seeds,
    sourceShelves: spotify.shelves,
    spotifyConnected: spotify.connected,
    mode,
    now,
    utcOffsetMinutes,
    stable: request.stable.load(),
    ...(request.random === undefined ? {} : { random: request.random }),
  })
  request.stable.save(feed.stable)
  return { ...feed, recommending, spotifyConnected: spotify.connected }
}
