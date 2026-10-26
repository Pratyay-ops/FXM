/**
 * Fakes and helpers for Home's tests: recommendation sources that answer from tables, a
 * catalog, a Spotify account, playback that records its calls, and the whole app rendered with
 * them. Fictional songs only. Never import it from app code.
 *
 * @module
 */

import {
  type ArtistRef,
  formatId,
  isTrackSeed,
  type NetworkCapabilities,
  type ProviderContext,
  type QueueContext,
  type RadioSeed,
  type RecArtist,
  type RecCandidate,
  recSeedOf,
  type Track,
} from '@fxm/core'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { App } from '../../app/app'
import { routes } from '../../app/routes'
import {
  FREE_ONLY,
  type HomeCatalog,
  type HomePlayback,
  type HomeRecommendations,
  type HomeServices,
  HomeServicesProvider,
  type HomeSourceShelf,
  type SongQuery,
  staticSources,
} from './services'
import { useTasteStore } from './taste-store'

/** The tiers of the web app, as capabilities (Spotify reachable in the Full tier only). */
export const TIERS: Readonly<Record<'free' | 'lite' | 'full', NetworkCapabilities>> = {
  free: FREE_ONLY,
  lite: { youtube: 'simple', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  full: { youtube: 'full', spotify: 'account', mediaBytes: true, fileSystem: false },
}

/** A fictional YouTube Music song. */
export function song(id: string, title: string, artist: string, extra: Partial<Track> = {}): Track {
  return {
    id: formatId('ytm', 'track', id),
    source: 'ytm',
    title,
    artists: [{ name: artist }],
    artwork: [],
    durationMs: 200_000,
    kind: 'song',
    ...extra,
  }
}

/** `count` fictional songs by `artist`, ids `<prefix>1`…. */
export function songsBy(artist: string, prefix: string, count: number, from = 1): Track[] {
  return Array.from({ length: count }, (_, index) =>
    song(`${prefix}${from + index}`, `${artist} Song ${from + index}`, artist),
  )
}

/** Songs by several new artists, taking turns: a varied radio. */
export function variedSongs(prefix: string, count: number): Track[] {
  const artists = [
    'Fable Kin',
    'Glass Choir',
    'Halcyon',
    'Iris Vale',
    'Juniper Coast',
    'Kestrel',
    'Lark Avenue',
    'Mirror Lake',
    'Northern Fern',
    'Orchid Static',
    'Paper Kites Club',
    'Quiet Harbor',
  ]
  return Array.from({ length: count }, (_, index) => {
    const artist = artists[index % artists.length] as string
    return song(`${prefix}${index}`, `${artist} ${prefix} ${index}`, artist)
  })
}

/** What a fake collector suggests, by the seed's name (a track's title or an artist's name). */
export interface FakeRecommendationTable {
  /** Radio tracks. `*` answers any other seed. */
  readonly radio?: Readonly<Record<string, readonly Track[]>>
  /** Similar artists' names. */
  readonly similar?: Readonly<Record<string, readonly string[]>>
  /** Songs known only by artist and title (`[artist, title]`), as Last.fm's station gives them. */
  readonly searches?: Readonly<Record<string, readonly (readonly [string, string])[]>>
  /** Seeds whose collection fails. */
  readonly failing?: readonly string[]
  /** The home feeds' sections. */
  readonly home?: readonly HomeSourceShelf[]
}

/** A fake of stage 3.2's collector: answers from `table`, and records every call. */
export function fakeRecommendations(table: FakeRecommendationTable = {}) {
  const calls: Array<{ seed: RadioSeed; parts: readonly string[] | undefined }> = []
  let homeCalls = 0
  const recommendations: HomeRecommendations & {
    calls: typeof calls
    readonly homeCalls: number
  } = {
    calls,
    get homeCalls() {
      return homeCalls
    },
    async collect(seed, _ctx, options) {
      calls.push({ seed, parts: options?.parts })
      const name = isTrackSeed(seed) ? seed.title : seed.name
      if (table.failing?.includes(name)) throw new Error(`No recommendations for ${name}`)
      const ref = recSeedOf(seed)
      const tracks = table.radio?.[name] ?? table.radio?.['*'] ?? []
      const similar = table.similar?.[name] ?? []
      const searches = table.searches?.[name] ?? []
      const score = (rank: number, total: number) => (total - rank) / total
      const candidates: RecCandidate[] = [
        ...tracks.map((track, rank) => ({
          type: 'track' as const,
          source: 'ytm',
          part: 'radio',
          seed: ref,
          rank,
          score: score(rank, tracks.length),
          track,
        })),
        ...similar.map((artist, rank) => ({
          type: 'artist' as const,
          source: 'listenbrainz',
          part: 'similar-artists',
          seed: ref,
          rank,
          score: score(rank, similar.length),
          artist: { name: artist, artwork: [] },
        })),
        ...searches.map(([artist, title], rank) => ({
          type: 'song-search' as const,
          source: 'lastfm',
          part: 'station',
          seed: ref,
          rank,
          score: score(rank, searches.length),
          title,
          artists: [artist],
        })),
      ]
      return { candidates }
    },
    async home() {
      homeCalls++
      return { shelves: table.home ?? [] }
    },
  }
  return recommendations
}

/** A fake catalog: artists by name, their top tracks, and songs by title. */
export function fakeCatalog(table: {
  artists?: Readonly<Record<string, ArtistRef>>
  topTracks?: Readonly<Record<string, readonly Track[]>>
  songs?: Readonly<Record<string, Track>>
}) {
  const asked: string[] = []
  const catalog: HomeCatalog & { asked: string[] } = {
    asked,
    async findArtist(name: string) {
      asked.push(`artist:${name}`)
      return table.artists?.[name] ?? null
    },
    async artistTracks(artist: RecArtist) {
      asked.push(`tracks:${artist.name}`)
      return table.topTracks?.[artist.name] ?? []
    },
    async findSong(query: SongQuery) {
      asked.push(`song:${query.title}`)
      return table.songs?.[query.title] ?? null
    },
  }
  return catalog
}

/** A fake Spotify account, connected or not. */
export function fakeSpotifyAccount(connected: boolean | Error) {
  return {
    async status(_ctx: ProviderContext) {
      if (connected instanceof Error) throw connected
      return { connected }
    },
  }
}

/** Playback that records what it was asked to play. */
export function fakePlayback() {
  const plays: Array<{ titles: string[]; startIndex?: number; context?: QueueContext }> = []
  const playback: HomePlayback & { plays: typeof plays } = {
    plays,
    play(tracks, options = {}) {
      plays.push({
        titles: tracks.map((track) => track.title),
        ...(options.startIndex === undefined ? {} : { startIndex: options.startIndex }),
        ...(options.context === undefined ? {} : { context: options.context }),
      })
    },
  }
  return playback
}

/** Home services in a tier, with the given parts. */
export function homeServices(
  tier: keyof typeof TIERS,
  parts: Omit<HomeServices, 'sources'> & { spotifyEnabled?: boolean } = {},
): HomeServices {
  const { spotifyEnabled = true, ...rest } = parts
  return { sources: staticSources(TIERS[tier], { spotifyEnabled }), ...rest }
}

/** Renders the whole app at `path` with `services` for Home. */
export function renderHome(services: HomeServices, path = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const user = userEvent.setup()
  return {
    user,
    router,
    ...render(
      <HomeServicesProvider services={services}>
        <App router={router} />
      </HomeServicesProvider>,
    ),
  }
}

/** Forgets the taste store's state; the test setup already clears `localStorage`. */
export function resetTaste(): void {
  useTasteStore.setState(useTasteStore.getInitialState(), true)
}

/** An artist reference with a YouTube Music ID. */
export function ytmArtist(name: string, id: string): ArtistRef {
  return { name, id: formatId('ytm', 'artist', id) }
}
