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
  createLastfmApiClient,
  LASTFM_API_URL,
  type LastfmApiClient,
  type LastfmApiOptions,
  type LastfmSimilarArtist,
  type LastfmSimilarArtistsOptions,
  parseLastfmSimilarArtists,
} from './api'
export {
  createLastfmStations,
  LASTFM_STATION_PREFIX,
  LASTFM_WEB_ORIGIN,
  type LastfmStation,
  LastfmStationPacing,
  type LastfmStationPacingOptions,
  type LastfmStations,
  type LastfmStationsOptions,
  type LastfmStationTrack,
  lastfmPathSegment,
  lastfmStationPacing,
  lastfmStationsReachable,
  lastfmStationUrl,
  parseLastfmStation,
} from './station'
