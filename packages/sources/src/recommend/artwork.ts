/**
 * Fills artwork gaps for any track: a track whose source gave no cover (a Last.fm station item,
 * a video, an import) gets its release's cover from the Cover Art Archive, else from iTunes
 * Search. Matching is strict, versions included, so a gap stays a gap rather than showing
 * another record's cover: a live take, an acoustic version or a re-recording ("Taylor's
 * Version") never gets the studio album's cover, and a release that is not the album the track
 * names is not used at all.
 *
 * @module
 */

import type { Artwork, ProviderContext, Track } from '@fxm/core'
import type { CoverArtClient } from '../coverart/api'
import { type ItunesClient, itunesArtwork } from '../itunes/api'
import { bestItunesAlbum, bestItunesSong, type ItunesArtworkQuery } from '../itunes/match'
import type { ListenBrainzClient } from '../listenbrainz/api'
import type { PacedCallOptions } from '../shared/gate'
import { normalizeMbid } from '../shared/mbid'
import {
  cleanArtist,
  comparable,
  lookupTitle,
  nameKey,
  readTitle,
  sameVersions,
  similarity,
  type TitleReading,
} from '../shared/names'
import { TtlCache } from '../shared/ttl-cache'
import type { ReleaseMbidLookup } from './adapters'
import { songKey } from './keys'

/** Where MusicBrainz's release pages live, which the Cover Art Archive's listings link to. */
const MUSICBRAINZ_RELEASE_URL = 'https://musicbrainz.org/release/'

/** The sources an artwork filler uses. Leave out what the app does not want to contact. */
export interface ArtworkFillerOptions {
  /** The Cover Art Archive, tried first. */
  coverArt?: CoverArtClient
  /** ListenBrainz's lookup, which finds a track's MusicBrainz release for the archive. */
  listenbrainz?: ListenBrainzClient
  /**
   * Another way to find a track's MusicBrainz release, tried before ListenBrainz's lookup and
   * trusted as the track's own release (stage 1.6).
   */
  releaseMbid?: ReleaseMbidLookup
  /** iTunes Search, tried when the archive has no cover. */
  itunes?: ItunesClient
  /** How long to remember a cover found. Default 24 hours. */
  cacheTtlMs?: number
  /** How long to remember that nothing was found. Default 6 hours. */
  missTtlMs?: number
}

/** A cover found for a track, and where it came from. */
export interface ArtworkResult {
  /** The cover in the sizes the source offers, smallest first. */
  artwork: Artwork[]
  /**
   * Its source. Apple's terms want iTunes artwork shown next to a store badge that links to
   * `pageUrl`; the Cover Art Archive's covers need no badge.
   */
  source: 'coverartarchive' | 'itunes'
  /**
   * A page about the cover's record: the MusicBrainz release of an archive cover, or the iTunes
   * Store page of the album or song, for the store badge. Absent when the source gave none.
   */
  pageUrl?: string
}

/**
 * Options for one lookup. Pass `priority: 'bulk'` when filling a list in the background, so that
 * its requests wait behind the cover of the track the user is looking at.
 */
export type ArtworkOptions = PacedCallOptions

/** Fills tracks' artwork gaps. */
export interface ArtworkFiller {
  /**
   * The cover for `track`, from the first source that has one: the Cover Art Archive for the
   * track's MusicBrainz release, then iTunes Search (its album, then the song). `null` when
   * none matches. Sources that fail are skipped; only a cancelled `ctx.signal` rejects, with its
   * reason. A track without a title or an artist gets none, without a request.
   */
  artworkFor(
    track: Track,
    ctx: ProviderContext,
    options?: ArtworkOptions,
  ): Promise<ArtworkResult | null>
  /** `track` with the cover from {@link artworkFor} when it has none; otherwise `track` itself. */
  fill(track: Track, ctx: ProviderContext, options?: ArtworkOptions): Promise<Track>
}

/** Below this similarity, a release found for a track is not the album the track names. */
const SAME_ALBUM = 0.6

/** What a track's cover is looked up by. */
interface Query extends ItunesArtworkQuery {
  /** The title, read for matching: its versions decide which recording it is. */
  reading: TitleReading
}

/** What a track's cover is looked up by, or `null` when it has no title or no artist. */
function queryFor(track: Track): Query | null {
  const artists = track.artists.map((artist) => cleanArtist(artist.name)).filter(Boolean)
  const reading = readTitle(track.title, artists)
  if (artists.length === 0 || reading.clean === '') return null
  const query: Query = { title: reading.clean, artists, reading }
  const album = track.album?.name.trim()
  if (album) query.album = album
  if (track.durationMs !== undefined) query.durationMs = track.durationMs
  return query
}

/**
 * The cache key of a query: the song, its strong version tags and its album, so that two
 * versions of one song ("Creep" and "Creep (Acoustic)") never share a cover.
 */
function cacheKey(query: Query): string {
  const [main = ''] = query.artists
  const versions = query.reading.versions.join(',')
  return `${songKey(main, query.title)}|${versions}|${nameKey(query.album ?? '')}`
}

