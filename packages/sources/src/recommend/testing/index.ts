/**
 * Fakes for the recommendation module's adapters (see `adapters.ts`) and its sources, for this
 * module's tests and the recommendation engine's (stage 3.3). Never import it from app code.
 *
 * Each fake records its calls and answers from a table, or with an error, like the real
 * provider would: YouTube Music (1.3), Spotify (1.5), the platform's budget (1.2), the matching
 * engine (1.7) and MusicBrainz (1.6).
 *
 * @module
 */

import {
  type Artist,
  type ArtistRef,
  type EntityId,
  FxmError,
  formatId,
  isTrackSeed,
  MATCHER_VERSION,
  type MatchBand,
  type MatchVerdict,
  type ProviderContext,
  parseId,
  type RadioSeed,
  type SearchResults,
  type Shelf,
  type Track,
  type TrackKind,
} from '@fxm/core'
import type { LastfmApiClient, LastfmSimilarArtist } from '../../lastfm/api'
import type { LastfmStation, LastfmStations, LastfmStationTrack } from '../../lastfm/station'
import type {
  ListenBrainzClient,
  ListenBrainzRecordingLookup,
  ListenBrainzSimilarArtist,
} from '../../listenbrainz/api'
import type {
  ArtistMbidLookup,
  ClassificationBudget,
  SongForVideo,
  SpotifyMetadata,
  SpotifyRadio,
  VideoSong,
  YouTubeLookup,
  YouTubeRadio,
  YouTubeSeedFinder,
} from '../adapters'
import type { RecommendationSeed } from '../types'

/** A YouTube Music track: a song unless `kind` says otherwise. */
export function ytmTrack(
  videoId: string,
  title: string,
  artist: string,
  kind: TrackKind = 'song',
  extra: Partial<Track> = {},
): Track {
  return {
    id: formatId('ytm', 'track', videoId),
    source: 'ytm',
    title,
    artists: [{ name: artist }],
    artwork: [],
    kind,
    ...extra,
  }
}

/** A Spotify song, by a Spotify artist when `artistId` is given. */
export function spotifyTrack(
  id: string,
  title: string,
  artist: string,
  artistId?: string,
  extra: Partial<Track> = {},
): Track {
  return {
    id: formatId('spotify', 'track', id),
    source: 'spotify',
    title,
    artists: [
      artistId === undefined
        ? { name: artist }
        : { name: artist, id: formatId('spotify', 'artist', artistId) },
    ],
    artwork: [],
    kind: 'song',
    ...extra,
  }
}

/** A Spotify artist. */
export function spotifyArtist(id: string, name: string): Artist {
  return { id: formatId('spotify', 'artist', id), source: 'spotify', name, artwork: [] }
}

/** What a fake recommendation provider answers: a value, or an error to reject with. */
type Answer<T> = T | Error | ((seed: RadioSeed) => T | Error)

/** Resolves an {@link Answer}. */
function answer<T>(value: Answer<T>, seed: RadioSeed): Promise<T> {
  const result =
    typeof value === 'function' ? (value as (seed: RadioSeed) => T | Error)(seed) : value
  return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
}

/**
 * A fake YouTube Music or Spotify radio, with its calls. `available`, when given, becomes its
 * `isAvailable`, like the Spotify provider's switch.
 */
export function fakeRadio(
  id: 'ytm' | 'spotify',
  radio: Answer<Track[]>,
  home?: Shelf[] | Error,
  available?: (ctx: Pick<ProviderContext, 'capabilities'>) => boolean,
): (YouTubeRadio & SpotifyRadio) & { seeds: RadioSeed[]; homeCalls: number } {
  const fake = {
    id,
    seeds: [] as RadioSeed[],
    homeCalls: 0,
    radio(seed: RadioSeed) {
      fake.seeds.push(seed)
      return answer(radio, seed)
    },
    ...(home === undefined
      ? {}
      : {
          home() {
            fake.homeCalls++
            return home instanceof Error ? Promise.reject(home) : Promise.resolve(home)
          },
        }),
    ...(available === undefined ? {} : { isAvailable: available }),
  }
  return fake
}

/**
 * A fake YouTube lookup over `videos`, keyed by videoId: a track, or an error to reject with.
 * Unknown videos reject with `NotFound`. `calls` lists the videoIds looked up, and `contexts` the
 * context of each call.
 */
export function fakeYouTubeLookup(
  videos: Record<string, Track | Error>,
): YouTubeLookup & { calls: string[]; contexts: ProviderContext[] } {
  const calls: string[] = []
  const contexts: ProviderContext[] = []
  return {
    calls,
    contexts,
    async getTrack(id: EntityId<'track'>, ctx: ProviderContext) {
      const { nativeId } = parseId(id)
      calls.push(nativeId)
      contexts.push(ctx)
      const found = videos[nativeId]
      if (found === undefined) throw new FxmError('NotFound', `No video ${nativeId}`)
      if (found instanceof Error) throw found
      return found
    },
  }
}

/**
 * A fake {@link YouTubeSeedFinder}: `find` answers for each seed, and `seeds` lists the seeds it
 * was asked for.
 */
