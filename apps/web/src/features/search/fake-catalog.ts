/**
 * A fake catalog: a `MetadataProvider` over a small, invented music library (no real artists,
 * no network). Tests plug it into the sources registry, and so does the development-only fake
 * mode (`?fake=full` in `make dev`, see dev-fakes.ts). Production builds leave it out.
 *
 * It behaves like the real providers where the UI cares: one page per requested type, cursors,
 * the catalog mode (videos only in Music + Video, hidden kinds dropped from playlists),
 * suggestions, `NotFound` for unknown IDs, abortable latency, and failures on demand.
 *
 * @module
 */

import {
  type Album,
  type AlbumType,
  type Artist,
  type ArtistRef,
  type Artwork,
  applyModeFilter,
  type EntityId,
  FxmError,
  formatId,
  type MetadataProvider,
  type Page,
  type PageOptions,
  type Playlist,
  type ProviderContext,
  parseId,
  type SearchOptions,
  type SearchResults,
  type SearchType,
  type Track,
  type TrackKind,
} from '@fxm/core'
import { hashString } from '../../lib/seed'

/** The sources the fake catalog can pose as. */
export type FakeSource = 'ytm' | 'spotify'

/** The provider methods whose calls are recorded and can be made to fail. */
export type FakeMethod =
  | 'search'
  | 'suggest'
  | 'getTrack'
  | 'getAlbum'
  | 'getArtist'
  | 'getPlaylist'
  | 'getPlaylistTracks'
  | 'getRelatedArtists'

/** One recorded call. */
export interface FakeCall {
  readonly method: FakeMethod
  /** The query, for `search` and `suggest`. */
  readonly query?: string
  /** The requested types, for `search`. */
  readonly types?: readonly SearchType[]
  /** The cursor, for paged calls. */
  readonly cursor?: string
  /** The entity, for the `get…` calls. */
  readonly id?: string
  /** The catalog mode of the call. */
  readonly mode: string
}

/** A fake catalog: a provider that also records its calls and fails on demand. */
export interface FakeCatalog extends MetadataProvider {
  readonly id: FakeSource
  /** Every call so far, oldest first. */
  readonly calls: FakeCall[]
  /** Makes every later call of `method` reject with `error`, until called with `undefined`. */
  fail(method: FakeMethod, error: Error | undefined): void
  /** Sets the latency of every call, in milliseconds. */
  setLatency(ms: number): void
}

/** Options for {@link createFakeCatalog}. */
export interface FakeCatalogOptions {
  /** How long each call takes, in milliseconds. Default 0. */
  latencyMs?: number
}

interface ReleaseSeed {
  readonly key: string
  readonly name: string
  readonly type: AlbumType
  readonly year: number
  readonly tracks: readonly string[]
  /** Indexes of the explicit tracks. */
  readonly explicit?: readonly number[]
}

interface ArtistSeed {
  readonly key: string
  readonly name: string
  readonly about: string
  readonly related: readonly string[]
  readonly releases: readonly ReleaseSeed[]
}

