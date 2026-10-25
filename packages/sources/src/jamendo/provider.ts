/**
 * Jamendo as an FXM source (`jamendo`): a metadata provider for its Creative Commons catalogue,
 * and an audio source with FLAC streams.
 *
 * The free tier allows up to 35,000 API requests a month for one `client_id`, which every user of
 * FXM's public ID shares, so the source asks Jamendo only when it must:
 *
 * - `search`, `getTrack`, `getAlbum` and `getArtist` run only because the user asked for Jamendo
 *   (the app calls them for explicit Jamendo searches and pages, never in the background);
 * - `match` looks another source's track up on Jamendo only while the user's "prefer lossless"
 *   setting is on (`preferLossless`), and answers a Jamendo track without a request;
 * - every answer is kept in memory (searches for an hour, pages for six), and `resolve` reuses
 *   the tracks that searches and pages already returned.
 *
 * When the quota is used up, calls reject with `RateLimited` without a request, and `access()`
 * tells the settings screen to offer a field for the user's own `client_id`.
 *
 * In Music mode every Jamendo track is a song and plays (the owner's decision).
 *
 * @module
 */

import {
  type Album,
  type Artist,
  type AudioCandidate,
  type AudioSource,
  applyModeFilter,
  type EntityId,
  FxmError,
  filterPlayable,
  formatId,
  type MetadataProvider,
  type Page,
  type ProviderContext,
  parseId,
  type QualityPrefs,
  type SearchOptions,
  type SearchResults,
  type StreamOption,
  splitTitle,
  stripPresentationNoise,
  type Track,
} from '@fxm/core'
import {
  type Comparable,
  MIN_CANDIDATE_CONFIDENCE,
  orderOptions,
  scoreCandidate,
  wordsOf,
} from '../shared/audio-source'
import { TtlCache } from '../shared/ttl-cache'
import { type JamendoAccess, JamendoApi } from './api'
import {
  IMAGE_SIZE,
  type JamendoTrackRecord,
  jamendoId,
  streamOptions,
  toAlbum,
  toArtist,
  toTrackRecord,
  trackOf,
} from './map'
import { JamendoQuota } from './quota'

/** Settings of the Jamendo source. */
export interface JamendoSourceOptions {
  /**
   * The app's public `client_id`, from its configuration (a build setting), never hard-coded.
   * Without it and without a user's own, Jamendo is off (`access()` says `not-configured`).
   */
  publicClientId?: string
  /** The user's own `client_id`, from Settings. Used instead of the public one when set. */
  userClientId?: string
  /**
   * Whether the user's "prefer lossless" setting is on. `match` asks Jamendo for other sources'
   * tracks only then. Off when absent.
   */
  preferLossless?: () => boolean
  /**
   * Where blocks on `client_id`s are recorded. Pass one created with the blocks saved from the
   * last run, and save its `snapshot()` when it changes, so a used-up quota is remembered across
   * restarts. A fresh one by default.
   */
  quota?: JamendoQuota
  /** The read API's root, `https://api.jamendo.com/v3.0/` by default. */
  baseUrl?: string
  /** Abort a request after this many milliseconds. 15 seconds by default. */
  timeoutMs?: number
  /** How long to keep searches. An hour by default. */
  searchTtlMs?: number
  /** How long to keep tracks, albums and artists. Six hours by default. */
  entityTtlMs?: number
  /** The clock, in epoch milliseconds. `Date.now` by default. */
  now?: () => number
}

/** Jamendo's metadata provider and audio source in one object, with its `client_id` settings. */
export interface JamendoSource extends MetadataProvider, AudioSource {
  /** Always `jamendo`. */
  readonly id: 'jamendo'
  /** The blocks on the `client_id`s used, to save and to watch. */
  readonly quota: JamendoQuota
  /** What the source can do right now, for the settings screen. */
  access(): JamendoAccess
  /** Sets the user's own `client_id` from Settings, or clears it with `undefined` or `''`. */
  setUserClientId(clientId: string | undefined): void
}