/** Creates an {@link ArtworkFiller}. Share one instance, so that its cache holds. */
export function createArtworkFiller(options: ArtworkFillerOptions = {}): ArtworkFiller {
  const ttlMs = options.cacheTtlMs ?? 24 * 3_600_000
  const missTtlMs = options.missTtlMs ?? 6 * 3_600_000
  const cache = new TtlCache<ArtworkResult | null>({ maxEntries: 2_000 })

  /**
   * Runs one source's lookup. Failures other than a cancellation give nothing, and say so, so
   * that a miss caused by a failure is not remembered.
   */
  async function attempt<T>(
    ctx: ProviderContext,
    failed: { any: boolean },
    lookup: () => Promise<T | null>,
  ): Promise<T | null> {
    try {
      return await lookup()
    } catch {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      // Artwork is never worth failing for: skip the source, and retry it next time.
      failed.any = true
      return null
    }
  }

  /**
   * The MusicBrainz release of the track, when there is one that is the track's: the adapter's,
   * else ListenBrainz's lookup, if that found the same version of the song (by its strong
   * version tags) on a release that is the album the track names (unknown albums count as yes).
   */
  async function releaseOf(
    track: Track,
    query: Query,
    ctx: ProviderContext,
    failed: { any: boolean },
    call: ArtworkOptions,
  ): Promise<string | null> {
    const { listenbrainz, releaseMbid } = options
    const own =
      releaseMbid === undefined ? null : await attempt(ctx, failed, () => releaseMbid(track, ctx))
    if (own !== null) return own
    if (listenbrainz === undefined) return null
    const [main = ''] = query.artists
    const name = lookupTitle(query.reading)
    const lookup = await attempt(ctx, failed, () =>
      listenbrainz.lookupRecording(main, name, ctx, call),
    )
    if (lookup?.releaseMbid === undefined) return null
    const found = readTitle(lookup.recordingName, [lookup.artistCredit])
    if (!sameVersions(found.versions, query.reading.versions)) return null
    if (
      query.album !== undefined &&
      lookup.releaseName !== undefined &&
      similarity(comparable(query.album), comparable(lookup.releaseName)) < SAME_ALBUM
    ) {
      return null
    }
    return lookup.releaseMbid
  }

  /** The archive's cover of the track's release. */
  async function fromArchive(
    track: Track,
    query: Query,
    ctx: ProviderContext,
    failed: { any: boolean },
    call: ArtworkOptions,
  ): Promise<ArtworkResult | null> {
    const { coverArt } = options
    if (coverArt === undefined) return null
    const release = await releaseOf(track, query, ctx, failed, call)
    if (release === null) return null
    const artwork = await attempt(ctx, failed, () => coverArt.releaseArtwork(release, ctx, call))
    if (artwork === null || artwork.length === 0) return null
    const mbid = normalizeMbid(release)
    return mbid === undefined
      ? { artwork, source: 'coverartarchive' }
      : { artwork, source: 'coverartarchive', pageUrl: `${MUSICBRAINZ_RELEASE_URL}${mbid}` }
  }

  /** iTunes' cover of the track's album, else of the song. */
  async function fromItunes(
    query: Query,
    ctx: ProviderContext,
    failed: { any: boolean },
    call: ArtworkOptions,
  ): Promise<ArtworkResult | null> {
    const { itunes } = options
    if (itunes === undefined) return null
    const [main = ''] = query.artists
    if (query.album !== undefined) {
      const term = `${main} ${query.album}`
      const albums = await attempt(ctx, failed, () => itunes.searchAlbums(term, ctx, call))
      const album = albums === null ? null : bestItunesAlbum(albums, query)
      if (album?.artworkUrl !== undefined) {
        return result(itunesArtwork(album.artworkUrl), album.storeUrl)
      }
    }
    const term = `${main} ${lookupTitle(query.reading)}`
    const songs = await attempt(ctx, failed, () => itunes.searchSongs(term, ctx, call))
    const song = songs === null ? null : bestItunesSong(songs, query)
    return song?.artworkUrl === undefined
      ? null
      : result(itunesArtwork(song.artworkUrl), song.storeUrl)
  }

  /** An iTunes result, or `null` when it has no usable artwork. */
  function result(artwork: Artwork[], pageUrl: string | undefined): ArtworkResult | null {
    if (artwork.length === 0) return null
    return pageUrl === undefined
      ? { artwork, source: 'itunes' }
      : { artwork, source: 'itunes', pageUrl }
  }

  async function artworkFor(
    track: Track,
    ctx: ProviderContext,
    call: ArtworkOptions = {},
  ): Promise<ArtworkResult | null> {
    const query = queryFor(track)
    if (query === null) return null
    const key = cacheKey(query)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const failed = { any: false }
    const found =
      (await fromArchive(track, query, ctx, failed, call)) ??
      (await fromItunes(query, ctx, failed, call))
    if (found !== null) cache.set(key, found, ttlMs)
    else if (!failed.any) cache.set(key, null, missTtlMs)
    return found
  }

  return {
    artworkFor,
    async fill(track, ctx, call = {}) {
      if (track.artwork.length > 0) return track
      const found = await artworkFor(track, ctx, call)
      return found === null ? track : { ...track, artwork: found.artwork }
    },
  }
}