const ARTISTS: readonly ArtistSeed[] = [
  {
    key: 'nova-lane',
    name: 'Nova Lane',
    about: 'Synth-pop from a harbor town, written on night ferries.',
    related: ['midnight-owls', 'aurora-fields', 'mira-sol'],
    releases: [
      {
        key: 'neon-harbor',
        name: 'Neon Harbor',
        type: 'album',
        year: 2021,
        tracks: [
          'Harbor Lights',
          'Neon Rain',
          'Paper Moons',
          'Slow Tide',
          'Glasshouse',
          'Night Ferry',
          'Static Bloom',
          'Afterglow Avenue',
          'Low Orbit',
          'Last Ferry Home',
        ],
      },
      {
        key: 'glass-weather',
        name: 'Glass Weather',
        type: 'ep',
        year: 2019,
        tracks: ['Glass Weather', 'Frost Lines', 'Window Seat', 'Small Hours'],
      },
      {
        key: 'paper-moons',
        name: 'Paper Moons',
        type: 'single',
        year: 2023,
        tracks: ['Paper Moons (Radio Edit)'],
      },
    ],
  },
  {
    key: 'midnight-owls',
    name: 'The Midnight Owls',
    about: 'A four-piece that only plays after dark.',
    related: ['nova-lane', 'kofi-tides'],
    releases: [
      {
        key: 'owl-hours',
        name: 'Owl Hours',
        type: 'album',
        year: 2018,
        tracks: [
          'Owl Hours',
          'Streetlight Hymn',
          'Midnight Owls',
          'Velvet Static',
          'Backseat Constellations',
          'Neon Prayer',
          'Rooftop Radio',
          'Daybreak',
        ],
        explicit: [3],
      },
    ],
  },
  {
    key: 'aurora-fields',
    name: 'Aurora Fields',
    about: 'Folk songs for long drives north.',
    related: ['nova-lane', 'study-club'],
    releases: [
      {
        key: 'northbound',
        name: 'Northbound',
        type: 'album',
        year: 2022,
        tracks: [
          'Northbound',
          'Aurora',
          'Pine & Ember',
          'Snowlight',
          'Cold Coast',
          'Long Way North',
        ],
      },
    ],
  },
  {
    key: 'kofi-tides',
    name: 'Kofi & the Tides',
    about: 'Highlife guitars and sea air.',
    related: ['mira-sol', 'midnight-owls'],
    releases: [
      {
        key: 'saltwater-sundays',
        name: 'Saltwater Sundays',
        type: 'album',
        year: 2020,
        tracks: ['Saltwater Sundays', 'Tide Pool', 'Harbor Lights', 'Coral', 'Island Time'],
        explicit: [1],
      },
    ],
  },
  {
    key: 'mira-sol',
    name: 'Mira Sol',
    about: 'Bedroom recordings, mostly at golden hour.',
    related: ['kofi-tides', 'nova-lane'],
    releases: [
      {
        key: 'golden-hour-tapes',
        name: 'Golden Hour Tapes',
        type: 'compilation',
        year: 2024,
        tracks: ['Golden Hour', 'Sunday Tape', 'Palm Shadows', 'Amber'],
      },
    ],
  },
  {
    key: 'study-club',
    name: 'Lo-Fi Study Club',
    about: 'Beats to read, write and think to.',
    related: ['aurora-fields'],
    releases: [
      {
        key: 'study-sessions',
        name: 'Study Sessions, Vol. 1',
        type: 'album',
        year: 2020,
        tracks: [
          'Rain on Glass',
          'Late Library',
          'Pencil Sketch',
          'Cocoa',
          'Window Fog',
          'Night Notes',
          'Soft Focus',
          'Page Turner',
          'Slow Morning',
          'Desk Lamp',
          'Cassette Dust',
          'Last Chapter',
        ],
      },
    ],
  },
]

interface VideoSeed {
  readonly key: string
  readonly title: string
  readonly kind: Extract<TrackKind, 'music-video' | 'video'>
  /** The artist, or a channel name for an upload by someone else. */
  readonly artist: string
  /** For an official video: its song, as release key and track index. */
  readonly song?: readonly [string, number]
}

const VIDEOS: readonly VideoSeed[] = [
  {
    key: 'paper-moons-video',
    title: 'Paper Moons (Official Video)',
    kind: 'music-video',
    artist: 'nova-lane',
    song: ['neon-harbor', 2],
  },
  {
    key: 'neon-rain-video',
    title: 'Neon Rain (Official Video)',
    kind: 'music-video',
    artist: 'nova-lane',
  },
  {
    key: 'paper-moons-live',
    title: 'Paper Moons – Live at the Lantern',
    kind: 'video',
    artist: 'nova-lane',
  },
  {
    key: 'harbor-lights-cover',
    title: 'Harbor Lights (piano cover)',
    kind: 'video',
    artist: 'Keys by Juno',
  },
  {
    key: 'owl-hours-session',
    title: 'Owl Hours – Live Session',
    kind: 'video',
    artist: 'midnight-owls',
  },
  {
    key: 'study-mix',
    title: 'Lo-fi beats to study to – two-hour mix',
    kind: 'video',
    artist: 'study-club',
  },
]

interface PlaylistSeed {
  readonly key: string
  readonly name: string
  readonly owner: string
  readonly description: string
  /** Release key and track index of each song, or a video key. */
  readonly items: readonly (readonly [string, number] | string)[]
}

const LATE_NIGHT_DRIVE: PlaylistSeed['items'] = [
  ['neon-harbor', 1],
  ['owl-hours', 0],
  'paper-moons-video',
  ['owl-hours', 5],
  ['northbound', 4],
  'paper-moons-live',
  ['neon-harbor', 5],
  ['saltwater-sundays', 2],
]

