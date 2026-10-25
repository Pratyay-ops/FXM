/**
 * Last.fm: keyless station JSON (the Full tier only) and similar artists from the Last.fm API
 * (any tier, with an API key).
 *
 * ```ts
 * import { createLastfmStations } from '@fxm/sources/lastfm'
 *
 * const stations = createLastfmStations()
 * const songs = await stations.station({ type: 'similar', artist: 'Radiohead' }, ctx)
 * ```
 *
 * In Music mode a station's YouTube links must be classified before anything plays: the
 * recommendation collector (`@fxm/sources/recommend`) does that within the request budget.
 *
 * @module
 */

export {
  createLastfmApi,
  LASTFM_API_URL,
  type LastfmApi,
  type LastfmApiOptions,
  type LastfmSimilarArtist,
  parseSimilarArtists,
  type SimilarArtistsOptions,
} from './api'
export {
  createLastfmStations,
  LASTFM_WEB_ORIGIN,
  type LastfmStation,
  type LastfmStations,
  type LastfmStationsOptions,
  type LastfmStationTrack,
  lastfmPathSegment,
  lastfmStationsReachable,
  lastfmStationUrl,
  parseStation,
} from './station'
