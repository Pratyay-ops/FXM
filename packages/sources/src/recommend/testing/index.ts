/**
 * Fakes for the recommendation module's adapters (see `adapters.ts`) and its sources, for this
 * module's tests and the recommendation engine's (stage 3.3). Never import it from app code.
 *
 * Each fake records its calls and answers from a table, or with an error, like the real
 * provider would. They stand in for stages that were not merged when this module was written:
 * YouTube Music (1.3), Spotify (1.5), the platform's budget and tiers (1.2), the matching
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
  type NetworkCapabilities,
  type ProviderContext,
  parseId,
  type RadioSeed,
  type SearchResults,
  type Shelf,
  type Track,
  type TrackKind,
} from '@fxm/core'
import type { LastfmApi, LastfmSimilarArtist } from '../../lastfm/api'
import type { LastfmStation, LastfmStations, LastfmStationTrack } from '../../lastfm/station'
import type { ListenBrainzClient, RecordingLookup, SimilarArtist } from '../../listenbrainz/api'
import type {
  ArtistMbidLookup,
  ClassificationBudget,
  SongForVideo,
  SpotifyMetadata,
  SpotifyRadio,
  YouTubeLookup,
  YouTubeRadio,
} from '../adapters'

/** The three tiers of the web app, plus what desktop and Android have (`full`). */
export type Tier = 'free' | 'lite' | 'full'

/** The capabilities of a tier, with Spotify reachable only in the Full tier. */
export function capabilitiesFor(tier: Tier): NetworkCapabilities {
  if (tier === 'full') {
    return { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false }
  }
  return {
    youtube: tier === 'lite' ? 'simple' : 'none',
    spotify: 'unreachable',
    mediaBytes: false,
    fileSystem: false,
  }
}

/** A provider context for tests: the Full tier and Music mode unless `overrides` say otherwise. */
export function testContext(
  overrides: Partial<ProviderContext> & { tier?: Tier } = {},
): ProviderContext {
  const { tier = 'full', ...rest } = overrides
  const fetchUnused: typeof fetch = () =>
    Promise.reject(new Error('This test does not expect a network request'))
  return {
    fetch: fetchUnused,
    platform: 'web',
    capabilities: capabilitiesFor(tier),
    mode: 'music',
    ...rest,
  }
}

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

/** A fake YouTube Music or Spotify radio, with its calls. */
export function fakeRadio(
  id: 'ytm' | 'spotify',
  radio: Answer<Track[]>,
  home?: Shelf[] | Error,
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
  }
  return fake
}

/**
 * A fake YouTube lookup over `videos`, keyed by videoId: a track, or an error to reject with.
 * Unknown videos reject with `NotFound`. `calls` lists the videoIds looked up.
 */
export function fakeYouTubeLookup(
  videos: Record<string, Track | Error>,
): YouTubeLookup & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async getTrack(id: EntityId<'track'>) {
      const { nativeId } = parseId(id)
      calls.push(nativeId)
      const found = videos[nativeId]
      if (found === undefined) throw new FxmError('NotFound', `No video ${nativeId}`)
      if (found instanceof Error) throw found
      return found
    },
  }
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

/** A budget with a fixed allowance. */
export function fakeBudget(allowance: number): ClassificationBudget {
  return { allowance: () => allowance }
}

/** A fake video-to-song rule over `songs`, keyed by the video's videoId. */
export function fakeSongForVideo(songs: Record<string, Track>): SongForVideo & { calls: string[] } {
  const calls: string[] = []
  const rule = async (video: Track) => {
    const { nativeId } = parseId(video.id)
    calls.push(nativeId)
    return songs[nativeId] ?? null
  }
  return Object.assign(rule, { calls })
}

/** A fake MusicBrainz artist lookup over `mbids`, keyed by artist name. */
export function fakeArtistMbid(mbids: Record<string, string>): ArtistMbidLookup {
  return async (artist: ArtistRef) => mbids[artist.name] ?? null
}

/** A fake Last.fm station reader: the songs of each station, keyed by `<type>:<artist>`. */
export function fakeLastfmStations(
  stations: Record<string, LastfmStationTrack[] | Error>,
): LastfmStations & { calls: LastfmStation[] } {
  const calls: LastfmStation[] = []
  return {
    calls,
    async station(station: LastfmStation) {
      calls.push(station)
      const found = stations[`${station.type}:${station.artist}`]
      if (found instanceof Error) throw found
      return found ?? []
    },
  }
}

/** A fake Last.fm API: similar artists by artist name. */
export function fakeLastfmApi(similar: Record<string, LastfmSimilarArtist[] | Error>): LastfmApi {
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
  lookups: Record<string, RecordingLookup>,
  similar: Record<string, SimilarArtist[] | Error>,
): ListenBrainzClient & { lookups: string[] } {
  const calls: string[] = []
  return {
    lookups: calls,
    async lookupRecording(artist: string, recording: string) {
      calls.push(`${artist}|${recording}`)
      return lookups[`${artist}|${recording}`] ?? null
    },
    async similarArtists(mbid: string) {
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
  type FetchCall,
  fakeFetch,
  jsonResponse,
  liveEnv,
  liveTestsEnabled,
  paramsOf,
  textResponse,
  withOrigin,
} from './http'
