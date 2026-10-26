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
  isTrackSeed,
  type ProviderContext,
  parseId,
  type Shelf,
  type ShelfItem,
  type Track,
} from '@fxm/core'
import type { LastfmApiClient } from '../lastfm/api'
import type { LastfmStations } from '../lastfm/station'
import type { ListenBrainzClient } from '../listenbrainz/api'
import { normalizeMbid } from '../shared/mbid'
import { sameArtist } from '../shared/names'
import { wholeNumber } from '../shared/numbers'
import { isSpotifyError } from '../spotify/errors'
import {
  type ArtistMbidLookup,
  type AutoMatchSetting,
  type ClassificationBudget,
  type SongForVideo,
  type SpotifyMetadata,
  type SpotifyRadio,
  type SpotifySwitch,
  UNLIMITED_CLASSIFICATION_BUDGET,
  type YouTubeLookup,
  type YouTubeRadio,
  type YouTubeSeedFinder,
} from './adapters'
import { deadlineOf, type Job, type JobResult, runJobs, Skip } from './jobs'
import { artistKey, songKey } from './keys'
import {
  isMusicMode,
  seedArtist,
  seedArtistMbid,
  seedArtistName,
  seedRef,
  seedTitle,
  youtubeRadioStart,
} from './seeds'
import {
  DEFAULT_MAX_CLASSIFICATION_MS,
  namesSameSong,
  rankScore,
  type SongName,
  stationCandidates,
} from './stations'
import type {
  ArtistCandidate,
  CandidateArtist,
  CandidatePart,
  Collection,
  HomeCollection,
  RecommendationCandidate,
  RecommendationSeed,
  RecommendationSource,
  SeedRef,
  SkipReason,
  SourceResult,
  SourceShelf,
  SourceShelves,
  TrackCandidate,
} from './types'

/** By default, classify at most this many station items' videos. */
export const DEFAULT_MAX_CLASSIFICATIONS = 8

/** By default, at most this many candidates from each source and part. */
export const DEFAULT_LIMIT = 50

/** The sources and adapters a collector uses. Every one is optional: leave out what the app lacks. */
export interface RecommendationCollectorOptions {
  /** YouTube Music's radio and home feed (stage 1.3). */
  youtube?: YouTubeRadio
  /** Looks YouTube videos up, to classify Last.fm station items in Music mode (stage 1.3). */
  youtubeLookup?: YouTubeLookup
  /**
   * Finds a YouTube seed for a seed without a YouTube ID, e.g. a Spotify track (stages 1.3 and
   * 1.7). Without it, YouTube Music radio skips such seeds (`unsupported-seed`).
   */
  youtubeSeed?: YouTubeSeedFinder
  /** Spotify's radio and home feed (stage 1.5). */
  spotify?: SpotifyRadio
  /** Spotify's related artists and artist search (stage 1.5). */
  spotifyMetadata?: SpotifyMetadata
  /**
   * Whether the user's Spotify switch is on. Default: the Spotify provider's own `isAvailable`
   * when it has one (stage 1.5's does), else on.
   */
  spotifyEnabled?: SpotifySwitch
  /** Last.fm's station JSON (Full tier: see its `reachable` option). */
  lastfmStations?: LastfmStations
  /** The Last.fm API, for similar artists: only when the app has a Last.fm API key. */
  lastfmApi?: LastfmApiClient
  /** ListenBrainz's labs API, for similar artists. */
  listenbrainz?: ListenBrainzClient
  /**
   * The request budget's room, and the context, for classifying station items (stage 1.2).
   * Default: no limit of its own, and the caller's context.
   */
  classificationBudget?: ClassificationBudget
  /**
   * The video-to-song rule (stage 1.7). Without it, official videos without a song link seed no
   * YouTube Music radio and become song searches in stations.
   */
  songForVideo?: SongForVideo
  /**
   * Whether the user's Auto setting lets matches play unasked (stage 1.7). Only then does a
   * station's official video become its matched song. Default: off.
   */
  autoMatch?: AutoMatchSetting
  /** MusicBrainz IDs for artist seeds that carry none (stage 1.6). Without it, ListenBrainz skips them. */
  artistMbid?: ArtistMbidLookup
  /**
   * Make at most this many classification calls for one Last.fm station (lookups, linked songs
   * and video-to-song calls). Default {@link DEFAULT_MAX_CLASSIFICATIONS}; a value that is not a
   * whole number of at least 0 means the default.
   */
  maxClassifications?: number
  /**
   * Stop classifying a station this many milliseconds after its first call; the rest become
   * song searches. Default {@link DEFAULT_MAX_CLASSIFICATION_MS}.
   */
  maxClassificationMs?: number
}

