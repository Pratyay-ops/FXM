/**
 * Test helpers for imports: a fake YouTube Music catalog behind the {@link ImportYouTube}
 * adapter (the stand-in for stage 1.3 until it merges), a fake environment and an in-memory
 * library sink. Only tests import this module; the app never does.
 *
 * The fake catalog answers the matching engine's searches the way YouTube Music's do in
 * spirit: an ISRC search lists the songs with that ISRC first, a text search ranks songs by the
 * words they share with the query, and only songs answer song searches. The real engine of
 * `@fxm/core` then decides, so tests exercise it as the app will.
 *
 * @module
 */

import {
  type AudioCandidate,
  type CatalogMode,
  type EntityId,
  FxmError,
  formatId,
  MATCHER_VERSION,
  type MatchResponse,
  normalizeText,
  type Page,
  type Playlist,
  type ProviderContext,
  type ReleaseFactsKey,
  type Track,
  type TrackKind,
} from '@fxm/core'
import type { ImportSpotify } from '../load'
import type { CachedMatch, ImportEnvironment, ImportMatchDecision, ImportSink } from '../run'
import type { ImportState } from '../types'
import type { ImportYouTube } from '../youtube'

/** A YouTube Music videoId for test song `n`: 11 characters. */
export function videoId(n: number, prefix = 'v'): string {
  return `${prefix}${String(n).padStart(10, '0')}`.slice(0, 11)
}

/** A Spotify ID for test track `n`: 22 base62 characters. */
export function spotifyId(n: number): string {
  return `sp${String(n).padStart(20, '0')}`
}

/** What a test YouTube track may set. */
export interface SongSpec {
  kind?: TrackKind
  album?: string
  seconds?: number
  isrc?: string
  explicit?: boolean
  source?: 'ytm' | 'yt'
  songId?: string
  artwork?: string
}

/** A YouTube Music search result, like the YouTube provider returns them. */
export function song(
  id: string,
  title: string,
  artists: string | string[],
  spec: SongSpec = {},
): Track {
  const source = spec.source ?? 'ytm'
  const track: Track = {
    id: formatId(source, 'track', id),
    source,
    title,
    artists: (typeof artists === 'string' ? [artists] : artists).map((name) => ({ name })),
    artwork: spec.artwork === undefined ? [] : [{ url: spec.artwork, width: 120, height: 120 }],
    kind: spec.kind ?? 'song',
  }
  if (spec.album !== undefined) {
    track.album = {
      name: spec.album,
      id: formatId(source, 'album', `MPREb_${spec.album.replace(/\W+/gu, '')}`),
    }
  }
  if (spec.seconds !== undefined) track.durationMs = spec.seconds * 1000
  if (spec.isrc !== undefined) track.isrc = spec.isrc
  if (spec.explicit !== undefined) track.explicit = spec.explicit
  if (spec.songId !== undefined) track.songId = formatId('ytm', 'track', spec.songId)
  return track
}

/** A Spotify track, as the Spotify provider maps them. */
export function spotifyTrack(
  n: number,
  title: string,
  artist: string,
  spec: { album?: string; seconds?: number; isrc?: string } = {},
): Track {
  const id = spotifyId(n)
  const track: Track = {
    id: formatId('spotify', 'track', id),
    source: 'spotify',
    title,
    artists: [{ name: artist }],
    artwork: [{ url: `https://i.scdn.co/image/${id}`, width: 300, height: 300 }],
    kind: 'song',
    externalIds: { spotify: id },
  }
  if (spec.album !== undefined) track.album = { name: spec.album }
  if (spec.seconds !== undefined) track.durationMs = spec.seconds * 1000
  if (spec.isrc !== undefined) track.isrc = spec.isrc
  return track
}

/** Words of a text, for the fake search's ranking. */
function words(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  )
}

