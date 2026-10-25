/**
 * The Internet Archive as an FXM source (`archive`): a metadata provider for its free, FLAC-first
 * audio items, and an audio source whose streams are the items' files.
 *
 * - **Search** finds items (`mediatype:audio` and the Live Music Archive's `etree`) that have a
 *   FLAC file and are not access-restricted. Albums are the items; songs are the tracks of the
 *   first few items that fit the words, paged through those items' tracks before the next items.
 * - **Tracks** are the items' recordings, one per audio file and its derivatives (see
 *   `audioGroups`), with IDs `archive:track:<identifier>/<file path>`. Albums are items.
 * - **Streams** are every playable file of a track: the FLAC original (`lossless`), and the MP3
 *   and Ogg Vorbis files the Archive made from it, tiered by `tierOf`. They are plain
 *   `https://archive.org/download/…` URLs that never expire and work from any IP, `unverified`
 *   because nothing probed their end (the Archive does not cap them, and their bytes are
 *   readable on every tier, so a download manager can probe the one it picks).
 * - **Matching** another source's track gives provisional, text-only candidates (at most
 *   Suggest; see `../shared/audio-source.ts`), unless an ISRC both sides carry passes the ISRC
 *   gate's checks.
 *
 * In Music mode every Archive track is a song and plays (the owner's decision), like any track
 * from a non-YouTube source.
 *
 * @module
 */

import {
  type Album,
  type Artwork,
  type AudioCandidate,
  type AudioSource,
  applyModeFilter,
  type EntityId,
  FxmError,
  filterPlayable,
  formatId,
  type MatchSignals,
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
  tierOf,
} from '@fxm/core'
import {
  type Attribution,
  type Comparable,
  isLive,
  MIN_CANDIDATE_CONFIDENCE,
  orderOptions,
  provisionalScore,
  wordsOf,
} from '../shared/audio-source'
import { LoadCache } from '../shared/ttl-cache'
import { ArchiveApi, type ArchiveSearch, type ArchiveSearchDoc } from './api'
import { type FlacStreamInfo, fetchFlacStreamInfo } from './flac'
import {
  ARCHIVE_ORIGIN,
  type ArchiveItem,
  type AudioGroup,
  audioGroups,
  coverFiles,
  downloadUrl,
  groupField,
  groupWithFile,
  itemPageUrl,
  type PlayableFile,
  titleFromPath,
} from './item'

/** Settings of the Internet Archive source. All optional. */
export interface ArchiveSourceOptions {
  /** The Archive's origin, `https://archive.org` by default. */
  baseUrl?: string
  /** Abort a request after this many milliseconds. 15 seconds by default. */
  timeoutMs?: number
  /**
   * The media types to search: `audio`, and `etree` for the Live Music Archive's concert
   * recordings. Both by default. A match for a track that is not live never uses `etree`.
   */
  mediatypes?: readonly string[]
  /** `downloads` (the default): most downloaded first; `relevance`: the Archive's ranking. */
  sort?: 'downloads' | 'relevance'
  /**
   * How many items a song search opens at a time to list their tracks. 4 by default. The pages
   * of a song search go through every fitting track of these items, then open the next ones.
   */
  trackSearchItems?: number
  /** How many items a match opens to look for the track. 3 by default. */
  matchItems?: number
  /**
   * Whether `resolve` reads each FLAC stream's header, its first 42 bytes, for its sample rate
   * and bit depth: one small range request per FLAC file. Off by default; the `24bit Flac` format
   * name still gives the bit depth without it. It reads the start of the file, so it says nothing
   * about `fullLength`.
   */
  readFlacHeader?: boolean
  /** How long to keep search pages. 10 minutes by default. */
  searchTtlMs?: number
  /** How long to keep item metadata. An hour by default. */
  itemTtlMs?: number
  /** The clock for the caches. `Date.now` by default. */
  now?: () => number
}

