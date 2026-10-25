/**
 * Collects recommendations for a seed from every source that can run, and turns their outputs
 * into the one candidate format of `types.ts`. See the README for what runs where.
 *
 * @module
 */

import {
  type Artist,
  applyModeFilter,
  type CatalogMode,
  type EntityId,
  entityKey,
  filterPlayable,
  isFxmError,
  isTrackSeed,
  type ProviderContext,
  parseId,
  type RadioSeed,
  type Shelf,
  type ShelfItem,
  type Track,
} from '@fxm/core'
import type { LastfmApi } from '../lastfm/api'
import type { LastfmStations } from '../lastfm/station'
import type { ListenBrainzClient } from '../listenbrainz/api'
import {
  type ArtistMbidLookup,
  type ClassificationBudget,
  FULL_TIER,
  type SongForVideo,
  SPOTIFY_ON,
  type SpotifyMetadata,
  type SpotifyRadio,
  type SpotifySwitch,
  type TierCheck,
  UNLIMITED_CLASSIFICATION_BUDGET,
  type YouTubeLookup,
  type YouTubeRadio,
} from './adapters'
import { artistKey, songKey } from './internal/text'
import { seedArtist, seedArtistName, seedRef, seedTitle, youtubeRadioSeed } from './seeds'
import { rankScore, stationCandidates } from './stations'
import type {
  ArtistCandidate,
  CandidateArtist,
  Collection,
  HomeCollection,
  RecommendationCandidate,
  RecommendationPart,
  RecommendationSource,
  SeedRef,
  SkipReason,
  SourceOutcome,
  SourceShelf,
  TrackCandidate,
} from './types'

/** The sources and adapters a collector uses. Every one is optional: leave out what the app lacks. */
export interface RecommendationCollectorOptions {
  /** YouTube Music's radio and home feed (stage 1.3). */
  youtube?: YouTubeRadio
  /** Looks YouTube videos up, to classify Last.fm station items in Music mode (stage 1.3). */
  youtubeLookup?: YouTubeLookup
  /** Spotify's radio and home feed (stage 1.5). */
  spotify?: SpotifyRadio
  /** Spotify's related artists and artist search (stage 1.5). */
  spotifyMetadata?: SpotifyMetadata
  /** Whether the user's Spotify switch is on. Default: on. */
  spotifyEnabled?: SpotifySwitch
  /** Last.fm's station JSON (Full tier). */
  lastfmStations?: LastfmStations
  /** The Last.fm API, for similar artists: only when the app has a Last.fm API key. */
  lastfmApi?: LastfmApi
  /** ListenBrainz's labs API, for similar artists. */
  listenbrainz?: ListenBrainzClient
  /** The request budget's room for classifying station items (stage 1.2). Default: unlimited. */
  classificationBudget?: ClassificationBudget
  /** Whether the platform is in the Full tier (stage 1.2). Default {@link FULL_TIER}. */
  fullTier?: TierCheck
  /** The video-to-song rule (stage 1.7). Without it, official videos without a link don't count. */
  songForVideo?: SongForVideo
  /** MusicBrainz IDs for artist seeds (stage 1.6). Without it, ListenBrainz skips artist seeds. */
  artistMbid?: ArtistMbidLookup
  /** Classify at most this many items of one Last.fm station. Default 8. */
  maxClassifications?: number
}

/** Options for one {@link RecommendationCollector.collect} call. */
export interface CollectOptions {
  /** Which parts to run. Default `radio`, `station` and `similar-artists`. */
  parts?: readonly RecommendationPart[]
  /** At most this many candidates from each source and part. Default 50. */
  limit?: number
}