const PLAYLISTS: readonly PlaylistSeed[] = [
  {
    key: 'late-night-drive',
    name: 'Late Night Drive',
    owner: 'FXM Picks',
    description: 'Neon, rain and empty roads.',
    items: LATE_NIGHT_DRIVE,
  },
  {
    key: 'indie-sunrise',
    name: 'Indie Sunrise',
    owner: 'FXM Picks',
    description: 'A long playlist, to load page by page.',
    items: [], // filled with 120 songs below
  },
  {
    key: 'study-hours',
    name: 'Lo-fi Study Hours',
    owner: 'Lo-Fi Study Club',
    description: 'Twelve quiet tracks for one long evening.',
    items: Array.from({ length: 12 }, (_, index) => ['study-sessions', index] as const),
  },
]

/** A cover image as an SVG data URI: a gradient from the seed, with initials. */
function coverArt(seed: string, label: string, ratio: 'square' | 'wide' = 'square'): Artwork[] {
  const hue = hashString(seed) % 360
  const [width, height] = ratio === 'wide' ? [320, 180] : [300, 300]
  const initials = label
    .split(/\s+/u)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="hsl(${hue} 62% 58%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 50) % 360} 58% 30%)"/>` +
    '</linearGradient></defs>' +
    `<rect width="${width}" height="${height}" fill="url(#g)"/>` +
    `<text x="50%" y="58%" font-family="system-ui, sans-serif" font-size="${height / 3}" ` +
    `font-weight="800" fill="rgba(255,255,255,0.88)" text-anchor="middle">${initials}</text></svg>`
  return [{ url: `data:image/svg+xml,${encodeURIComponent(svg)}`, width, height }]
}

/** A stable number in [min, max] for a seed. */
function between(seed: string, min: number, max: number): number {
  return min + (hashString(seed) % (max - min + 1))
}

interface Library {
  readonly artists: ReadonlyMap<string, Artist>
  readonly albums: ReadonlyMap<string, Album>
  readonly songs: readonly Track[]
  readonly videos: readonly Track[]
  readonly tracks: ReadonlyMap<string, Track>
  readonly playlists: ReadonlyMap<string, { readonly playlist: Playlist; readonly items: Track[] }>
}

function buildLibrary(source: FakeSource): Library {
  const artistId = (key: string) => formatId(source, 'artist', `art-${key}`)
  const albumId = (key: string) => formatId(source, 'album', `alb-${key}`)
  const trackId = (key: string) => formatId(source, 'track', `trk-${key}`)
  const playlistId = (key: string) => formatId(source, 'playlist', `pl-${key}`)

  const seeds = new Map(ARTISTS.map((seed) => [seed.key, seed]))
  const refOf = (key: string): ArtistRef => {
    const seed = seeds.get(key)
    return seed ? { id: artistId(key), name: seed.name } : { name: key }
  }

  const albums = new Map<string, Album>()
  const tracks = new Map<string, Track>()
  const songs: Track[] = []
  const releaseTracks = new Map<string, Track[]>()

  for (const artist of ARTISTS) {
    for (const release of artist.releases) {
      const id = albumId(release.key)
      const artwork = coverArt(`${source}:${release.key}`, release.name)
      const list = release.tracks.map((title, index): Track => {
        const key = `${release.key}-${index + 1}`
        const track: Track = {
          id: trackId(key),
          source,
          title,
          artists: [refOf(artist.key)],
          album: { id, name: release.name },
          durationMs: between(key, 130, 320) * 1000,
          artwork,
          kind: 'song',
          trackNumber: index + 1,
          releaseDate: String(release.year),
          popularity: between(`${key}:popularity`, 10, 99),
          ...(release.explicit?.includes(index) ? { explicit: true } : {}),
        }
        tracks.set(track.id, track)
        return track
      })
      releaseTracks.set(release.key, list)
      songs.push(...list)
      albums.set(id, {
        id,
        source,
        name: release.name,
        artists: [refOf(artist.key)],
        artwork,
        type: release.type,
        releaseDate: String(release.year),
        trackCount: list.length,
        ...(release.explicit?.length ? { explicit: true } : {}),
        tracks: list,
      })
    }
  }

  const songAt = ([release, index]: readonly [string, number]): Track | undefined =>
    releaseTracks.get(release)?.[index]

  const videos: Track[] = []
  if (source === 'ytm') {
    for (const seed of VIDEOS) {
      const song = seed.song ? songAt(seed.song) : undefined
      const video: Track = {
        id: trackId(seed.key),
        source,
        title: seed.title,
        artists: [refOf(seed.artist)],
        durationMs: between(seed.key, 180, 420) * 1000,
        artwork: coverArt(`${source}:${seed.key}`, seed.title, 'wide'),
        kind: seed.kind,
        ...(song ? { songId: song.id } : {}),
      }
      tracks.set(video.id, video)
      videos.push(video)
    }
  }
  const videoByKey = new Map(VIDEOS.map((seed) => [seed.key, tracks.get(trackId(seed.key))]))

  const artists = new Map<string, Artist>()
  for (const seed of ARTISTS) {
    const id = artistId(seed.key)
    artists.set(id, {
      id,
      source,
      name: seed.name,
      artwork: coverArt(`${source}:artist:${seed.key}`, seed.name),
      description: seed.about,
    })
  }

  const playlists = new Map<string, { playlist: Playlist; items: Track[] }>()
  for (const seed of PLAYLISTS) {
    const items =
      seed.key === 'indie-sunrise'
        ? Array.from({ length: 120 }, (_, index) => songs[(index * 7) % songs.length]).filter(
            (track): track is Track => track !== undefined,
          )
        : seed.items
            .map((item) => (typeof item === 'string' ? videoByKey.get(item) : songAt(item)))
            .filter((track): track is Track => track !== undefined)
    const id = playlistId(seed.key)
    playlists.set(id, {
      playlist: {
        id,
        source,
        name: seed.name,
        owner: { name: seed.owner },
        description: seed.description,
        artwork: coverArt(`${source}:${seed.key}`, seed.name),
        trackCount: items.length,
      },
      items,
    })
  }

  return { artists, albums, songs, videos, tracks, playlists }
}

/** Lower case without accents, for matching. */
function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Whether every word of `query` appears in one of `fields`. */
function matches(query: string, ...fields: readonly string[]): boolean {
  const haystack = fold(fields.join(' '))
  const words = fold(query).split(/\s+/u).filter(Boolean)
  return words.length > 0 && words.every((word) => haystack.includes(word))
}

function names(artists: readonly ArtistRef[]): string {
  return artists.map((artist) => artist.name).join(' ')
}

function pageOf<T>(items: readonly T[], { limit = 20, cursor }: PageOptions): Page<T> {
  const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0
  const end = start + limit
  return {
    items: items.slice(start, end),
    total: items.length,
    ...(end < items.length ? { nextCursor: String(end) } : {}),
  }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/** Creates a fake catalog posing as `source` (YouTube Music or Spotify). */
export function createFakeCatalog(
  source: FakeSource,
  options: FakeCatalogOptions = {},
): FakeCatalog {
  const library = buildLibrary(source)
  const calls: FakeCall[] = []
  const failures = new Map<FakeMethod, Error>()
  let latencyMs = options.latencyMs ?? 0

  async function begin(call: FakeCall, ctx: ProviderContext): Promise<void> {
    calls.push(call)
    await wait(latencyMs, ctx.signal)
    const failure = failures.get(call.method)
    if (failure) throw failure
  }

  function notFound(id: string): never {
    throw new FxmError('NotFound', `The fake catalog has no ${id}`)
  }

  function artistPage(artist: Artist, mode: ProviderContext['mode']): Artist {
    const own = library.songs.filter((song) => song.artists.some((ref) => ref.id === artist.id))
    const topTracks = applyModeFilter(
      [...own].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 10),
      mode,
    )
    const albums = [...library.albums.values()]
      .filter((album) => album.artists.some((ref) => ref.id === artist.id))
      .map(({ tracks: _tracks, ...album }) => album)
    const seed = ARTISTS.find(
      (candidate) => formatId(source, 'artist', `art-${candidate.key}`) === artist.id,
    )
    const related = (seed?.related ?? [])
      .map((key) => library.artists.get(formatId(source, 'artist', `art-${key}`)))
      .filter((candidate): candidate is Artist => candidate !== undefined)
    // YouTube Music lists similar artists on the artist page; the Spotify fake leaves them to
    // getRelatedArtists, as Spotify's own API does.
    return { ...artist, topTracks, albums, ...(source === 'ytm' ? { related } : {}) }
  }

  const provider: FakeCatalog = {
    id: source,
    calls,
    fail(method, error) {
      if (error) failures.set(method, error)
      else failures.delete(method)
    },
    setLatency(ms) {
      latencyMs = ms
    },

    async search(query, searchOptions: SearchOptions, ctx) {
      await begin(
        {
          method: 'search',
          query,
          types: searchOptions.types,
          ...(searchOptions.cursor === undefined ? {} : { cursor: searchOptions.cursor }),
          mode: ctx.mode,
        },
        ctx,
      )
      const results: SearchResults = {}
      for (const type of searchOptions.types) {
        switch (type) {
          case 'track':
            results.tracks = pageOf(
              library.songs.filter((track) =>
                matches(query, track.title, names(track.artists), track.album?.name ?? ''),
              ),
              searchOptions,
            )
            break
          case 'video':
            results.videos = pageOf(
              ctx.mode === 'music'
                ? []
                : library.videos.filter((video) =>
                    matches(query, video.title, names(video.artists)),
                  ),
              searchOptions,
            )
            break
          case 'album':
            results.albums = pageOf(
              [...library.albums.values()]
                .filter((album) => matches(query, album.name, names(album.artists)))
                .map(({ tracks: _tracks, ...album }) => album),
              searchOptions,
            )
            break
          case 'artist':
            results.artists = pageOf(
              [...library.artists.values()].filter((artist) => matches(query, artist.name)),
              searchOptions,
            )
            break
          case 'playlist':
            results.playlists = pageOf(
              [...library.playlists.values()]
                .map(({ playlist }) => playlist)
                .filter((playlist) =>
                  matches(
                    query,
                    playlist.name,
                    playlist.description ?? '',
                    playlist.owner?.name ?? '',
                  ),
                ),
              searchOptions,
            )
            break
        }
      }
      return results
    },

    async suggest(query, ctx) {
      await begin({ method: 'suggest', query, mode: ctx.mode }, ctx)
      const typed = fold(query.trim())
      if (!typed) return []
      const candidates = new Set<string>()
      for (const artist of library.artists.values()) candidates.add(fold(artist.name))
      for (const album of library.albums.values()) candidates.add(fold(album.name))
      for (const track of library.songs) candidates.add(fold(track.title))
      return [...candidates]
        .filter((candidate) => candidate !== typed && candidate.includes(typed))
        .sort(
          (a, b) => Number(b.startsWith(typed)) - Number(a.startsWith(typed)) || a.localeCompare(b),
        )
        .slice(0, 6)
    },

    async getTrack(id, ctx) {
      await begin({ method: 'getTrack', id, mode: ctx.mode }, ctx)
      return library.tracks.get(id) ?? notFound(id)
    },

    async getAlbum(id, ctx) {
      await begin({ method: 'getAlbum', id, mode: ctx.mode }, ctx)
      const album = library.albums.get(id) ?? notFound(id)
      return { ...album, tracks: applyModeFilter(album.tracks ?? [], ctx.mode) }
    },

    async getArtist(id, ctx) {
      await begin({ method: 'getArtist', id, mode: ctx.mode }, ctx)
      return artistPage(library.artists.get(id) ?? notFound(id), ctx.mode)
    },

    async getPlaylist(id, ctx) {
      await begin({ method: 'getPlaylist', id, mode: ctx.mode }, ctx)
      const entry = library.playlists.get(id) ?? notFound(id)
      return {
        ...entry.playlist,
        tracks: pageOf(applyModeFilter(entry.items, ctx.mode), { limit: 50 }),
      }
    },

    async getPlaylistTracks(id, pageOptions, ctx) {
      await begin(
        {
          method: 'getPlaylistTracks',
          id,
          ...(pageOptions.cursor === undefined ? {} : { cursor: pageOptions.cursor }),
          mode: ctx.mode,
        },
        ctx,
      )
      const entry = library.playlists.get(id) ?? notFound(id)
      return pageOf(applyModeFilter(entry.items, ctx.mode), { limit: 50, ...pageOptions })
    },

    async getRelatedArtists(id, ctx) {
      await begin({ method: 'getRelatedArtists', id, mode: ctx.mode }, ctx)
      const artist = library.artists.get(id) ?? notFound(id)
      const seed = ARTISTS.find((candidate) => parseId(id).nativeId === `art-${candidate.key}`)
      return (seed?.related ?? [])
        .map((key) => library.artists.get(formatId(source, 'artist', `art-${key}`)))
        .filter((candidate): candidate is Artist => candidate !== undefined && candidate !== artist)
    },
  }
  return provider
}

/** The IDs of the fake catalog's entities, for tests and links. */
export const fakeIds = {
  artist: (source: FakeSource, key: string): EntityId<'artist'> =>
    formatId(source, 'artist', `art-${key}`),
  album: (source: FakeSource, key: string): EntityId<'album'> =>
    formatId(source, 'album', `alb-${key}`),
  playlist: (source: FakeSource, key: string): EntityId<'playlist'> =>
    formatId(source, 'playlist', `pl-${key}`),
  track: (source: FakeSource, key: string): EntityId<'track'> =>
    formatId(source, 'track', `trk-${key}`),
}
