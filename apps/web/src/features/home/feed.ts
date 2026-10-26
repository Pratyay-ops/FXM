/**
 * Building Home: the library reads and network calls around the pure engine of `@fxm/core`
 * (stage 3.3, `packages/core/src/recommend`).
 *
 * 1. **The taste profile** from the library (stage 3.1): the top tracks, artists and tags of the
 *    listening affinity, the tracks' cached metadata, the recent plays with their affinity, plus
 *    the onboarding picks.
 * 2. **The user's own shelves** (On repeat, Rediscover, and Discover and the Daily Mixes kept
 *    from earlier builds), from the library alone: a first pass Home shows at once
 *    (`onLocal`), while the sources are asked.
 * 3. **The seeds** the engine plans (`planSeeds`), with YouTube Music's own artist for an
 *    artist known only by name (`findArtist`), and for each seed the recommendation sources'
 *    candidates (`collect`, stage 3.2), a few seeds at a time. Collections are cached for half
 *    an hour, so rebuilding Home costs nothing new.
 * 4. **The rest of the taste:** the profile holds the top of the affinity only, so the affinity
 *    of every track and main artist the candidates name is read as well (two bulk reads), and
 *    a song the user skips or played long ago is never offered as new.
 * 5. **Expansions:** the few similar artists and song searches the engine ranks highest
 *    (`planExpansions`) become tracks through the catalog.
 * 6. **Spotify's personal sections**, when Spotify is switched on, reachable and the account is
 *    connected (stage 3.5), asked alongside the collections.
 * 7. **The shelves** (`buildHome`), with Discover and the Daily Mixes kept for their week and
 *    day in storage, along with the listening history they came from.
 *
 * Only YouTube Music's songs can play from recommendations, so Home recommends new music only
 * where YouTube Music is reachable (Lite or Full); in the Free-only tier it keeps to the user's
 * own music. A source that fails adds nothing, and the network steps get
 * {@link FEED_LIMITS}`.deadlineMs` in all: Home is then built from what arrived, and what is
 * still on its way is cached for the next build. Only a build that heard from every source in
 * time, and got YouTube Music's radio for every seed, keeps its lists for their period. Only a
 * cancellation rejects.
 *
 * @module
 */