/** The most results Jamendo returns per request. */
const MAX_LIMIT = 200

/** What every track request asks for: FLAC streams and downloads, square covers. */
const TRACK_FORMAT = {
  audioformat: 'flac',
  audiodlformat: 'flac',
  imagesize: String(IMAGE_SIZE),
} as const

/** The offset a cursor from this source names: 0 for the first page. */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 1 || String(offset) !== cursor) {
    throw new RangeError(`Not a Jamendo search cursor: ${cursor}`)
  }
  return offset
}

/** A page of items, with a cursor when the page was full (Jamendo does not say if more exist). */
function page<T>(items: T[], offset: number, limit: number, received: number): Page<T> {
  return received >= limit ? { items, nextCursor: String(offset + limit) } : { items }
}

class JamendoSourceImpl implements JamendoSource {
  readonly id = 'jamendo' as const
  readonly quota: JamendoQuota
  private readonly api: JamendoApi
  private readonly preferLossless: () => boolean
  private readonly searchTtlMs: number
  private readonly entityTtlMs: number
  /** Tracks from every answer, for `resolve`. */
  private readonly records: TtlCache<JamendoTrackRecord>

  constructor(options: JamendoSourceOptions) {
    const now = options.now ?? Date.now
    this.quota = options.quota ?? new JamendoQuota({ now })
    this.api = new JamendoApi({
      quota: this.quota,
      timeoutMs: options.timeoutMs ?? 15_000,
      now,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.publicClientId === undefined ? {} : { publicClientId: options.publicClientId }),
      ...(options.userClientId === undefined ? {} : { userClientId: options.userClientId }),
    })
    this.preferLossless = options.preferLossless ?? (() => false)
    this.searchTtlMs = options.searchTtlMs ?? 3_600_000
    this.entityTtlMs = options.entityTtlMs ?? 21_600_000
    this.records = new TtlCache({ maxEntries: 1000, now })
  }

  access(): JamendoAccess {
    return this.api.access()
  }

  setUserClientId(clientId: string | undefined): void {
    this.api.setUserClientId(clientId)
  }

  /** Track records from a list of tracks, remembered for `resolve`. */
  private remember(records: readonly JamendoTrackRecord[]): JamendoTrackRecord[] {
    for (const record of records) this.records.set(record.id, record, this.entityTtlMs)
    return [...records]
  }

  /** `GET tracks/` with `params`, as records. */
  private async tracks(
    params: Readonly<Record<string, string>>,
    ttlMs: number,
    ctx: ProviderContext,
  ): Promise<{ records: JamendoTrackRecord[]; received: number }> {
    const results = await this.api.get('tracks', { ...TRACK_FORMAT, ...params }, ttlMs, ctx)
    const records = results
      .map((result) => toTrackRecord(result))
      .filter((record) => record !== null)
    return { records: this.remember(records), received: results.length }
  }

  async search(
    query: string,
    options: SearchOptions,
    ctx: ProviderContext,
  ): Promise<SearchResults> {
    const { types } = options
    const words = query.trim()
    const offset = offsetOf(options.cursor)
    const limit = Math.min(Math.max(1, Math.round(options.limit ?? 20)), MAX_LIMIT)
    const paging = { limit: String(limit), offset: String(offset) }
    const results: SearchResults = {}
    const blank = words === ''
    if (types.includes('track')) {
      if (blank) results.tracks = { items: [] }
      else {
        const { records, received } = await this.tracks(
          { search: words, type: 'single albumtrack', ...paging },
          this.searchTtlMs,
          ctx,
        )
        results.tracks = page(
          applyModeFilter(records.map(trackOf), ctx.mode),
          offset,
          limit,
          received,
        )
      }
    }
    if (types.includes('album')) {
      if (blank) results.albums = { items: [] }
      else {
        const found = await this.api.get(
          'albums',
          { namesearch: words, imagesize: String(IMAGE_SIZE), ...paging },
          this.searchTtlMs,
          ctx,
        )
        const albums = found
          .map((value) => toAlbum(value)?.album)
          .filter((album) => album !== undefined)
        results.albums = page(albums, offset, limit, found.length)
      }
    }
    if (types.includes('artist')) {
      if (blank) results.artists = { items: [] }
      else {
        const found = await this.api.get(
          'artists',
          { namesearch: words, ...paging },
          this.searchTtlMs,
          ctx,
        )
        const artists = found
          .map((value) => toArtist(value)?.artist)
          .filter((artist) => artist !== undefined)
        results.artists = page(artists, offset, limit, found.length)
      }
    }
    if (types.includes('playlist')) results.playlists = { items: [] }
    if (types.includes('video')) results.videos = { items: [] }
    return results
  }

  /** The native ID of a Jamendo entity ID, or `NotFound`. */
  private nativeId(id: EntityId, what: string): string {
    const { source, nativeId } = parseId(id)
    const canonical = source === 'jamendo' ? jamendoId(nativeId) : undefined
    if (canonical === undefined) throw new FxmError('NotFound', `Not a Jamendo ${what}: ${id}`)
    return canonical
  }

  /** One track's record: remembered from an earlier answer, or fetched. */
  private async record(id: string, ctx: ProviderContext): Promise<JamendoTrackRecord> {
    const known = this.records.get(id)
    if (known !== undefined) return known
    const { records } = await this.tracks({ id }, this.entityTtlMs, ctx)
    const record = records.find((entry) => entry.id === id)
    if (record === undefined) throw new FxmError('NotFound', `Jamendo has no track ${id}`)
    return record
  }

  async getTrack(id: EntityId<'track'>, ctx: ProviderContext): Promise<Track> {
    return trackOf(await this.record(this.nativeId(id, 'track'), ctx))
  }

  async getAlbum(id: EntityId<'album'>, ctx: ProviderContext): Promise<Album> {
    const native = this.nativeId(id, 'album')
    const found = await this.api.get(
      'albums/tracks',
      { ...TRACK_FORMAT, id: native },
      this.entityTtlMs,
      ctx,
    )
    const parsed = toAlbum(found[0])
    if (parsed === null || parsed.album.id !== formatId('jamendo', 'album', native)) {
      throw new FxmError('NotFound', `Jamendo has no album ${native}`)
    }
    this.remember(parsed.records)
    if (parsed.album.tracks !== undefined) {
      parsed.album.tracks = applyModeFilter(parsed.album.tracks, ctx.mode)
    }
    return parsed.album
  }

  async getArtist(id: EntityId<'artist'>, ctx: ProviderContext): Promise<Artist> {
    const native = this.nativeId(id, 'artist')
    const found = await this.api.get(
      'artists/tracks',
      { ...TRACK_FORMAT, id: native },
      this.entityTtlMs,
      ctx,
    )
    const parsed = toArtist(found[0])
    if (parsed === null || parsed.artist.id !== formatId('jamendo', 'artist', native)) {
      throw new FxmError('NotFound', `Jamendo has no artist ${native}`)
    }
    this.remember(parsed.records)
    if (parsed.artist.topTracks !== undefined) {
      parsed.artist.topTracks = applyModeFilter(parsed.artist.topTracks, ctx.mode)
    }
    return parsed.artist
  }

  async getPlaylist(id: EntityId<'playlist'>): Promise<never> {
    throw new FxmError('Unsupported', `Jamendo playlists are not part of FXM: ${id}`)
  }

  async match(track: Track, ctx: ProviderContext): Promise<AudioCandidate[]> {
    const own = this.ownId(track)
    if (own !== undefined) return filterPlayable([this.ownCandidate(track, own)], ctx.mode)
    if (!this.preferLossless()) return []
    const { core } = splitTitle(stripPresentationNoise(track.title))
    const artist = track.artists[0]?.name ?? ''
    if (wordsOf(core).length === 0 || wordsOf(artist).length === 0) return []
    const { records } = await this.tracks(
      { search: `${artist} ${core}`, type: 'single albumtrack', limit: '10' },
      this.searchTtlMs,
      ctx,
    )
    const wanted: Comparable = {
      title: track.title,
      artists: track.artists.map((entry) => entry.name),
      ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
    }
    const albumWords = wordsOf(track.album?.name ?? '').join(' ')
    const candidates = records.map((record): AudioCandidate => {
      const found = trackOf(record)
      const artists = found.artists.map((entry) => entry.name)
      const score = scoreCandidate(wanted, {
        title: found.title,
        artists,
        ...(found.durationMs === undefined ? {} : { durationMs: found.durationMs }),
      })
      const candidate: AudioCandidate = {
        source: 'jamendo',
        ref: record.id,
        kind: 'song',
        title: found.title,
        artists,
        confidence: score.confidence,
        evidence: score.evidence,
        signals: {
          isrcVerified: false,
          ...(record.albumId === undefined ? {} : { releaseId: record.albumId }),
          ...(record.releaseDate === undefined
            ? {}
            : { releaseYear: Number(record.releaseDate.slice(0, 4)) }),
          sourceAlbumMatch:
            albumWords !== '' && albumWords === wordsOf(record.albumName ?? '').join(' '),
        },
      }
      if (found.durationMs !== undefined) candidate.durationMs = found.durationMs
      return candidate
    })
    return filterPlayable(
      candidates
        .filter((candidate) => candidate.confidence >= MIN_CANDIDATE_CONFIDENCE)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5),
      ctx.mode,
    )
  }

  /** The track's own Jamendo ID: from its ID, or from a known link in `externalIds`. */
  private ownId(track: Track): string | undefined {
    const parts = parseId(track.id)
    if (parts.source === 'jamendo') return jamendoId(parts.nativeId)
    return jamendoId(track.externalIds?.jamendo)
  }

  /** The candidate for a track's own Jamendo audio. */
  private ownCandidate(track: Track, id: string): AudioCandidate {
    const own = track.source === 'jamendo'
    const albumId =
      own && track.album?.id !== undefined ? parseId(track.album.id).nativeId : undefined
    const candidate: AudioCandidate = {
      source: 'jamendo',
      ref: id,
      kind: 'song',
      title: track.title,
      artists: track.artists.map((artist) => artist.name),
      confidence: 1,
      evidence: [own ? 'same track' : 'linked track'],
      signals: {
        isrcVerified: false,
        ...(albumId === undefined ? {} : { releaseId: albumId }),
        sourceAlbumMatch: own,
      },
    }
    if (track.durationMs !== undefined) candidate.durationMs = track.durationMs
    return candidate
  }

  async resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
  ): Promise<StreamOption[]> {
    if (candidate.source !== 'jamendo') {
      throw new FxmError('Unsupported', `Not a Jamendo candidate: ${candidate.source}`)
    }
    const id = jamendoId(candidate.ref)
    if (id === undefined) throw new FxmError('NotFound', `Not a Jamendo track: ${candidate.ref}`)
    const options = streamOptions(await this.record(id, ctx))
    if (options.length === 0) {
      throw new FxmError('Unavailable', `Jamendo has no stream for track ${id}`)
    }
    return orderOptions(options, prefs)
  }
}

/**
 * The Jamendo source. Keep one instance per app: it caches answers and holds the `client_id`
 * settings. Jamendo stays off until a public or user `client_id` is set.
 */
export function createJamendoSource(options: JamendoSourceOptions = {}): JamendoSource {
  return new JamendoSourceImpl(options)
}