/** The Internet Archive's metadata provider and audio source in one object. */
export interface ArchiveSource extends MetadataProvider, AudioSource {
  /** Always `archive`. */
  readonly id: 'archive'
  /**
   * Finds Archive files for any source's track. An Archive track, or one whose
   * `externalIds.archive` names an Archive file, gets that file at confidence 1 without a
   * request. Any other track gets provisional, text-only candidates, at most 0.79 (Suggest),
   * unless an Archive file carries the track's ISRC and passes the ISRC gate's checks, which
   * makes it ISRC-verified at 1.
   *
   * `track.isrc` counts as a catalog ISRC: never put an ISRC there that a fuzzy MusicBrainz
   * search suggested (`origin: 'musicbrainz-fuzzy'`), which is only a ranking hint.
   */
  match(track: Track, ctx: ProviderContext): Promise<AudioCandidate[]>
  /**
   * What crediting a track takes: its title and artists, the Archive as its source, the item's
   * page and its licence. For a candidate, pass `formatId('archive', 'track', candidate.ref)`.
   * One request at most, shared with the other calls for the same item.
   */
  attribution(id: EntityId<'track'>, ctx: ProviderContext): Promise<Attribution>
}

/** The parts of an Archive track's native ID. */
export interface ArchiveTrackRef {
  /** The item's identifier. */
  identifier: string
  /** The file's path within the item. */
  path: string
}

/** An Archive item identifier: letters, digits, `.`, `_` and `-`, not starting with a symbol. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/**
 * The parts of an Archive track's native ID, `<identifier>/<file path>`, or `null` when it is
 * not one. The path may contain further slashes.
 */
export function parseTrackRef(ref: string): ArchiveTrackRef | null {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return null
  const identifier = ref.slice(0, slash)
  return IDENTIFIER.test(identifier) ? { identifier, path: ref.slice(slash + 1) } : null
}

/** Words too common to require of a track in a song search. */
const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'of', 'feat', 'ft', 'featuring', 'vs', 'with'])

/** The item tile: a small square image the Archive makes for every item. */
function tileUrl(identifier: string): string {
  return `${ARCHIVE_ORIGIN}/services/img/${encodeURIComponent(identifier)}`
}

/** Artwork already found, per item, so that an item's files are scanned for covers once. */
const artworkByItem = new WeakMap<ArchiveItem, readonly Artwork[]>()

/** An item's artwork, as a new list: uploaded covers, largest first, then the item tile. */
function artworkOf(item: ArchiveItem): Artwork[] {
  let artwork = artworkByItem.get(item)
  if (artwork === undefined) {
    const covers = coverFiles(item).map((file): Artwork => {
      const cover: Artwork = { url: downloadUrl(item.identifier, file.name) }
      if (file.width !== undefined) cover.width = file.width
      if (file.height !== undefined) cover.height = file.height
      return cover
    })
    artwork = [...covers, { url: tileUrl(item.identifier) }]
    artworkByItem.set(item, artwork)
  }
  return artwork.map((entry) => ({ ...entry }))
}

/** The track of an item's audio group. */
export function trackOf(item: ArchiveItem, group: AudioGroup): Track {
  const artist = groupField(group, 'artist')
  const names = artist !== undefined ? [artist] : item.creators
  const track: Track = {
    id: formatId('archive', 'track', `${item.identifier}/${group.root.name}`),
    source: 'archive',
    title: groupField(group, 'title') ?? titleFromPath(group.root.name),
    artists: names.map((name) => ({ name })),
    album: {
      id: formatId('archive', 'album', item.identifier),
      name: item.title ?? item.identifier,
    },
    artwork: artworkOf(item),
    kind: 'song',
  }
  const durationMs = groupField(group, 'lengthMs')
  if (durationMs !== undefined) track.durationMs = durationMs
  const isrc = groupField(group, 'isrc')
  if (isrc !== undefined) track.isrc = isrc
  const trackNumber = groupField(group, 'track')
  if (trackNumber !== undefined) track.trackNumber = trackNumber
  const discNumber = groupField(group, 'disc')
  if (discNumber !== undefined) track.discNumber = discNumber
  if (item.date !== undefined) track.releaseDate = item.date
  return track
}