import {
  type ArtistRef,
  artistAffinityKey,
  artistKeyOf,
  artistTrackCandidates,
  buildHome,
  type CatalogMode,
  entityKey,
  type HomeFeed,
  type HomeInput,
  type HomeOptionsInput,
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
import type { LibraryRepo, RecentRow } from '../../db/repo'
import {
  canRecommend,
  type HomeCatalog,
  type HomeRecommendations,
  type HomeServices,
  type HomeSourceOutcome,
  type HomeSourceShelf,
  type HomeSourcesSnapshot,
} from './services'
import type { HistoryBasis, StableStore } from './stable-storage'

/** How much of the library the profile reads. */
export interface ProfileLimits {
  /** Tracks by affinity: enough to hold old favourites for Rediscover. */
  readonly tracks: number
  /** Artists by affinity. */
  readonly artists: number
  /** Tags by affinity. */
  readonly tags: number
  /** Distinct recently played tracks, for the history filters. */
  readonly recent: number
}

/** How much of the library the profile reads by default. */
export const PROFILE_LIMITS: ProfileLimits = Object.freeze({
  tracks: 400,
  artists: 120,
  tags: 60,
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
  /**
   * How long the network steps may take in all, in milliseconds. Home is then built from what
   * arrived. The user's own shelves show at once either way.
   */
  deadlineMs: 8_000,
})

/** How long a seed's collection is reused. */
export const COLLECTION_TTL_MS = 30 * 60_000

/**
 * The first pass: no new lists of recommendations, which need the sources. What the library
 * alone gives stays: On repeat, Rediscover, and Discover and the mixes kept for their period.
 */
const LOCAL_PASS: HomeOptionsInput = {
  quickPicks: { limit: 0 },
  because: { shelves: 0 },
  mixes: { count: 0 },
}

/**
 * The taste profile the library holds, with the onboarding picks: the top of the affinity, and
 * the recent plays with theirs. A song the user skips at once has no affinity, only skips, so it
 * never makes the top: its recent plays bring it in, with its metadata, so other sources'
 * listings of it count as skipped too.
 */
export async function loadTasteProfile(
  repo: LibraryRepo,
  picks?: TastePicks,
  limits: ProfileLimits = PROFILE_LIMITS,
): Promise<TasteProfile> {
  const [tracks, artists, tags, recent] = await Promise.all([
    repo.topAffinity('track', limits.tracks),
    repo.topAffinity('artist', limits.artists),
    repo.topAffinity('tag', limits.tags),
    repo.recentlyPlayed(limits.recent),
  ])
  const top = new Set(tracks.map(({ entry }) => entry.key))
  const others = new Map<string, RecentRow>()
  for (const row of recent) {
    const key = entityKey(row.id)
    if (!top.has(key) && !others.has(key)) others.set(key, row)
  }
  const [cached, otherScores] = await Promise.all([
    Promise.all(
      tracks.map(({ entry }) => {
        const id = entry.ids.find((one) => isEntityId(one, 'track'))
        return id === undefined ? undefined : repo.getTrack(id)
      }),
    ),
    others.size === 0 ? [] : repo.getAffinity('track', [...others.keys()]),
  ])
  const profileTracks: ProfileTrack[] = tracks.map(({ entry }, index) => {
    const track = cached[index]
    return track === undefined ? { entry } : { entry, track }
  })
  ;[...others.values()].forEach((row, index) => {
    const entry = otherScores[index]?.entry
    if (entry === undefined) return
    profileTracks.push(row.track === undefined ? { entry } : { entry, track: row.track })
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

/**
 * The profile with the affinity of what `candidates` name and the profile lacks: their tracks
 * and main artists (two bulk reads, however many candidates). The profile holds the top of the
 * affinity only; without these, a song or artist the user skips (skips, no affinity) or a song
 * played long ago would count as unheard, and come back as new. Entries without metadata are
 * enough: candidates are matched to them by track and artist key.
 */
export async function completeProfile(
  repo: LibraryRepo,
  profile: TasteProfile,
  candidates: readonly RecCandidate[],
): Promise<TasteProfile> {
  const trackKeys = new Set<string>()
  const artistKeys = new Set<string>()
  const addArtist = (name: unknown) => {
    if (typeof name !== 'string') return
    // The affinity keys an artist by the name as credited; the engine merges the spellings a
    // YouTube channel suffix keeps apart ("Basalt - Topic"), so read both.
    for (const key of [artistAffinityKey(name), artistKeyOf(name)]) {
      if (key !== undefined) artistKeys.add(key)
    }
  }
  for (const candidate of candidates) {
    if (candidate?.type === 'track') {
      const { id, artists } = candidate.track ?? {}
      if (isEntityId(id, 'track')) trackKeys.add(entityKey(id))
      addArtist(Array.isArray(artists) ? artists[0]?.name : undefined)
    } else if (candidate?.type === 'song-search') {
      addArtist(Array.isArray(candidate.artists) ? candidate.artists[0] : undefined)
    } else if (candidate?.type === 'artist') {
      addArtist(candidate.artist?.name)
    }
  }
  for (const { entry } of profile.tracks ?? []) trackKeys.delete(entry?.key)
  for (const entry of profile.artists ?? []) artistKeys.delete(entry?.key)
  if (trackKeys.size === 0 && artistKeys.size === 0) return profile
  const [trackScores, artistScores] = await Promise.all([
    trackKeys.size === 0 ? [] : repo.getAffinity('track', [...trackKeys]),
    artistKeys.size === 0 ? [] : repo.getAffinity('artist', [...artistKeys]),
  ])
  const tracks = trackScores.flatMap((score) =>
    score === undefined ? [] : [{ entry: score.entry }],
  )
  const artists = artistScores.flatMap((score) => (score === undefined ? [] : [score.entry]))
  if (tracks.length === 0 && artists.length === 0) return profile
  return {
    ...profile,
    tracks: [...(profile.tracks ?? []), ...tracks],
    artists: [...(profile.artists ?? []), ...artists],
  }
}

/** What the sources suggest for one seed, as builds reuse it. */
export interface SeedCollection {
  /** The candidates. */
  readonly candidates: readonly RecCandidate[]
  /**
   * Whether YouTube Music's radio skipped the seed: it had nothing to start from, such as a
   * track of another source without a sure match of its own song, or that song's radio didn't
   * follow the track. Discover and the mixes then lack what the radio would have brought, so a
   * build with such a seed doesn't keep them for their period.
   */
  readonly radioSkipped: boolean
}

/** Seed collections reused between builds, for {@link COLLECTION_TTL_MS}. */
export interface CollectionCache {
  get(key: string, now: number): SeedCollection | undefined
  set(key: string, collection: SeedCollection, now: number): void
}

/** A {@link CollectionCache} in memory, holding at most `size` collections. */
export function createCollectionCache(ttlMs = COLLECTION_TTL_MS, size = 64): CollectionCache {
  const entries = new Map<string, { at: number; collection: SeedCollection }>()
  return {
    get(key, now) {
      const entry = entries.get(key)
      if (entry === undefined || now - entry.at > ttlMs || now < entry.at) return undefined
      return entry.collection
    },
    set(key, collection, now) {
      entries.delete(key)
      entries.set(key, { at: now, collection })
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
  /**
   * Called with the first pass, the user's own shelves, as soon as the library has been read,
   * when the sources are still to be asked.
   */
  readonly onLocal?: (feed: HomeFeedResult) => void
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
  /** How long the network steps may take in all. Default: {@link FEED_LIMITS}`.deadlineMs`. */
  readonly deadlineMs?: number
  /** How much of the library the profile reads. Default: {@link PROFILE_LIMITS}. */
  readonly profileLimits?: ProfileLimits
}

/** A built Home and what it could reach. */
export interface HomeFeedResult extends HomeFeed {
  /** Whether recommendation sources ran: wired in, and YouTube Music reachable. */
  readonly recommending: boolean
  /** Whether a connected Spotify account's sections were asked for. */
  readonly spotifyConnected: boolean
  /**
   * `local` for the first pass, the user's own shelves from the library alone, shown while the
   * sources are asked; `full` for the whole of Home.
   */
  readonly phase: 'local' | 'full'
  /** Whether every source answered in time. A Home that misses some is built again sooner. */
  readonly complete: boolean
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('Home was not needed any more', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

/** The time limit of a build's network steps, and its cancellation. */
interface Clock {
  /** Whether the time is up. */
  readonly passed: boolean
  /** Resolves when the time is up; never, without a limit. */
  readonly reached: Promise<void>
  /** Rejects with the reason when the build is cancelled. */
  readonly cancelled: Promise<never>
  /** Stops the clock. */
  dispose(): void
}

function startClock(ms: number, signal: AbortSignal | undefined): Clock {
  let passed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const reached = new Promise<void>((resolve) => {
    if (!Number.isFinite(ms)) return
    timer = setTimeout(
      () => {
        passed = true
        resolve()
      },
      Math.max(0, ms),
    )
  })
  const cancelled = new Promise<never>((_, reject) => {
    if (signal === undefined) return
    onAbort = () => reject(abortReason(signal))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  // Raced against every step; nothing else waits for it.
  cancelled.catch(() => {})
  return {
    get passed() {
      return passed
    },
    reached,
    cancelled,
    dispose() {
      clearTimeout(timer)
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** One build's network steps: what they share, and whether everything answered so far. */
interface Run {
  readonly request: FeedRequest
  readonly ctx: ProviderContext
  readonly reach: HomeSourcesSnapshot
  readonly now: number
  readonly clock: Clock
  /** Whether every collection, artist search and expansion so far answered in time. */
  complete: boolean
  /** Whether YouTube Music's radio skipped a seed so far (see {@link SeedCollection}). */
  radioSkipped: boolean
}

/**
 * Runs one network step: its result, or `fallback` when it fails or the time is up first. A
 * step the time cut short goes on, so what it caches serves the next build. `ok` says whether
 * the step answered. Only a cancellation rejects.
 */
async function step<R>(
  run: Run,
  fallback: R,
  work: () => Promise<R>,
): Promise<{ value: R; ok: boolean }> {
  throwIfAborted(run.request.signal)
  if (run.clock.passed) return { value: fallback, ok: false }
  const answer = work().then(
    (value) => ({ value, ok: true }),
    () => {
      throwIfAborted(run.request.signal)
      return { value: fallback, ok: false }
    },
  )
  const late = run.clock.reached.then(() => ({ value: fallback, ok: false }))
  return Promise.race([answer, late, run.clock.cancelled])
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
async function withYouTubeArtists(run: Run, seeds: readonly PlannedSeed[]): Promise<PlannedSeed[]> {
  const catalog = run.request.services.catalog
  const findArtist = catalog?.findArtist?.bind(catalog)
  if (
    catalog === undefined ||
    findArtist === undefined ||
    run.ctx.capabilities.youtube === 'none'
  ) {
    return [...seeds]
  }
  const found = run.request.artists ?? artistsOf(catalog)
  return mapLimit(seeds, FEED_LIMITS.concurrency, async (seed) => {
    if (hasYouTubeId(seed) || isTrackSeed(seed.seed)) return seed
    const { name } = seed.seed
    const key = artistKeyOf(name)
    if (key === undefined) return seed
    let artist = found.get(key)
    if (artist === undefined) {
      const answer = await step(run, null, async () => {
        const one = await findArtist(name, run.ctx)
        // Only answers are kept: after a failure, the next build asks again.
        if (found.size >= MAX_FOUND_ARTISTS) found.clear()
        found.set(key, one)
        return one
      })
      if (!answer.ok) run.complete = false
      artist = answer.value
    }
    if (artist === null || artistKeyOf(artist.name) !== key || !isEntityId(artist.id, 'artist')) {
      return seed
    }
    return { ...seed, seed: { name, id: artist.id } }
  })
}

/** Whether an outcome says YouTube Music's radio skipped the seed. */
function skipsRadio(outcome: HomeSourceOutcome): boolean {
  return outcome.source === 'ytm' && outcome.part === 'radio' && outcome.status === 'skipped'
}

/** The candidates the sources suggest for every seed. */
async function collectAll(run: Run, seeds: readonly PlannedSeed[]): Promise<RecCandidate[]> {
  const { request, reach, now } = run
  const recommendations = request.services.recommendations
  if (recommendations === undefined) return []
  const cache = request.cache ?? collectionsOf(recommendations)
  const empty = { candidates: [] as readonly RecCandidate[], radioSkipped: false, whole: false }
  const collections = await mapLimit(seeds, FEED_LIMITS.concurrency, async (seed) => {
    const key = collectionKey(seed, request.mode, reach)
    let collection = cache.get(key, now)
    if (collection === undefined) {
      const { value, ok } = await step(run, empty, async () => {
        const { candidates, outcomes = [] } = await recommendations.collect(seed.seed, run.ctx, {
          parts: seed.parts,
          limit: FEED_LIMITS.perSource,
        })
        const answer: SeedCollection = { candidates, radioSkipped: outcomes.some(skipsRadio) }
        // A source that failed (a network blip, a pause) may answer next time: keep only whole
        // collections.
        const whole = !outcomes.some((outcome) => outcome.status === 'failed')
        if (whole) cache.set(key, answer, now)
        return { ...answer, whole }
      })
      if (!ok || !value.whole) run.complete = false
      collection = value
    }
    if (collection.radioSkipped) run.radioSkipped = true
    return collection.candidates
  })
  return collections.flat()
}

/** The tracks of the similar artists and song searches worth fetching, as candidates. */
async function expansions(
  run: Run,
  candidates: readonly RecCandidate[],
  taste: TasteIndex,
  seeds: readonly PlannedSeed[],
): Promise<RecCandidate[]> {
  const { request, ctx } = run
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
  const results = await mapLimit(jobs, 2, async (job) => {
    const { value, ok } = await step(run, [] as RecCandidate[], job)
    if (!ok) run.complete = false
    return value
  })
  return results.flat()
}

/** Whether Spotify's personal sections may be asked for: switched on, reachable, wired in. */
function asksSpotify(services: HomeServices, reach: HomeSourcesSnapshot): boolean {
  return (
    services.recommendations !== undefined &&
    services.spotifyAccount !== undefined &&
    reach.spotifyEnabled &&
    reach.capabilities.spotify !== 'unreachable'
  )
}

/**
 * Spotify's personal sections: only when Spotify is switched on and reachable and the account
 * is connected. Anything that fails or comes too late means none; `answered` says whether
 * Spotify did answer.
 */
async function spotifySections(
  run: Run,
): Promise<{ connected: boolean; shelves: readonly HomeSourceShelf[]; answered: boolean }> {
  const { recommendations, spotifyAccount } = run.request.services
  if (
    recommendations === undefined ||
    spotifyAccount === undefined ||
    !asksSpotify(run.request.services, run.reach)
  ) {
    return { connected: false, shelves: [], answered: true }
  }
  const status = await step(
    run,
    false,
    async () => (await spotifyAccount.status(run.ctx)).connected === true,
  )
  if (!status.value) return { connected: false, shelves: [], answered: status.ok }
  const home = await step(run, [] as readonly HomeSourceShelf[], async () =>
    (await recommendations.home(run.ctx)).shelves.filter((shelf) => shelf.source === 'spotify'),
  )
  return { connected: true, shelves: home.value, answered: home.ok }
}

/** The listening history Home's lists are built from (see `stable-storage.ts`). */
async function historyBasis(repo: LibraryRepo): Promise<HistoryBasis> {
  return (await repo.historyStart()) ?? null
}

/** Builds Home (see the module documentation). */
export async function buildHomeFeed(request: FeedRequest): Promise<HomeFeedResult> {
  const { mode, services, signal } = request
  const now = request.now ?? Date.now()
  const utcOffsetMinutes = request.utcOffsetMinutes ?? -new Date(now).getTimezoneOffset()
  const [profile, history] = await Promise.all([
    loadTasteProfile(request.repo, request.picks, request.profileLimits),
    historyBasis(request.repo),
  ])
  throwIfAborted(signal)
  const taste = indexTaste(profile, now)
  const seeds = planSeeds(taste, { mode })
  const reach = services.sources.getSnapshot()
  const recommending = canRecommend(services, reach)
  const common: Omit<HomeInput, 'profile'> = {
    seeds,
    mode,
    now,
    utcOffsetMinutes,
    stable: request.stable.load(history),
    ...(request.random === undefined ? {} : { random: request.random }),
  }

  if (!recommending && !asksSpotify(services, reach)) {
    // Nothing to ask anyone: the user's own music is all of Home. Lists made without the
    // sources aren't kept, so the first build that can ask them makes its own.
    const feed = buildHome({ ...common, profile, taste })
    return { ...feed, recommending, spotifyConnected: false, phase: 'full', complete: true }
  }

  if (request.onLocal !== undefined) {
    const local = buildHome({ ...common, profile, taste, options: LOCAL_PASS })
    request.onLocal({
      ...local,
      recommending,
      spotifyConnected: false,
      phase: 'local',
      complete: false,
    })
  }

  const clock = startClock(request.deadlineMs ?? FEED_LIMITS.deadlineMs, signal)
  try {
    const run: Run = {
      request,
      ctx: services.sources.context({ mode, ...(signal === undefined ? {} : { signal }) }),
      reach,
      now,
      clock,
      complete: true,
      radioSkipped: false,
    }
    const spotifyAsked = spotifySections(run)
    // Awaited below; a cancellation that ends the build first must not leave it unhandled.
    spotifyAsked.catch(() => {})
    let candidates: RecCandidate[] = []
    let completed = profile
    let index = taste
    if (recommending) {
      const collected = await collectAll(run, await withYouTubeArtists(run, seeds))
      completed = await completeProfile(request.repo, profile, collected)
      if (completed !== profile) index = indexTaste(completed, now)
      const expanded = await expansions(run, collected, index, seeds)
      const final = await completeProfile(request.repo, completed, expanded)
      if (final !== completed) {
        completed = final
        index = indexTaste(final, now)
      }
      candidates = [...collected, ...expanded]
    }
    const spotify = await spotifyAsked
    throwIfAborted(signal)

    const feed = buildHome({
      ...common,
      profile: completed,
      taste: index,
      candidates,
      sourceShelves: spotify.shelves,
      spotifyConnected: spotify.connected,
    })
    // Only a build that heard from every source, and got YouTube Music's radio for every seed,
    // keeps its lists for their period: a Discover made while a source failed or was slow, or
    // without a seed's radio, would be thin or lopsided all week.
    if (recommending && run.complete && !run.radioSkipped) {
      request.stable.save(feed.stable, history)
    }
    return {
      ...feed,
      recommending,
      spotifyConnected: spotify.connected,
      phase: 'full',
      complete: run.complete && spotify.answered,
    }
  } finally {
    clock.dispose()
  }
}
