/**
 * Recorded Last.fm answers for the tests. The stations were recorded on 2026-10-26 (IST) and
 * trimmed to the fields FXM reads plus two it ignores; their catalog data (titles, artists,
 * durations, YouTube IDs, page paths) is as Last.fm sent it.
 *
 * `api-similar-artists-synthetic.json` is not a recording: FXM has no Last.fm API key, so it
 * follows the format Last.fm documents for `artist.getSimilar` (read 2026-10-26), with names
 * and MBIDs from ListenBrainz's similar artists for Radiohead and made-up `match` values. The
 * live test checks the real format when `FXM_LASTFM_API_KEY` is set.
 *
 * @module
 */

import apiErrorMissingParameter from './api-error-missing-parameter.json'
import apiSimilarArtists from './api-similar-artists-synthetic.json'
import { CLIENT_CHALLENGE_HTML } from './client-challenge'
import stationArtist from './station-artist-radiohead.json'
import stationSimilar from './station-similar-radiohead.json'

/** The recorded and documented answers. */
export const fixtures = {
  /** `/player/station/music/Radiohead/+similar`: 24 songs by Radiohead and similar artists. */
  stationSimilar,
  /** `/player/station/music/Radiohead`: 30 Radiohead songs. */
  stationArtist,
  /** The challenge page Last.fm sent for a tag station instead of its JSON. */
  challenge: CLIENT_CHALLENGE_HTML,
  /** `artist.getSimilar` for Radiohead, in the documented format (not recorded). */
  apiSimilarArtists,
  /** The API's answer to a request without an API key (HTTP 400). */
  apiErrorMissingParameter,
}