/** An album from an item, with its tracks when `groups` are given. */
function albumOf(item: ArchiveItem, groups?: readonly AudioGroup[]): Album {
  const album: Album = {
    id: formatId('archive', 'album', item.identifier),
    source: 'archive',
    name: item.title ?? item.identifier,
    artists: item.creators.map((name) => ({ name })),
    artwork: artworkOf(item),
  }
  if (item.date !== undefined) album.releaseDate = item.date
  if (groups !== undefined) {
    album.tracks = groups.map((group) => trackOf(item, group))
    album.trackCount = album.tracks.length
  }
  return album
}

/** An album from a search result, without its tracks. */
function albumOfDoc(doc: ArchiveSearchDoc): Album {
  const album: Album = {
    id: formatId('archive', 'album', doc.identifier),
    source: 'archive',
    name: doc.title ?? doc.identifier,
    artists: doc.creators.map((name) => ({ name })),
    artwork: [{ url: tileUrl(doc.identifier) }],
  }
  if (doc.date !== undefined) album.releaseDate = doc.date
  return album
}

/** One stream option per playable file. */
function streamOption(item: ArchiveItem, playable: PlayableFile): StreamOption {
  const { file, format, bitrateKbps } = playable
  const option: StreamOption = {
    url: downloadUrl(item.identifier, file.name),
    codec: format.codec,
    container: format.container,
    media: 'audio',
    tier: tierOf({ codec: format.codec, ...(bitrateKbps === undefined ? {} : { bitrateKbps }) }),
    protocol: 'progressive',
    ipBound: false,
    fullLength: 'unverified',
  }
  if (bitrateKbps !== undefined) option.bitrateKbps = bitrateKbps
  if (format.bitDepth !== undefined) option.bitDepth = format.bitDepth
  return option
}

/** Whether a track fits every significant word of a search. */
function fits(track: Track, item: ArchiveItem, words: readonly string[]): boolean {
  const haystack = new Set(
    wordsOf(
      [
        track.title,
        ...track.artists.map((artist) => artist.name),
        track.album?.name ?? '',
        ...item.creators,
        item.title ?? '',
      ].join(' '),
    ),
  )
  return words.every((word) => haystack.has(word))
}

/** Where a page of search results starts. */
interface SearchPosition {
  /** The page of items, from 1. */
  page: number
  /** For songs: how many fitting tracks of that page's items earlier pages already listed. */
  offset: number
}

/**
 * The position a cursor from this source names; no cursor means the start. An album cursor is
 * the number of the next page of items (from 2). A song cursor is that too, or
 * `<page>.<offset>`: the rest of the tracks of a page of items, after the first `offset`.
 */
function positionOf(cursor: string | undefined): SearchPosition {
  if (cursor === undefined) return { page: 1, offset: 0 }
  const match = /^(\d{1,15})(?:\.(\d{1,15}))?$/u.exec(cursor)
  const page = Number(match?.[1])
  const offset = Number(match?.[2] ?? 0)
  const canonical = offset > 0 ? `${page}.${offset}` : String(page)
  if (match === null || page < 1 || (offset === 0 && page < 2) || canonical !== cursor) {
    throw new RangeError(`Not an Internet Archive search cursor: ${cursor}`)
  }
  return { page, offset }
}

/** A page size within 1-100, `fallback` when absent. */
function rows(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(1, Math.round(limit ?? fallback)), 100)
}

/** The year of a release date, e.g. 2008 for `2008-03-02`. */
function yearOf(date: string | undefined): number | undefined {
  const year = date === undefined ? Number.NaN : Number(date.slice(0, 4))
  return Number.isInteger(year) ? year : undefined
}

class ArchiveSourceImpl implements ArchiveSource {
  readonly id = 'archive' as const
  private readonly api: ArchiveApi
  private readonly mediatypes: readonly string[]
  private readonly sort: 'downloads' | 'relevance'
  private readonly trackSearchItems: number
  private readonly matchItems: number
  private readonly readHeaders: boolean
  private readonly headers: LoadCache<FlacStreamInfo>
  private readonly timeoutMs: number
  private readonly itemTtlMs: number

