/**
 * Fills artwork gaps for any track: a track whose source gave no cover (a Last.fm station item,
 * a video, an import) gets its release's cover from the Cover Art Archive, else from iTunes
 * Search. Matching is strict, so a gap stays a gap rather than showing another record's cover.
 *
 * @module
 */

import type { Artwork, ProviderContext, Track } from '@fxm/core'
import type { CoverArtClient } from '../coverart/api'
import { type ItunesClient, itunesArtwork } from '../itunes/api'
import { type ArtworkQuery, bestAlbum, bestSong } from '../itunes/match'
import type { ListenBrainzClient } from '../listenbrainz/api'
import { TtlCache } from '../shared/ttl-cache'
import type { ReleaseMbidLookup } from './adapters'
import { cleanArtist, comparable, readTitle, similarity, songKey } from './internal/text'

/** The sources an artwork filler uses. Leave out what the app does not want to contact. */
export interface ArtworkFillerOptions {
  /** The Cover Art Archive, tried first. */
  coverArt?: CoverArtClient
  /** ListenBrainz's lookup, which finds a track's MusicBrainz release for the archive. */
  listenbrainz?: ListenBrainzClient
  /**
   * Another way to find a track's MusicBrainz release, tried before ListenBrainz's lookup, e.g.
   * MusicBrainz's exact path for a Spotify track (stage 1.6).
   */
  releaseMbid?: ReleaseMbidLookup
  /** iTunes Search, tried when the archive has no cover. */
  itunes?: ItunesClient
  /** How long to remember a cover found. Default 24 hours. */
  cacheTtlMs?: number
  /** How long to remember that nothing was found. Default 6 hours. */
  missTtlMs?: number
}

/** Fills tracks' artwork gaps. */
export interface ArtworkFiller {
  /**
   * Covers for `track`, smallest first, from the first source that has one: the Cover Art
   * Archive for the track's MusicBrainz release, then iTunes Search (its album, then the song).
   * Empty when none matches. Sources that fail are skipped; only a cancelled `ctx.signal`
   * rejects, with its reason. A track without a title or an artist gets none, without a
   * request.
   */
  artworkFor(track: Track, ctx: ProviderContext): Promise<Artwork[]>
  /** `track` with covers from {@link artworkFor} when it has none; otherwise `track` itself. */
  fill(track: Track, ctx: ProviderContext): Promise<Track>
}

/** Below this similarity, a release found for a track is not the album the track names. */
const SAME_ALBUM = 0.6

/** What a track's cover is looked up by, or `null` when it has no title or no artist. */
function queryFor(track: Track): ArtworkQuery | null {
  const artists = track.artists.map((artist) => cleanArtist(artist.name)).filter(Boolean)
  const title = readTitle(track.title, artists).clean
  if (artists.length === 0 || title === '') return null
  const query: ArtworkQuery = { title, artists }
  const album = track.album?.name.trim()
  if (album) query.album = album
  if (track.durationMs !== undefined) query.durationMs = track.durationMs
  return query
}

/** Creates an {@link ArtworkFiller}. Share one instance, so that its cache holds. */
export function createArtworkFiller(options: ArtworkFillerOptions = {}): ArtworkFiller {
  const ttlMs = options.cacheTtlMs ?? 24 * 3_600_000
  const missTtlMs = options.missTtlMs ?? 6 * 3_600_000
  const cache = new TtlCache<Artwork[]>({ maxEntries: 2_000 })

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
   * The archive's cover of the track's release, and whether that release is the album the track
   * names (unknown albums count as yes).
   */
  async function fromArchive(
    track: Track,
    query: ArtworkQuery,
    ctx: ProviderContext,
    failed: { any: boolean },
  ): Promise<{ artwork: Artwork[]; sameAlbum: boolean } | null> {
    const { coverArt, listenbrainz, releaseMbid } = options
    if (coverArt === undefined) return null
    let mbid =
      releaseMbid === undefined ? null : await attempt(ctx, failed, () => releaseMbid(track, ctx))
    let sameAlbum = true
    if (mbid === null && listenbrainz !== undefined) {
      const [main = ''] = query.artists
      const core = readTitle(query.title, query.artists).core
      const lookup = await attempt(ctx, failed, () => listenbrainz.lookupRecording(main, core, ctx))
      mbid = lookup?.releaseMbid ?? null
      if (query.album !== undefined && lookup?.releaseName !== undefined) {
        sameAlbum =
          similarity(comparable(query.album), comparable(lookup.releaseName)) >= SAME_ALBUM
      }
    }
    if (mbid === null) return null
    const id = mbid
    const artwork = await attempt(ctx, failed, () => coverArt.releaseArtwork(id, ctx))
    return artwork === null || artwork.length === 0 ? null : { artwork, sameAlbum }
  }

  /** iTunes' cover of the track's album, else of the song. */
  async function fromItunes(
    query: ArtworkQuery,
    ctx: ProviderContext,
    failed: { any: boolean },
  ): Promise<Artwork[] | null> {
    const { itunes } = options
    if (itunes === undefined) return null
    const [main = ''] = query.artists
    if (query.album !== undefined) {
      const term = `${main} ${query.album}`
      const albums = await attempt(ctx, failed, () => itunes.searchAlbums(term, ctx))
      const album = albums === null ? null : bestAlbum(albums, query)
      if (album?.artworkUrl !== undefined) return itunesArtwork(album.artworkUrl)
    }
    const core = readTitle(query.title, query.artists).core
    const songs = await attempt(ctx, failed, () => itunes.searchSongs(`${main} ${core}`, ctx))
    const song = songs === null ? null : bestSong(songs, query)
    return song?.artworkUrl === undefined ? null : itunesArtwork(song.artworkUrl)
  }

  async function artworkFor(track: Track, ctx: ProviderContext): Promise<Artwork[]> {
    const query = queryFor(track)
    if (query === null) return []
    const [main = ''] = query.artists
    const key = `${songKey(main, query.title)}|${comparable(query.album ?? '')}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const failed = { any: false }
    const archive = await fromArchive(track, query, ctx, failed)
    // A release that is not the track's album (e.g. a compilation) is the last resort.
    let artwork =
      archive?.sameAlbum === true ? archive.artwork : await fromItunes(query, ctx, failed)
    if (artwork === null || artwork.length === 0) artwork = archive?.artwork ?? []
    if (artwork.length > 0) cache.set(key, artwork, ttlMs)
    else if (!failed.any) cache.set(key, artwork, missTtlMs)
    return artwork
  }

  return {
    artworkFor,
    async fill(track, ctx) {
      if (track.artwork.length > 0) return track
      const artwork = await artworkFor(track, ctx)
      return artwork.length === 0 ? track : { ...track, artwork }
    },
  }
}