export function fakeYouTubeSeed(
  find: (seed: RecommendationSeed) => RadioSeed | null,
): YouTubeSeedFinder & { seeds: RecommendationSeed[] } {
  const seeds: RecommendationSeed[] = []
  const finder = async (seed: RecommendationSeed) => {
    seeds.push(seed)
    return find(seed)
  }
  return Object.assign(finder, { seeds })
}

/** A fake Spotify metadata provider: related artists by artist ID, and an artist search. */
export function fakeSpotifyMetadata(
  related: Record<string, Artist[] | Error>,
  searchable: Artist[] = [],
): SpotifyMetadata & { searches: string[] } {
  const searches: string[] = []
  return {
    searches,
    async search(query: string): Promise<SearchResults> {
      searches.push(query)
      const items = searchable.filter((artist) =>
        artist.name.toLowerCase().includes(query.toLowerCase()),
      )
      return { artists: { items } }
    },
    async getRelatedArtists(id: EntityId<'artist'>) {
      const found = related[parseId(id).nativeId]
      if (found instanceof Error) throw found
      return found ?? []
    },
  }
}

/**
 * A budget with a fixed allowance, and a classification context made by `context` when given
 * (e.g. one that marks the priority).
 */
export function fakeBudget(
  allowance: number,
  context?: (ctx: ProviderContext) => ProviderContext,
): ClassificationBudget {
  return context === undefined
    ? { allowance: () => allowance }
    : { allowance: () => allowance, context }
}

/** A matcher verdict with the given band, from this matcher version. */
export function verdictOf(band: MatchBand): MatchVerdict {
  return { band, blockers: band === 'auto' ? [] : ['low-score'], matcherVersion: MATCHER_VERSION }
}

/**
 * A fake video-to-song rule over `songs`, keyed by the video's videoId: the song a match finds,
 * with a verdict of `band` (`auto` by default), or a whole {@link VideoSong}. Unknown videos map
 * to no song.
 */
export function fakeSongForVideo(
  songs: Record<string, Track | VideoSong>,
  band: MatchBand = 'auto',
): SongForVideo & { calls: string[]; contexts: ProviderContext[] } {
  const calls: string[] = []
  const contexts: ProviderContext[] = []
  const rule = async (video: Track, ctx: ProviderContext): Promise<VideoSong | null> => {
    const { nativeId } = parseId(video.id)
    calls.push(nativeId)
    contexts.push(ctx)
    const found = songs[nativeId]
    if (found === undefined) return null
    return 'song' in found ? found : { song: found, via: 'match', verdict: verdictOf(band) }
  }
  return Object.assign(rule, { calls, contexts })
}

/** A fake MusicBrainz artist lookup over `mbids`, keyed by artist name. */
export function fakeArtistMbid(mbids: Record<string, string>): ArtistMbidLookup {
  return async (artist: ArtistRef) => mbids[artist.name] ?? null
}

/**
 * A fake Last.fm station reader: the songs of each station, keyed by `<type>:<artist>`. It
 * reaches the stations where `reachable` says so: by default in the Full tier.
 */
export function fakeLastfmStations(
  stations: Record<string, LastfmStationTrack[] | Error>,
  reachable: (ctx: ProviderContext) => boolean = (ctx) => ctx.capabilities.youtube === 'full',
): LastfmStations & { calls: LastfmStation[] } {
  const calls: LastfmStation[] = []
  return {
    calls,
    isReachable: reachable,
    async station(station: LastfmStation) {
      calls.push(station)
      const found = stations[`${station.type}:${station.artist}`]
      if (found instanceof Error) throw found
      return found ?? []
    },
  }
}

/** A fake Last.fm API: similar artists by artist name. */
export function fakeLastfmApi(
  similar: Record<string, LastfmSimilarArtist[] | Error>,
): LastfmApiClient {
  return {
    async similarArtists(artist: string) {
      const found = similar[artist]
      if (found instanceof Error) throw found
      return found ?? []
    },
  }
}

/** A fake ListenBrainz client: lookups by `<artist>|<recording>`, similar artists by MBID. */
export function fakeListenBrainz(
  lookups: Record<string, ListenBrainzRecordingLookup>,
  similar: Record<string, ListenBrainzSimilarArtist[] | Error>,
): ListenBrainzClient & { lookups: string[]; similarCalls: string[] } {
  const lookupCalls: string[] = []
  const similarCalls: string[] = []
  return {
    lookups: lookupCalls,
    similarCalls,
    async lookupRecording(artist: string, recording: string) {
      lookupCalls.push(`${artist}|${recording}`)
      return lookups[`${artist}|${recording}`] ?? null
    },
    async similarArtists(mbid: string) {
      similarCalls.push(mbid)
      const found = similar[mbid]
      if (found instanceof Error) throw found
      return found ?? []
    },
  }
}

/** The main artist of a seed, for fakes that answer by seed. */
export function seedArtistOf(seed: RadioSeed): string {
  return (isTrackSeed(seed) ? seed.artists[0]?.name : seed.name) ?? ''
}

export {
  type CorsRecord,
  capabilitiesFor,
  type FetchCall,
  fakeFetch,
  jsonResponse,
  liveEnv,
  liveTestsEnabled,
  paramsOf,
  type Tier,
  testContext,
  textResponse,
  withOrigin,
} from '../../shared/fake-network'