  constructor(options: ArchiveSourceOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.itemTtlMs = options.itemTtlMs ?? 3_600_000
    const now = options.now === undefined ? {} : { now: options.now }
    this.api = new ArchiveApi({
      timeoutMs: this.timeoutMs,
      searchTtlMs: options.searchTtlMs ?? 600_000,
      itemTtlMs: this.itemTtlMs,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...now,
    })
    this.headers = new LoadCache({ maxEntries: 200, ...now })
    this.mediatypes = options.mediatypes ?? ['audio', 'etree']
    this.sort = options.sort ?? 'downloads'
    this.trackSearchItems = rows(options.trackSearchItems, 4)
    this.matchItems = rows(options.matchItems, 3)
    this.readHeaders = options.readFlacHeader ?? false
  }

  async search(
    query: string,
    options: SearchOptions,
    ctx: ProviderContext,
  ): Promise<SearchResults> {
    const { types } = options
    const { page, offset } = positionOf(options.cursor)
    const results: SearchResults = {}
    const wantAlbums = types.includes('album')
    const wantTracks = types.includes('track')
    if (wantAlbums && offset > 0) {
      throw new RangeError(`Not an Internet Archive album cursor: ${options.cursor}`)
    }
    const base = { text: query, mediatypes: this.mediatypes, page, sort: this.sort }
    // One search serves both types: its first items are opened for their tracks. Each type's
    // next page is then a page of its own size, which only that type asks for.
    const albumRows = rows(options.limit, 20)
    let itemRows = albumRows
    if (wantTracks) {
      itemRows = wantAlbums ? Math.max(albumRows, this.trackSearchItems) : this.trackSearchItems
    }
    if (wantAlbums || wantTracks) {
      const found = await this.api.search({ ...base, rows: itemRows }, ctx)
      if (wantAlbums) {
        const albums: Page<Album> = {
          items: found.docs.slice(0, albumRows).map(albumOfDoc),
          total: found.total,
        }
        if (page * albumRows < found.total) albums.nextCursor = String(page + 1)
        results.albums = albums
      }
      if (wantTracks) {
        const docs = found.docs.slice(0, this.trackSearchItems)
        const fitting = await this.tracksOf(docs, query, ctx)
        const limit = rows(options.limit, 50)
        const tracks: Page<Track> = { items: fitting.slice(offset, offset + limit) }
        // The rest of these items' tracks first, then the next items.
        if (offset + limit < fitting.length) tracks.nextCursor = `${page}.${offset + limit}`
        else if (page * this.trackSearchItems < found.total) tracks.nextCursor = String(page + 1)
        results.tracks = tracks
      }
    }
    if (types.includes('artist')) results.artists = { items: [] }
    if (types.includes('playlist')) results.playlists = { items: [] }
    if (types.includes('video')) results.videos = { items: [] }
    return results
  }

  /** Every track of some items that fits a search's words, in order, as the mode shows them. */
  private async tracksOf(
    docs: readonly ArchiveSearchDoc[],
    query: string,
    ctx: ProviderContext,
  ): Promise<Track[]> {
    const words = wordsOf(query).filter((word) => !STOP_WORDS.has(word))
    const items = await this.openItems(docs, ctx)
    const tracks = items.flatMap((item) =>
      audioGroups(item)
        .map((group) => trackOf(item, group))
        .filter((track) => fits(track, item, words)),
    )
    return applyModeFilter(tracks, ctx.mode)
  }

  /** The freely accessible items among search results; an item that fails to load is skipped. */
  private async openItems(
    docs: readonly ArchiveSearchDoc[],
    ctx: ProviderContext,
  ): Promise<ArchiveItem[]> {
    const items = await Promise.all(
      docs.map((doc) =>
        this.api.item(doc.identifier, ctx).catch((error: unknown) => {
          if (ctx.signal?.aborted || !(error instanceof FxmError)) throw error
          return null
        }),
      ),
    )
    return items.filter((item): item is ArchiveItem => item !== null && !item.restricted)
  }

  /** A freely accessible item, or the reason it cannot be used. */
  private async freeItem(identifier: string, ctx: ProviderContext): Promise<ArchiveItem> {
    const item = await this.api.item(identifier, ctx)
    if (item.restricted) {
      throw new FxmError('Unavailable', `The Internet Archive restricts access to ${identifier}`)
    }
    return item
  }

