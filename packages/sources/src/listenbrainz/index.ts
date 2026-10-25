/**
 * ListenBrainz: similar artists and MusicBrainz lookups from its keyless labs API, on every
 * tier.
 *
 * ```ts
 * import { createListenBrainzClient } from '@fxm/sources/listenbrainz'
 *
 * const listenbrainz = createListenBrainzClient()
 * const lookup = await listenbrainz.lookupRecording('Radiohead', 'Creep', ctx)
 * const similar = await listenbrainz.similarArtists(lookup.artistMbids[0], ctx)
 * ```
 *
 * @module
 */

export {
  createListenBrainzClient,
  DEFAULT_SIMILAR_ARTISTS_ALGORITHM,
  isMbid,
  LISTENBRAINZ_LABS_ORIGIN,
  type ListenBrainzClient,
  type ListenBrainzOptions,
  parseRecordingLookup,
  parseSimilarArtists,
  type RecordingLookup,
  type SimilarArtist,
  type SimilarArtistsOptions,
} from './api'