/** Collects recommendations from every source that can run. */
export interface RecommendationCollector {
  /**
   * Candidates for `seed` from every source that can run on this platform, in this mode, with
   * the user's settings, all at once. A source that fails, or cannot run, adds nothing and
   * reports why in `outcomes`; only a cancelled `ctx.signal` rejects, with its reason.
   *
   * - **YouTube Music radio** (`radio`), whenever YouTube can be reached. In Music mode it is
   *   seeded with the song and filtered to songs.
   * - **Spotify radio** (`radio`) and **related artists** (`similar-artists`), when Spotify is
   *   switched on and reachable.
   * - **Last.fm's similar-artists station** (`station`), in the Full tier only. In Music mode its
   *   YouTube videos are classified within the request budget, else kept as song searches.
   * - **Last.fm similar artists** (`similar-artists`), with an API key.
   * - **ListenBrainz similar artists** (`similar-artists`), which need no key.
   */
  collect(seed: RadioSeed, ctx: ProviderContext, options?: CollectOptions): Promise<Collection>
  /**
   * The home feeds of the sources that have one (YouTube Music; Spotify when it is on and
   * reachable), with their tracks filtered to the catalog mode.
   */
  home(ctx: ProviderContext): Promise<HomeCollection>
}

/** The parts {@link RecommendationCollector.collect} runs by default. */
export const DEFAULT_PARTS: readonly RecommendationPart[] = ['radio', 'station', 'similar-artists']

/** What one source's job yields. */
interface JobResult<T> {
  items: T[]
  outcome: SourceOutcome
}

/** A job that did not run. */
class Skip {
  constructor(readonly reason: SkipReason) {}
}

/**
 * The tracks of a list that recommendations may hold in `mode`: songs in Music mode ("filtered
 * to songs"), anything but episodes in Music + Video. Each track once.
 */