/** Options for one {@link RecommendationCollector.collect} call. */
export interface CollectOptions {
  /** Which parts to run. Default {@link DEFAULT_PARTS}. */
  parts?: readonly CandidatePart[]
  /**
   * At most this many candidates from each source and part. Default {@link DEFAULT_LIMIT}; a
   * value that is not a finite number means the default, and others are rounded down to 0 or
   * more.
   */
  limit?: number
  /**
   * Stop waiting after this many milliseconds: the sources that have not finished are cancelled
   * and reported as `timed-out`, and the call resolves with what the others found.
   */
  deadlineMs?: number
  /**
   * Called with each source's result as soon as it has one, in the order they finish, for
   * screens that show what is ready (sources that time out included). It must not throw: if it
   * does, the call rejects with its error.
   */
  onResult?: (result: SourceResult) => void
}

/** Options for one {@link RecommendationCollector.home} call. */
export interface HomeOptions {
  /** Stop waiting after this many milliseconds, as for {@link CollectOptions.deadlineMs}. */
  deadlineMs?: number
  /** Called with each source's shelves as soon as it has them. It must not throw. */
  onResult?: (result: SourceShelves) => void
}

/** Collects recommendations from every source that can run. */
export interface RecommendationCollector {
  /**
   * Candidates for `seed` from every source that can run on this platform, in this mode, with
   * the user's settings, all at once. A source that fails, cannot run, or misses the deadline
   * adds nothing and reports why in `outcomes`. Only a cancelled `ctx.signal` rejects, with its
   * reason, at once, whether or not the sources heed it.
   *
   * - **YouTube Music radio** (`radio`), whenever YouTube can be reached. In Music mode it is
   *   seeded with the song and filtered to songs. A track of another source seeds it with the
   *   YouTube Music song its match found (`youtubeSeed`), only when that is the track's own song,
   *   and the radio counts only when it follows the track: it begins with that song, or holds
   *   another song by the track's main artist. Otherwise the seed is skipped.
   * - **Spotify radio** (`radio`) and **related artists** (`similar-artists`), when Spotify is
   *   switched on and reachable.
   * - **Last.fm's similar-artists station** (`station`), in the Full tier only. In Music mode its
   *   YouTube videos are classified within the request budget, else kept as song searches.
   * - **Last.fm similar artists** (`similar-artists`), with an API key.
   * - **ListenBrainz similar artists** (`similar-artists`), which need no key.
   */
  collect(
    seed: RecommendationSeed,
    ctx: ProviderContext,
    options?: CollectOptions,
  ): Promise<Collection>
  /**
   * The home feeds of the sources that have one (YouTube Music; Spotify when it is on and
   * reachable), with their tracks filtered to the catalog mode.
   */
  home(ctx: ProviderContext, options?: HomeOptions): Promise<HomeCollection>
}

/** The parts {@link RecommendationCollector.collect} runs by default. */
export const DEFAULT_PARTS: readonly CandidatePart[] = ['radio', 'station', 'similar-artists']

/**
 * The tracks of a list that recommendations may hold in `mode`: songs in Music mode ("filtered
 * to songs"), anything but episodes in Music + Video. An unknown mode gets Music mode's rules.
 * Each track once.
 */