  /** The item and audio group of a track ID's native part. */
  private async groupOf(ref: string, ctx: ProviderContext): Promise<[ArchiveItem, AudioGroup]> {
    const parts = parseTrackRef(ref)
    if (parts === null) throw new FxmError('NotFound', `Not an Internet Archive track: ${ref}`)
    const item = await this.freeItem(parts.identifier, ctx)
    const group = groupWithFile(audioGroups(item), parts.path)
    if (group === undefined) {
      throw new FxmError('NotFound', `${parts.identifier} has no playable file ${parts.path}`)
    }
    return [item, group]
  }

  async getTrack(id: EntityId<'track'>, ctx: ProviderContext): Promise<Track> {
    const { source, nativeId } = parseId(id)
    if (source !== 'archive') throw new FxmError('NotFound', `Not an Internet Archive track: ${id}`)
    const [item, group] = await this.groupOf(nativeId, ctx)
    return trackOf(item, group)
  }

  async getAlbum(id: EntityId<'album'>, ctx: ProviderContext): Promise<Album> {
    const { source, nativeId } = parseId(id)
    if (source !== 'archive' || !IDENTIFIER.test(nativeId)) {
      throw new FxmError('NotFound', `Not an Internet Archive album: ${id}`)
    }
    const item = await this.freeItem(nativeId, ctx)
    const album = albumOf(item, audioGroups(item))
    album.tracks = applyModeFilter(album.tracks ?? [], ctx.mode)
    return album
  }

  async getArtist(id: EntityId<'artist'>): Promise<never> {
    throw new FxmError('Unsupported', `The Internet Archive has no artist pages: ${id}`)
  }

  async getPlaylist(id: EntityId<'playlist'>): Promise<never> {
    throw new FxmError('Unsupported', `The Internet Archive has no playlists in FXM: ${id}`)
  }

  async attribution(id: EntityId<'track'>, ctx: ProviderContext): Promise<Attribution> {
    const { source, nativeId } = parseId(id)
    if (source !== 'archive') throw new FxmError('NotFound', `Not an Internet Archive track: ${id}`)
    const [item, group] = await this.groupOf(nativeId, ctx)
    const track = trackOf(item, group)
    const attribution: Attribution = {
      title: track.title,
      artists: track.artists.map((artist) => artist.name),
      provider: 'Internet Archive',
      pageUrl: itemPageUrl(item.identifier),
    }
    if (item.licenseUrl !== undefined) attribution.licenseUrl = item.licenseUrl
    return attribution
  }