/** How many of the query's words a track has, over its title, artists and album. */
function overlap(query: Set<string>, track: Track): number {
  const own = words(
    [track.title, ...track.artists.map((a) => a.name), track.album?.name ?? ''].join(' '),
  )
  let count = 0
  for (const word of query) if (own.has(word)) count++
  return count
}

/** Options for {@link fakeYouTube}. */
export interface FakeYouTubeOptions {
  /** Every song and video the catalog holds. */
  catalog?: readonly Track[]
  /** Playlists by ID, each with its tracks in order. */
  playlists?: Readonly<Record<string, { name: string; tracks: readonly Track[] }>>
  /** How many tracks a playlist page holds. Default 100. */
  pageSize?: number
  /** Throws this instead of answering, for the first `times` requests (default every request). */
  failWith?: { error: unknown; times?: number }
}

/** A fake {@link ImportYouTube} with a record of every request. */
export interface FakeYouTube extends ImportYouTube {
  /** The requests made, in order: `<kind> <query>` for searches, `playlist <id>`, `track <id>`. */
  readonly requests: string[]
}

/** A fake YouTube Music catalog behind the import adapter (see the module documentation). */
export function fakeYouTube(options: FakeYouTubeOptions = {}): FakeYouTube {
  const catalog = options.catalog ?? []
  const pageSize = options.pageSize ?? 100
  const requests: string[] = []
  let failures = 0
  const maybeFail = () => {
    const failWith = options.failWith
    if (failWith === undefined) return
    if (failWith.times === undefined || failures < failWith.times) {
      failures++
      throw failWith.error
    }
  }
  const search = (query: string, kinds: readonly TrackKind[]): Track[] => {
    const wanted = words(query)
    return catalog
      .filter((track) => kinds.includes(track.kind))
      .map((track, order) => ({ track, order, score: overlap(wanted, track) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, 20)
      .map((entry) => entry.track)
  }
  const page = (id: string, offset: number): Page<Track> => {
    const playlist = options.playlists?.[id]
    if (playlist === undefined) throw new FxmError('NotFound', `No playlist ${id}`)
    const items = playlist.tracks.slice(offset, offset + pageSize)
    const next = offset + pageSize
    return {
      items: [...items],
      total: playlist.tracks.length,
      ...(next < playlist.tracks.length ? { nextCursor: String(next) } : {}),
    }
  }
  return {
    requests,
    async getPlaylist(id) {
      requests.push(`playlist ${id}`)
      maybeFail()
      const playlist = options.playlists?.[id]
      if (playlist === undefined) throw new FxmError('NotFound', `No playlist ${id}`)
      const result: Playlist = {
        id,
        source: id.startsWith('yt:') ? 'yt' : 'ytm',
        name: playlist.name,
        artwork: [],
        trackCount: playlist.tracks.length,
        tracks: page(id, 0),
      }
      return result
    },
    async getPlaylistTracks(id, pageOptions) {
      requests.push(`playlist ${id} ${pageOptions.cursor ?? ''}`)
      maybeFail()
      return page(id, Number(pageOptions.cursor ?? 0))
    },
    async getTrack(id) {
      requests.push(`track ${id}`)
      maybeFail()
      const track = catalog.find((item) => item.id === id)
      if (track === undefined) throw new FxmError('NotFound', `No track ${id}`)
      return track
    },
    async fetchMatchPage(request): Promise<MatchResponse | null> {
      requests.push(
        request.kind === 'release-facts'
          ? `release-facts ${request.trackIds.join(' ')}`
          : `${request.kind} ${request.query}`,
      )
      maybeFail()
      switch (request.kind) {
        case 'isrc-songs': {
          const hits = catalog.filter(
            (track) => track.isrc === request.query && track.kind === 'song',
          )
          return { kind: request.kind, tracks: hits.slice(0, 5) }
        }
        case 'isrc-top-card':
          return {
            kind: request.kind,
            card: catalog.find((track) => track.isrc === request.query) ?? null,
          }
        case 'text-songs':
        case 'album-songs':
          return { kind: request.kind, tracks: search(request.query, ['song']) }
        case 'videos':
          return { kind: request.kind, tracks: search(request.query, ['music-video', 'video']) }
        case 'youtube':
          return { kind: request.kind, tracks: search(request.query, ['video', 'music-video']) }
        case 'release-facts':
          return { kind: request.kind, facts: {} as Record<ReleaseFactsKey, never> }
      }
    },
  }
}

/** A provider context for tests: a web page with FXM Connect, whose `fetch` must never run. */
export function testContext(mode: CatalogMode = 'music', signal?: AbortSignal): ProviderContext {
  return {
    fetch: (async () => {
      throw new Error('Tests never reach the network')
    }) as unknown as typeof fetch,
    platform: 'web',
    capabilities: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
    mode,
    ...(signal === undefined ? {} : { signal }),
  }
}

/** A fake environment and what it saw. */
export interface FakeEnvironment extends ImportEnvironment {
  /** How many times a bulk slot was waited for. */
  slots: number
  /** The errors reported to the platform. */
  reported: unknown[]
  /** The waits asked of the timer, in milliseconds. */
  waits: number[]
}

/** An environment with a fake budget (slots come at once) and a timer that does not wait. */
export function fakeEnvironment(
  overrides: Partial<ImportEnvironment> & { mode?: CatalogMode } = {},
): FakeEnvironment {
  let clock = Date.UTC(2026, 9, 26, 12)
  const { mode = 'music', ...rest } = overrides
  const environment: FakeEnvironment = {
    slots: 0,
    reported: [],
    waits: [],
    context: (signal) => testContext(mode, signal),
    async waitForBulkSlot(signal) {
      signal.throwIfAborted()
      environment.slots++
    },
    report(error) {
      environment.reported.push(error)
    },
    youtube: fakeYouTube(),
    autoMatch: true,
    now: () => clock,
    async sleep(ms, signal) {
      signal.throwIfAborted()
      environment.waits.push(ms)
      clock += ms
    },
    ...rest,
  }
  return environment
}

/** An in-memory library sink and what it received. */
export interface MemorySink extends ImportSink {
  /** The playlist's tracks in order, as placements left them. */
  playlist: EntityId<'track'>[]
  /** Every save, a copy of the state at that moment. */
  saves: ImportState[]
  /** The decisions stored. */
  decisions: ImportMatchDecision[]
  /** The tracks saved, by ID. */
  tracks: Map<string, Track>
  /** The cache to answer `cachedMatch` from, by `<trackId>|<mode>`. */
  cache: Map<string, CachedMatch>
}

/** A sink over a playlist that starts with `initial`. */
export function memorySink(initial: readonly EntityId<'track'>[] = []): MemorySink {
  const sink: MemorySink = {
    playlist: [...initial],
    saves: [],
    decisions: [],
    tracks: new Map(),
    cache: new Map(),
    async save(state) {
      sink.saves.push(structuredClone(state))
    },
    async cachedMatch(trackId, mode) {
      return sink.cache.get(`${trackId}|${mode}`)
    },
    async recordMatch(decision) {
      sink.decisions.push(decision)
    },
    async placeTrack(track, before) {
      sink.tracks.set(track.id, track)
      if (sink.playlist.includes(track.id)) return
      const at = before === null ? -1 : sink.playlist.indexOf(before)
      if (at < 0) sink.playlist.push(track.id)
      else sink.playlist.splice(at, 0, track.id)
    },
    async saveTrack(track) {
      sink.tracks.set(track.id, track)
    },
  }
  return sink
}

/** What a fake Spotify provider holds. */
export interface FakeSpotifyOptions {
  /** Tracks by ID, with the details `getTrackDetails` answers. */
  tracks?: readonly (Track & { label?: string })[]
  /** Playlists by ID. */
  playlists?: Readonly<
    Record<string, { name: string; description?: string; tracks: readonly Track[] }>
  >
  /** Whether Spotify is available. Default true. */
  available?: boolean
  /** Throws this from every call. */
  failWith?: unknown
}

/** A fake Spotify provider with a record of its calls. */
export function fakeSpotify(options: FakeSpotifyOptions = {}): ImportSpotify & { calls: string[] } {
  const calls: string[] = []
  const tracks = new Map((options.tracks ?? []).map((track) => [track.id, track]))
  const fail = () => {
    if (options.failWith !== undefined) throw options.failWith
  }
  const pageOf = (id: string, offset: number, limit: number): Page<Track> => {
    const playlist = options.playlists?.[id]
    if (playlist === undefined) throw new FxmError('NotFound', `No playlist ${id}`)
    const next = offset + limit
    return {
      items: playlist.tracks.slice(offset, next),
      total: playlist.tracks.length,
      ...(next < playlist.tracks.length ? { nextCursor: String(next) } : {}),
    }
  }
  const fake = {
    calls,
    isAvailable: () => options.available !== false,
    async getTrack(id: EntityId<'track'>) {
      calls.push(`track ${id}`)
      fail()
      const track = tracks.get(id)
      if (track === undefined) throw new FxmError('NotFound', `No track ${id}`)
      const { label: _label, ...plain } = track
      return plain
    },
    async getTrackDetails(id: EntityId<'track'>) {
      calls.push(`details ${id}`)
      fail()
      const track = tracks.get(id)
      if (track === undefined) throw new FxmError('NotFound', `No track ${id}`)
      return {
        ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
        ...(track.label === undefined ? {} : { label: track.label }),
      }
    },
    async getAlbum(id: EntityId<'album'>) {
      calls.push(`album ${id}`)
      fail()
      throw new FxmError('NotFound', `No album ${id}`)
    },
    async getPlaylist(id: EntityId<'playlist'>) {
      calls.push(`playlist ${id}`)
      fail()
      const playlist = options.playlists?.[id]
      if (playlist === undefined) throw new FxmError('NotFound', `No playlist ${id}`)
      return {
        id,
        source: 'spotify' as const,
        name: playlist.name,
        artwork: [],
        ...(playlist.description === undefined ? {} : { description: playlist.description }),
        tracks: pageOf(id, 0, 50),
      }
    },
    async getPlaylistTracks(
      id: EntityId<'playlist'>,
      pageOptions: { cursor?: string; limit?: number },
    ) {
      calls.push(`playlist ${id} ${pageOptions.cursor ?? ''}`)
      fail()
      return pageOf(id, Number(pageOptions.cursor ?? 0), pageOptions.limit ?? 50)
    },
  }
  return fake as unknown as ImportSpotify & { calls: string[] }
}

const SYLLABLES = [
  'ka',
  'lo',
  'mi',
  'ra',
  'ven',
  'dor',
  'sil',
  'tu',
  'nex',
  'bri',
  'zo',
  'qua',
  'fel',
  'mar',
  'pin',
  'gro',
]

/** A made-up word, the same for the same `n` and `salt` and different for others. */
export function madeUpWord(n: number, salt: number): string {
  let value = n * 7 + salt * 1000 + 4096
  let word = ''
  while (value > 0) {
    word += SYLLABLES[value % 16]
    value = Math.floor(value / 16)
  }
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * What a row of {@link catalogScenario} is built to show:
 *
 * - `isrc`: the catalog has the song under the row's ISRC (verified, Auto)
 * - `text`: no ISRC on the row; the catalog has the song (a text match, Auto)
 * - `isrc-miss`: the row's ISRC is not in the catalog, the song is (Suggest: the ISRC-miss guard)
 * - `no-length`: a data-export-style row without a length or ISRC (Suggest: no-duration mode)
 * - `missing`: the catalog has nothing like it (None)
 * - `live-only`: the catalog has only a live recording, much longer (None)
 */
export type ScenarioCase = 'isrc' | 'text' | 'isrc-miss' | 'no-length' | 'missing' | 'live-only'

/** A synthetic import with a catalog to match it against, and what each row should become. */
export interface CatalogScenario {
  /** The Spotify tracks, in playlist order. */
  tracks: Track[]
  /** The YouTube Music songs the fake catalog holds. */
  catalog: Track[]
  /** Each row's case and, for rows that should match, the song's `ref`. */
  expected: { case: ScenarioCase; ref?: string }[]
}

/** The cases of a 100-row scenario: 70, 10, 5, 5, 5, 5. */
export const SCENARIO_MIX: readonly [ScenarioCase, number][] = [
  ['isrc', 70],
  ['text', 10],
  ['isrc-miss', 5],
  ['no-length', 5],
  ['missing', 5],
  ['live-only', 5],
]

/**
 * A synthetic playlist of Spotify tracks and a catalog of YouTube Music songs, with made-up
 * titles and artists so no two rows look alike, built from `mix` (by default
 * {@link SCENARIO_MIX}: a 100-track playlist). The cases repeat in a fixed interleaved order.
 */
export function catalogScenario(
  mix: readonly [ScenarioCase, number][] = SCENARIO_MIX,
): CatalogScenario {
  const cases: ScenarioCase[] = []
  const left = mix.map(([kind, count]) => ({ kind, count }))
  while (left.some((entry) => entry.count > 0)) {
    for (const entry of left) {
      if (entry.count > 0) {
        cases.push(entry.kind)
        entry.count--
      }
    }
  }
  const tracks: Track[] = []
  const catalog: Track[] = []
  const expected: CatalogScenario['expected'] = []
  cases.forEach((kind, index) => {
    const n = index + 1
    const title = `${madeUpWord(n, 1)} ${madeUpWord(n, 2)}`
    const artist = `${madeUpWord(n, 3)} ${madeUpWord(n, 4)}`
    const album = madeUpWord(n, 5)
    const seconds = 150 + (n % 120)
    const isrc = `QZTST26${String(n).padStart(5, '0')}`
    const ref = videoId(n)
    const spotifySpec: { album: string; seconds?: number; isrc?: string } = { album }
    if (kind !== 'no-length') spotifySpec.seconds = seconds
    if (kind === 'isrc' || kind === 'isrc-miss') spotifySpec.isrc = isrc
    const track = spotifyTrack(n, title, artist, spotifySpec)
    tracks.push(
      kind === 'no-length'
        ? { ...track, artwork: [], externalIds: { spotify: spotifyId(n) } }
        : track,
    )
    if (kind === 'isrc') {
      catalog.push(song(ref, title, artist, { album, seconds: seconds + 1, isrc }))
      expected.push({ case: kind, ref })
    } else if (kind === 'text' || kind === 'isrc-miss' || kind === 'no-length') {
      catalog.push(song(ref, title, artist, { album, seconds }))
      expected.push({ case: kind, ref })
    } else if (kind === 'live-only') {
      catalog.push(
        song(ref, `${title} (Live)`, artist, { album: `${album} Live`, seconds: seconds + 45 }),
      )
      expected.push({ case: kind })
    } else expected.push({ case: kind })
  })
  return { tracks, catalog, expected }
}

/** A candidate as the engine returns it, for tests that build results by hand. */
export function candidate(
  id: string,
  title: string,
  artist: string,
  confidence = 0.9,
): AudioCandidate {
  return {
    source: 'ytm',
    ref: id,
    kind: 'song',
    title,
    artists: [artist],
    durationMs: 200_000,
    confidence,
    evidence: [`title ${confidence}`],
    signals: { isrcVerified: false, sourceAlbumMatch: false },
    verdict: {
      band: confidence >= 0.8 ? 'auto' : 'suggest',
      blockers: [],
      matcherVersion: MATCHER_VERSION,
    },
  }
}
