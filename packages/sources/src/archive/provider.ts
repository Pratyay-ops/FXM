/**
 * The Internet Archive as an FXM source (`archive`): a metadata provider for its free, FLAC-first
 * audio items, and an audio source whose streams are the items' files.
 *
 * - **Search** finds items (`mediatype:audio` and the Live Music Archive's `etree`) that have a
 *   FLAC file and are not access-restricted. Albums are the items; songs are the tracks of the
 *   first few items that fit the words.
 * - **Tracks** are the items' recordings, one per audio file and its derivatives (see
 *   `audioGroups`), with IDs `archive:track:<identifier>/<file path>`. Albums are items.
 * - **Streams** are every playable file of a track: the FLAC original (`lossless`), and the MP3
 *   and Ogg Vorbis files the Archive made from it, tiered by `tierOf`. They are plain
 *   `https://archive.org/download/…` URLs that never expire and work from any IP, `unverified`
 *   because the Archive does not cap them and nothing probed their end.
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
  extractVersionTags,
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
  type Comparable,
  MIN_CANDIDATE_CONFIDENCE,
  orderOptions,
  scoreCandidate,
  wordsOf,
} from '../shared/audio-source'
import { LoadCache } from '../shared/ttl-cache'
import { ArchiveApi, type ArchiveSearch, type ArchiveSearchDoc } from './api'
import { type FlacStreamInfo, probeFlac } from './flac'
import {
  ARCHIVE_ORIGIN,
  type ArchiveItem,
  type AudioGroup,
  audioGroups,
  coverFiles,
  downloadUrl,
  groupField,
  groupWithFile,
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
  /** How many items a song search opens to list their tracks. 4 by default. */
  trackSearchItems?: number
  /** How many items a match opens to look for the track. 3 by default. */
  matchItems?: number
  /**
   * Whether `resolve` reads each FLAC stream's first 42 bytes for its sample rate and bit depth:
   * one small range request per FLAC file. Off by default; the `24bit Flac` format name still
   * gives the bit depth without it.
   */
  probeFlac?: boolean
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

/** An item's artwork: uploaded covers, largest first, then the item tile. */
function artworkOf(item: ArchiveItem): Artwork[] {
  const covers = coverFiles(item).map((file): Artwork => {
    const artwork: Artwork = { url: downloadUrl(item.identifier, file.name) }
    if (file.width !== undefined) artwork.width = file.width
    if (file.height !== undefined) artwork.height = file.height
    return artwork
  })
  return [...covers, { url: tileUrl(item.identifier) }]
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

/** The page a cursor from this source names, from 1; no cursor means the first page. */
function pageOf(cursor: string | undefined): number {
  if (cursor === undefined) return 1
  const page = Number(cursor)
  if (!Number.isSafeInteger(page) || page < 2 || String(page) !== cursor) {
    throw new RangeError(`Not an Internet Archive search cursor: ${cursor}`)
  }
  return page
}

/** A page size within 1-100, `fallback` when absent. */
function rows(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(1, Math.round(limit ?? fallback)), 100)
}

/** Whether an item is a concert recording: the Live Music Archive, or "Live" in its title. */
function isLiveItem(item: ArchiveItem): boolean {
  return item.mediatype === 'etree' || extractVersionTags(item.title ?? '').strong.includes('live')
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
  private readonly probe: boolean
  private readonly probes: LoadCache<FlacStreamInfo>
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
    this.probes = new LoadCache({ maxEntries: 200, ...now })
    this.mediatypes = options.mediatypes ?? ['audio', 'etree']
    this.sort = options.sort ?? 'downloads'
    this.trackSearchItems = rows(options.trackSearchItems, 4)
    this.matchItems = rows(options.matchItems, 3)
    this.probe = options.probeFlac ?? false
  }

  async search(
    query: string,
    options: SearchOptions,
    ctx: ProviderContext,
  ): Promise<SearchResults> {
    const { types } = options
    const page = pageOf(options.cursor)
    const results: SearchResults = {}
    const wantAlbums = types.includes('album')
    const wantTracks = types.includes('track')
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
        results.tracks = await this.tracksOf(docs, query, rows(options.limit, 50), ctx)
        if (page * this.trackSearchItems < found.total) results.tracks.nextCursor = String(page + 1)
      }
    }
    if (types.includes('artist')) results.artists = { items: [] }
    if (types.includes('playlist')) results.playlists = { items: [] }
    if (types.includes('video')) results.videos = { items: [] }
    return results
  }

  /** The tracks of some items that fit a search's words, at most `limit`. */
  private async tracksOf(
    docs: readonly ArchiveSearchDoc[],
    query: string,
    limit: number,
    ctx: ProviderContext,
  ): Promise<Page<Track>> {
    const words = wordsOf(query).filter((word) => !STOP_WORDS.has(word))
    const items = await this.openItems(docs, ctx)
    const tracks = items.flatMap((item) =>
      audioGroups(item)
        .map((group) => trackOf(item, group))
        .filter((track) => fits(track, item, words)),
    )
    return { items: applyModeFilter(tracks, ctx.mode).slice(0, limit) }
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

  async match(track: Track, ctx: ProviderContext): Promise<AudioCandidate[]> {
    const own = this.ownRef(track)
    if (own !== undefined) return filterPlayable([this.ownCandidate(track, own)], ctx.mode)
    const { core, qualifiers } = splitTitle(stripPresentationNoise(track.title))
    const artist = track.artists[0]?.name ?? ''
    if (wordsOf(core).length === 0 || wordsOf(artist).length === 0) return []
    const live = extractVersionTags(qualifiers.join(' ')).strong.includes('live')
    const search: ArchiveSearch = {
      text: artist,
      anyOf: [core, ...(track.album === undefined ? [] : [track.album.name])],
      mediatypes: live ? this.mediatypes : this.mediatypes.filter((type) => type !== 'etree'),
      rows: this.matchItems,
      page: 1,
      sort: this.sort,
    }
    const found = await this.api.search(search, ctx)
    const items = await this.openItems(found.docs, ctx)
    const wanted: Comparable = {
      title: track.title,
      artists: track.artists.map((entry) => entry.name),
      ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
      ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
    }
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
    const score = scoreCandidate(wanted, {
      title: found.title,
      artists,
      live: isLiveItem(item),
      ...(found.durationMs === undefined ? {} : { durationMs: found.durationMs }),
      ...(found.isrc === undefined ? {} : { isrc: found.isrc }),
    })
    const albumWords = wordsOf(track.album?.name ?? '').join(' ')
    const signals: MatchSignals = {
      isrcVerified: score.isrcMatch,
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
    if (this.probe) options = await Promise.all(options.map((option) => this.probed(option, ctx)))
    return orderOptions(options, prefs)
  }

  /**
   * A FLAC option with the sample rate and bit depth its first bytes state, when readable. A file
   * is probed once per item lifetime; a failed probe is tried again next time.
   */
  private async probed(option: StreamOption, ctx: ProviderContext): Promise<StreamOption> {
    if (option.codec !== 'flac') return option
    const info = await this.probes
      .get(
        option.url,
        this.itemTtlMs,
        async () => {
          const found = await probeFlac(ctx, option.url, this.timeoutMs)
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