export function tracksForMode(tracks: readonly Track[], mode: CatalogMode): Track[] {
  const kept = mode === 'music' ? filterPlayable(tracks, 'music') : applyModeFilter(tracks, mode)
  const seen = new Set<string>()
  return kept.filter((track) => {
    const key = entityKey(track.id)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A shelf's items that may show in `mode`: tracks filtered like {@link tracksForMode}. */
function shelfForMode(shelf: Shelf, mode: CatalogMode): Shelf {
  const tracks = tracksForMode(
    shelf.items.flatMap((item) => (item.type === 'track' ? [item.track] : [])),
    mode,
  )
  const kept = new Set(tracks)
  const items = shelf.items.filter(
    (item: ShelfItem) => item.type !== 'track' || kept.has(item.track),
  )
  return { ...shelf, items }
}

/** Runs one source's job and records what happened. Only a cancellation rejects. */
async function run<T>(
  source: RecommendationSource,
  part: RecommendationPart,
  ctx: ProviderContext,
  job: () => Promise<T[] | Skip>,
): Promise<JobResult<T>> {
  try {
    const result = await job()
    if (result instanceof Skip) {
      return { items: [], outcome: { source, part, status: 'skipped', reason: result.reason } }
    }
    return { items: result, outcome: { source, part, status: 'ok', count: result.length } }
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason
    if (isFxmError(error, 'Unsupported')) {
      return { items: [], outcome: { source, part, status: 'skipped', reason: 'unsupported-seed' } }
    }
    const code = isFxmError(error) ? error.code : 'Unknown'
    const message = error instanceof Error ? error.message : String(error)
    return { items: [], outcome: { source, part, status: 'failed', code, message } }
  }
}

/** Tracks as candidates of one source and part, scored by rank. */
function trackCandidates(
  tracks: readonly Track[],
  source: RecommendationSource,
  part: RecommendationPart,
  seed: SeedRef,
): TrackCandidate[] {
  return tracks.map((track, rank) => ({
    type: 'track',
    source,
    part,
    seed,
    rank,
    score: rankScore(rank, tracks.length),
    key: songKey(track.artists[0]?.name ?? '', track.title),
    track,
  }))
}

/** An artist candidate, unless it is the seed's own artist. */
function artistCandidate(
  artist: CandidateArtist,
  base: Omit<ArtistCandidate, 'type' | 'artist' | 'key'>,
  seedKey: string,
): ArtistCandidate | null {
  const key = artistKey(artist.name)
  if (key === '' || key === seedKey) return null
  return { ...base, type: 'artist', key, artist }
}

/** The Spotify artist ID of the seed's main artist, when its source is Spotify. */
function spotifyArtistId(seed: RadioSeed): EntityId<'artist'> | undefined {
  const id = seedArtist(seed)?.id
  return id !== undefined && parseId(id).source === 'spotify' ? id : undefined
}

/** Creates a {@link RecommendationCollector} over the given sources and adapters. */
export function createRecommendationCollector(
  options: RecommendationCollectorOptions = {},
): RecommendationCollector {
  const spotifyEnabled = options.spotifyEnabled ?? SPOTIFY_ON
  const fullTier = options.fullTier ?? FULL_TIER
  const budget = options.classificationBudget ?? UNLIMITED_CLASSIFICATION_BUDGET
  const maxClassifications = options.maxClassifications ?? 8

  /** Why Spotify cannot run now, or `undefined` when it can. */
  function spotifySkip(ctx: ProviderContext): SkipReason | undefined {
    if (!spotifyEnabled()) return 'switched-off'
    if (ctx.capabilities.spotify === 'unreachable') return 'unreachable'
    return undefined
  }

  /** The Spotify artist to ask for related artists: the seed's own, else a search by name. */
  async function spotifyArtist(
    seed: RadioSeed,
    metadata: SpotifyMetadata,
    ctx: ProviderContext,
  ): Promise<EntityId<'artist'> | undefined> {
    const own = spotifyArtistId(seed)
    if (own !== undefined) return own
    const name = seedArtistName(seed)
    if (name === '') return undefined
    const results = await metadata.search(name, { types: ['artist'], limit: 5 }, ctx)
    const wanted = artistKey(name)
    return results.artists?.items.find((artist) => artistKey(artist.name) === wanted)?.id
  }

  /** The MusicBrainz ID of the seed's main artist, for ListenBrainz. */
  async function artistMbid(
    seed: RadioSeed,
    listenbrainz: ListenBrainzClient,
    ctx: ProviderContext,
  ): Promise<string | undefined> {
    if (!isTrackSeed(seed)) {
      return (await options.artistMbid?.(seed, ctx)) ?? undefined
    }
    const artist = seedArtistName(seed)
    const title = seedTitle(seed)
    if (artist === '' || title === '') return undefined
    const lookup = await listenbrainz.lookupRecording(artist, title, ctx)
    return lookup?.artistMbids[0]
  }

  return {
    async collect(seed, ctx, { parts = DEFAULT_PARTS, limit = 50 } = {}) {
      const ref = seedRef(seed)
      const seedKey = artistKey(seedArtistName(seed))
      const wants = (part: RecommendationPart) => parts.includes(part)
      const jobs: Array<Promise<JobResult<RecommendationCandidate>>> = []
      const job = (
        source: RecommendationSource,
        part: RecommendationPart,
        work: () => Promise<RecommendationCandidate[] | Skip>,
      ) => {
        if (wants(part)) jobs.push(run(source, part, ctx, work))
      }

      job('ytm', 'radio', async () => {
        const { youtube } = options
        if (youtube === undefined) return new Skip('not-configured')
        if (ctx.capabilities.youtube === 'none') return new Skip('unreachable')
        const radioSeed = await youtubeRadioSeed(seed, ctx, options.songForVideo)
        if (radioSeed === null) return new Skip('unsupported-seed')
        const tracks = tracksForMode(await youtube.radio(radioSeed, ctx), ctx.mode)
        return trackCandidates(tracks.slice(0, limit), 'ytm', 'radio', ref)
      })

      job('spotify', 'radio', async () => {
        const { spotify } = options
        if (spotify === undefined) return new Skip('not-configured')
        const skip = spotifySkip(ctx)
        if (skip !== undefined) return new Skip(skip)
        const tracks = tracksForMode(await spotify.radio(seed, ctx), ctx.mode)
        return trackCandidates(tracks.slice(0, limit), 'spotify', 'radio', ref)
      })

      job('spotify', 'similar-artists', async () => {
        const metadata = options.spotifyMetadata
        const getRelated = metadata?.getRelatedArtists?.bind(metadata)
        if (metadata === undefined || getRelated === undefined) return new Skip('not-configured')
        const skip = spotifySkip(ctx)
        if (skip !== undefined) return new Skip(skip)
        const id = await spotifyArtist(seed, metadata, ctx)
        if (id === undefined) return new Skip('unsupported-seed')
        const related: Artist[] = (await getRelated(id, ctx)).slice(0, limit)
        return related.flatMap((artist, rank) => {
          const candidate = artistCandidate(
            { name: artist.name, id: artist.id, artwork: artist.artwork },
            {
              source: 'spotify',
              part: 'similar-artists',
              seed: ref,
              rank,
              score: rankScore(rank, related.length),
            },
            seedKey,
          )
          return candidate === null ? [] : [candidate]
        })
      })

      job('lastfm', 'station', async () => {
        const stations = options.lastfmStations
        if (stations === undefined) return new Skip('not-configured')
        if (!fullTier(ctx.capabilities)) return new Skip('needs-full-tier')
        const artist = seedArtistName(seed)
        if (artist === '') return new Skip('unsupported-seed')
        const items = await stations.station({ type: 'similar', artist }, ctx)
        return stationCandidates(items.slice(0, limit), ref, ctx, {
          budget,
          maxClassifications,
          ...(options.youtubeLookup === undefined ? {} : { lookup: options.youtubeLookup }),
          ...(options.songForVideo === undefined ? {} : { songForVideo: options.songForVideo }),
        })
      })

      job('lastfm', 'similar-artists', async () => {
        const api = options.lastfmApi
        if (api === undefined) return new Skip('not-configured')
        const artist = seedArtistName(seed)
        if (artist === '') return new Skip('unsupported-seed')
        const similar = await api.similarArtists(artist, ctx, { limit })
        return similar.flatMap((found, rank) => {
          const candidate = artistCandidate(
            {
              name: found.name,
              artwork: [],
              ...(found.mbid === undefined ? {} : { mbid: found.mbid }),
            },
            {
              source: 'lastfm',
              part: 'similar-artists',
              seed: ref,
              rank,
              score: found.match,
              attributionUrl: found.url,
            },
            seedKey,
          )
          return candidate === null ? [] : [candidate]
        })
      })

      job('listenbrainz', 'similar-artists', async () => {
        const { listenbrainz } = options
        if (listenbrainz === undefined) return new Skip('not-configured')
        const mbid = await artistMbid(seed, listenbrainz, ctx)
        if (mbid === undefined) return new Skip('unsupported-seed')
        const similar = await listenbrainz.similarArtists(mbid, ctx, { limit })
        return similar.flatMap((found, rank) => {
          const candidate = artistCandidate(
            { name: found.name, mbid: found.mbid, artwork: [] },
            {
              source: 'listenbrainz',
              part: 'similar-artists',
              seed: ref,
              rank,
              score: found.similarity,
            },
            seedKey,
          )
          return candidate === null ? [] : [candidate]
        })
      })

      const results = await Promise.all(jobs)
      return {
        candidates: results.flatMap((result) => result.items),
        outcomes: results.map((result) => result.outcome),
      }
    },

    async home(ctx) {
      const jobs: Array<Promise<JobResult<SourceShelf>>> = []
      const shelvesOf = (source: RecommendationSource, shelves: readonly Shelf[]) =>
        shelves
          .map((shelf) => ({ source, shelf: shelfForMode(shelf, ctx.mode) }))
          .filter(({ shelf }) => shelf.items.length > 0)

      jobs.push(
        run('ytm', 'home', ctx, async () => {
          const home = options.youtube?.home?.bind(options.youtube)
          if (home === undefined) return new Skip('not-configured')
          if (ctx.capabilities.youtube === 'none') return new Skip('unreachable')
          return shelvesOf('ytm', await home(ctx))
        }),
        run('spotify', 'home', ctx, async () => {
          const home = options.spotify?.home?.bind(options.spotify)
          if (home === undefined) return new Skip('not-configured')
          const skip = spotifySkip(ctx)
          if (skip !== undefined) return new Skip(skip)
          return shelvesOf('spotify', await home(ctx))
        }),
      )
      const results = await Promise.all(jobs)
      return {
        shelves: results.flatMap((result) => result.items),
        outcomes: results.map((result) => result.outcome),
      }
    },
  }
}