export function tracksForMode(tracks: readonly Track[], mode: CatalogMode): Track[] {
  const kept = isMusicMode(mode) ? filterPlayable(tracks, 'music') : applyModeFilter(tracks, 'all')
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

/** Tracks as candidates of one source and part, scored by rank. */
function trackCandidates(
  tracks: readonly Track[],
  source: RecommendationSource,
  part: CandidatePart,
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

/** A track as a song named by its title and artists, for {@link namesSameSong}. */
function songName(track: Track): SongName {
  return { title: track.title, artists: track.artists.map((artist) => artist.name) }
}

/**
 * Whether `song`, the YouTube Music song the `youtubeSeed` adapter found for `track` (a track of
 * another source), is that very song: its main artist is the track's main artist, and its title
 * proper and version are the track's (`namesSameSong`). The matching engine's best guess may be
 * another song altogether, whose radio has nothing to do with the track.
 */
function isOwnSong(song: Track, track: Track): boolean {
  const [main] = track.artists
  const [own] = song.artists
  if (main === undefined || own === undefined) return false
  return namesSameSong({ ...song, artists: [own] }, { title: track.title, artists: [main.name] })
}

/**
 * Whether the radio of `song`, the YouTube Music song found for `track` (a track of another
 * source), follows `track`: it begins with the song (another listing of it, since the radio
 * leaves out its seed), or it holds another song by the track's main artist. A radio that does
 * neither has drifted somewhere else, and says nothing about `track`.
 */
function radioFollows(radio: readonly Track[], song: Track, track: Track): boolean {
  const matched = songName(song)
  const [first] = radio
  if (first !== undefined && namesSameSong(first, matched)) return true
  const main = track.artists[0]?.name
  if (main === undefined) return false
  return radio.some(
    (other) =>
      !namesSameSong(other, matched) &&
      other.artists.some((artist) => sameArtist([main], artist.name)),
  )
}

/** An artist candidate, unless it has no name or is the seed's own artist. */
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
function spotifyArtistId(seed: RecommendationSeed): EntityId<'artist'> | undefined {
  const id = seedArtist(seed)?.id
  return id !== undefined && parseId(id as unknown)?.source === 'spotify' ? id : undefined
}

/**
 * The Spotify provider's explicit refusals that are skips: a seed it cannot place, and its own
 * switch and reachability checks (when the app's switch and the provider's disagree).
 */
function spotifySkipFor(error: unknown): SkipReason | undefined {
  if (isSpotifyError(error, 'unsupported-seed')) return 'unsupported-seed'
  if (isSpotifyError(error, 'disabled')) return 'switched-off'
  if (isSpotifyError(error, 'unreachable')) return 'unreachable'
  return undefined
}

/** Creates a {@link RecommendationCollector} over the given sources and adapters. */
export function createRecommendationCollector(
  options: RecommendationCollectorOptions = {},
): RecommendationCollector {
  const budget = options.classificationBudget ?? UNLIMITED_CLASSIFICATION_BUDGET
  const requested = options.maxClassifications
  const maxClassifications =
    requested !== undefined && Number.isInteger(requested) && requested >= 0
      ? requested
      : DEFAULT_MAX_CLASSIFICATIONS
  const maxClassificationMs = wholeNumber(
    options.maxClassificationMs,
    DEFAULT_MAX_CLASSIFICATION_MS,
  )

  /** Whether the user's Spotify switch is on: the app's switch, else the provider's own. */
  function spotifySwitchedOn(ctx: ProviderContext): boolean {
    if (options.spotifyEnabled !== undefined) return options.spotifyEnabled(ctx)
    const { spotify, spotifyMetadata } = options
    if (spotify?.isAvailable !== undefined) return spotify.isAvailable(ctx)
    if (spotifyMetadata?.isAvailable !== undefined) return spotifyMetadata.isAvailable(ctx)
    return true
  }

  /** Why Spotify cannot run now, or `undefined` when it can. */
  function spotifySkip(ctx: ProviderContext): SkipReason | undefined {
    if (ctx.capabilities.spotify === 'unreachable') return 'unreachable'
    if (!spotifySwitchedOn(ctx)) return 'switched-off'
    return undefined
  }

  /** The Spotify artist to ask for related artists: the seed's own, else a search by name. */
  async function spotifyArtist(
    seed: RecommendationSeed,
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

  /**
   * The MusicBrainz ID of the seed's main artist, for ListenBrainz: the one an artist seed
   * carries, else the `artistMbid` adapter's for an artist, ListenBrainz's lookup for a track.
   */
  async function artistMbid(
    seed: RecommendationSeed,
    listenbrainz: ListenBrainzClient,
    ctx: ProviderContext,
  ): Promise<string | undefined> {
    const known = seedArtistMbid(seed)
    if (known !== undefined) return known
    if (!isTrackSeed(seed)) {
      const found = await options.artistMbid?.(seed, ctx)
      // A value that is not an MBID is passed on as it is, for ListenBrainz to refuse loudly.
      return found === null || found === undefined ? undefined : (normalizeMbid(found) ?? found)
    }
    const artist = seedArtistName(seed)
    const title = seedTitle(seed)
    if (artist === '' || title === '') return undefined
    const lookup = await listenbrainz.lookupRecording(artist, title, ctx)
    return lookup?.artistMbids[0]
  }

  return {
    async collect(seed, ctx, { parts = DEFAULT_PARTS, limit, deadlineMs, onResult } = {}) {
      const count = wholeNumber(limit, DEFAULT_LIMIT)
      const ref = seedRef(seed)
      const seedKey = artistKey(seedArtistName(seed))
      const jobs: Job<RecommendationCandidate>[] = []
      const job = (
        source: RecommendationSource,
        part: CandidatePart,
        work: Job<RecommendationCandidate>['work'],
        skipFor?: Job<RecommendationCandidate>['skipFor'],
      ) => {
        if (!parts.includes(part)) return
        jobs.push(skipFor === undefined ? { source, part, work } : { source, part, work, skipFor })
      }

      job('ytm', 'radio', async (jobCtx) => {
        const { youtube } = options
        if (youtube === undefined) return new Skip('not-configured')
        if (jobCtx.capabilities.youtube === 'none') return new Skip('unreachable')
        if (count === 0) return []
        const start = await youtubeRadioStart(seed, jobCtx, {
          songForVideo: options.songForVideo,
          youtubeSeed: options.youtubeSeed,
        })
        if (start === null) return new Skip('unsupported-seed')
        // A track of another source seeds the radio with the song its match found, which must be
        // that very song; and the radio must still follow the track. Otherwise it is no radio
        // for this seed.
        if (start.matchedFrom !== undefined && !isOwnSong(start.seed, start.matchedFrom)) {
          return new Skip('unsupported-seed')
        }
        const tracks = tracksForMode(await youtube.radio(start.seed, jobCtx), jobCtx.mode)
        if (
          start.matchedFrom !== undefined &&
          !radioFollows(tracks, start.seed, start.matchedFrom)
        ) {
          return new Skip('unsupported-seed')
        }
        return trackCandidates(tracks.slice(0, count), 'ytm', 'radio', ref)
      })

      job(
        'spotify',
        'radio',
        async (jobCtx) => {
          const { spotify } = options
          if (spotify === undefined) return new Skip('not-configured')
          const skip = spotifySkip(jobCtx)
          if (skip !== undefined) return new Skip(skip)
          if (count === 0) return []
          const tracks = tracksForMode(await spotify.radio(seed, jobCtx), jobCtx.mode)
          return trackCandidates(tracks.slice(0, count), 'spotify', 'radio', ref)
        },
        spotifySkipFor,
      )

      job(
        'spotify',
        'similar-artists',
        async (jobCtx) => {
          const metadata = options.spotifyMetadata
          const getRelated = metadata?.getRelatedArtists?.bind(metadata)
          if (metadata === undefined || getRelated === undefined) return new Skip('not-configured')
          const skip = spotifySkip(jobCtx)
          if (skip !== undefined) return new Skip(skip)
          if (count === 0) return []
          const id = await spotifyArtist(seed, metadata, jobCtx)
          if (id === undefined) return new Skip('unsupported-seed')
          const related: Artist[] = (await getRelated(id, jobCtx)).slice(0, count)
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
        },
        spotifySkipFor,
      )

      job('lastfm', 'station', async (jobCtx) => {
        const stations = options.lastfmStations
        if (stations === undefined) return new Skip('not-configured')
        if (!stations.isReachable(jobCtx)) return new Skip('needs-full-tier')
        const artist = seedArtistName(seed)
        if (artist === '') return new Skip('unsupported-seed')
        if (count === 0) return []
        const items = await stations.station({ type: 'similar', artist }, jobCtx)
        return stationCandidates(items.slice(0, count), ref, jobCtx, {
          budget,
          maxClassifications,
          maxClassificationMs,
          lookup: options.youtubeLookup,
          songForVideo: options.songForVideo,
          autoMatch: options.autoMatch,
        })
      })

      job('lastfm', 'similar-artists', async (jobCtx) => {
        const api = options.lastfmApi
        if (api === undefined) return new Skip('not-configured')
        const artist = seedArtistName(seed)
        if (artist === '') return new Skip('unsupported-seed')
        if (count === 0) return []
        const similar = await api.similarArtists(artist, jobCtx, { limit: count })
        return similar.slice(0, count).flatMap((found, rank) => {
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

      job('listenbrainz', 'similar-artists', async (jobCtx) => {
        const { listenbrainz } = options
        if (listenbrainz === undefined) return new Skip('not-configured')
        if (count === 0) return []
        const mbid = await artistMbid(seed, listenbrainz, jobCtx)
        if (mbid === undefined) return new Skip('unsupported-seed')
        const similar = await listenbrainz.similarArtists(mbid, jobCtx, { limit: count })
        return similar.slice(0, count).flatMap((found, rank) => {
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

      const results = await runJobs(jobs, ctx, {
        deadlineMs: deadlineOf(deadlineMs),
        onResult:
          onResult === undefined
            ? undefined
            : (result: JobResult<RecommendationCandidate>) =>
                onResult({ outcome: result.outcome, candidates: result.items }),
      })
      return {
        candidates: results.flatMap((result) => result.items),
        outcomes: results.map((result) => result.outcome),
      }
    },

    async home(ctx, { deadlineMs, onResult } = {}) {
      const shelvesOf = (
        source: RecommendationSource,
        shelves: readonly Shelf[],
        mode: CatalogMode,
      ) =>
        shelves
          .map((shelf) => ({ source, shelf: shelfForMode(shelf, mode) }))
          .filter(({ shelf }) => shelf.items.length > 0)

      const jobs: Job<SourceShelf>[] = [
        {
          source: 'ytm',
          part: 'home',
          work: async (jobCtx) => {
            const home = options.youtube?.home?.bind(options.youtube)
            if (home === undefined) return new Skip('not-configured')
            if (jobCtx.capabilities.youtube === 'none') return new Skip('unreachable')
            return shelvesOf('ytm', await home(jobCtx), jobCtx.mode)
          },
        },
        {
          source: 'spotify',
          part: 'home',
          work: async (jobCtx) => {
            const home = options.spotify?.home?.bind(options.spotify)
            if (home === undefined) return new Skip('not-configured')
            const skip = spotifySkip(jobCtx)
            if (skip !== undefined) return new Skip(skip)
            return shelvesOf('spotify', await home(jobCtx), jobCtx.mode)
          },
          // A home feed has no seed, so only the switch and reachability refusals are skips.
          skipFor: (error) => {
            const reason = spotifySkipFor(error)
            return reason === 'unsupported-seed' ? undefined : reason
          },
        },
      ]
      const results = await runJobs(jobs, ctx, {
        deadlineMs: deadlineOf(deadlineMs),
        onResult:
          onResult === undefined
            ? undefined
            : (result: JobResult<SourceShelf>) =>
                onResult({ outcome: result.outcome, shelves: result.items }),
      })
      return {
        shelves: results.flatMap((result) => result.items),
        outcomes: results.map((result) => result.outcome),
      }
    },
  }
}
