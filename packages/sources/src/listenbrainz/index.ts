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
  DEFAULT_LISTENBRAINZ_ALGORITHM,
  LISTENBRAINZ_LABS_ORIGIN,
  type ListenBrainzCallOptions,
  type ListenBrainzClient,
  type ListenBrainzOptions,
  type ListenBrainzRecordingLookup,
  type ListenBrainzSimilarArtist,
  type ListenBrainzSimilarArtistsOptions,
  parseListenBrainzRecordingLookup,
  parseListenBrainzSimilarArtists,
} from './api'