  async match(track: Track, ctx: ProviderContext): Promise<AudioCandidate[]> {
    const own = this.ownRef(track)
    if (own !== undefined) return filterPlayable([this.ownCandidate(track, own)], ctx.mode)
    const { core } = splitTitle(stripPresentationNoise(track.title))
    const artist = track.artists[0]?.name ?? ''
    if (wordsOf(core).length === 0 || wordsOf(artist).length === 0) return []
    const wanted: Comparable = {
      title: track.title,
      artists: track.artists.map((entry) => entry.name),
      ...(track.album === undefined ? {} : { album: track.album.name }),
      ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
      ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
    }
    const search: ArchiveSearch = {
      text: artist,
      anyOf: [core, ...(track.album === undefined ? [] : [track.album.name])],
      // Concert recordings only for a live track: by its title's qualifiers or its album.
      mediatypes: isLive(wanted)
        ? this.mediatypes
        : this.mediatypes.filter((type) => type !== 'etree'),
      rows: this.matchItems,
      page: 1,
      sort: this.sort,
    }
    const found = await this.api.search(search, ctx)
    const items = await this.openItems(found.docs, ctx)
    const candidates = items.flatMap((item) =>
      audioGroups(item).map((group) => this.candidateFor(track, wanted, item, group)),
    )
    return filterPlayable(
      candidates
        .filter((candidate) => candidate.confidence >= MIN_CANDIDATE_CONFIDENCE)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5),
      ctx.mode,
    )
  }

  /** The track's own Archive file: from its ID, or from a known link in `externalIds`. */
  private ownRef(track: Track): string | undefined {
    const parts = parseId(track.id)
    if (parts.source === 'archive') return parts.nativeId
    const linked = track.externalIds?.archive
    return linked !== undefined && parseTrackRef(linked) !== null ? linked : undefined
  }

  /** The candidate for a track's own Archive file. */
  private ownCandidate(track: Track, ref: string): AudioCandidate {
    const candidate: AudioCandidate = {
      source: 'archive',
      ref,
      kind: 'song',
      title: track.title,
      artists: track.artists.map((artist) => artist.name),
      confidence: 1,
      evidence: [track.source === 'archive' ? 'same file' : 'linked file'],
      signals: {
        isrcVerified: track.source === 'archive' && track.isrc !== undefined,
        releaseId: parseTrackRef(ref)?.identifier ?? ref,
        sourceAlbumMatch: track.source === 'archive',
      },
    }
    if (track.durationMs !== undefined) candidate.durationMs = track.durationMs
    return candidate
  }

  /** A scored candidate for one recording of an item. */
  private candidateFor(
    track: Track,
    wanted: Comparable,
    item: ArchiveItem,
    group: AudioGroup,
  ): AudioCandidate {
    const found = trackOf(item, group)
    const artists = found.artists.map((artist) => artist.name)
    // The item's title is the candidate's album, whose version tags count on both sides; a Live
    // Music Archive item is a concert whatever its title says.
    const score = provisionalScore(wanted, {
      title: found.title,
      artists,
      live: item.mediatype === 'etree',
      ...(item.title === undefined ? {} : { album: item.title }),
      ...(found.durationMs === undefined ? {} : { durationMs: found.durationMs }),
      ...(found.isrc === undefined ? {} : { isrc: found.isrc }),
    })
    const albumWords = wordsOf(track.album?.name ?? '').join(' ')
    const signals: MatchSignals = {
      isrcVerified: score.isrcVerified,
      releaseId: item.identifier,
      sourceAlbumMatch: albumWords !== '' && albumWords === wordsOf(item.title ?? '').join(' '),
    }
    const year = yearOf(item.date)
    if (year !== undefined) signals.releaseYear = year
    const candidate: AudioCandidate = {
      source: 'archive',
      ref: parseId(found.id).nativeId,
      kind: 'song',
      title: found.title,
      artists,
      confidence: score.confidence,
      evidence: score.evidence,
      signals,
    }
    if (found.durationMs !== undefined) candidate.durationMs = found.durationMs
    return candidate
  }

  async resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
  ): Promise<StreamOption[]> {
    if (candidate.source !== 'archive') {
      throw new FxmError('Unsupported', `Not an Internet Archive candidate: ${candidate.source}`)
    }
    const [item, group] = await this.groupOf(candidate.ref, ctx)
    let options = group.playable.map((playable) => streamOption(item, playable))
    if (this.readHeaders) {
      options = await Promise.all(options.map((option) => this.withHeader(option, ctx)))
    }
    return orderOptions(options, prefs)
  }

  /**
   * A FLAC option with the sample rate and bit depth its header states, when readable. A file's
   * header is read once per item lifetime; a failed read is tried again next time.
   */
  private async withHeader(option: StreamOption, ctx: ProviderContext): Promise<StreamOption> {
    if (option.codec !== 'flac') return option
    const info = await this.headers
      .get(
        option.url,
        this.itemTtlMs,
        async () => {
          const found = await fetchFlacStreamInfo(ctx, option.url, this.timeoutMs)
          if (found === null) throw new Error('Unreadable FLAC header')
          return found
        },
        ctx.signal,
      )
      .catch(() => {
        if (ctx.signal?.aborted) throw ctx.signal.reason
        return null
      })
    return info === null
      ? option
      : { ...option, sampleRateHz: info.sampleRateHz, bitDepth: info.bitDepth }
  }
}

/**
 * The Internet Archive source. Keep one instance per app: it caches searches and item metadata,
 * and shares one request between callers asking for the same item.
 */
export function createArchiveSource(options: ArchiveSourceOptions = {}): ArchiveSource {
  return new ArchiveSourceImpl(options)
}
