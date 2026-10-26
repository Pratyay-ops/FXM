/**
 * iTunes Search, for covers that a track's own source lacks, on every tier.
 *
 * ```ts
 * import { bestItunesSong, createItunesClient, itunesArtwork } from '@fxm/sources/itunes'
 *
 * const itunes = createItunesClient()
 * const query = { title: 'Get Lucky', artists: ['Daft Punk'] }
 * const song = bestItunesSong(await itunes.searchSongs('Daft Punk Get Lucky', ctx), query)
 * const artwork = song?.artworkUrl ? itunesArtwork(song.artworkUrl) : []
 * ```
 *
 * @module
 */

export {
  createItunesClient,
  DEFAULT_ITUNES_COUNTRY,
  ITUNES_ARTWORK_SIZES,
  ITUNES_SEARCH_URL,
  type ItunesAlbum,
  type ItunesClient,
  type ItunesOptions,
  type ItunesSearchOptions,
  type ItunesSong,
  itunesArtwork,
  itunesStoreUrl,
  parseItunesAlbums,
  parseItunesSongs,
} from './api'
export { bestItunesAlbum, bestItunesSong, type ItunesArtworkQuery } from './match'
