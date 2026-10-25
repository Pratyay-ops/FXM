/**
 * Cover art from the Cover Art Archive, by MusicBrainz release, on every tier.
 *
 * ```ts
 * import { createCoverArtClient } from '@fxm/sources/coverart'
 *
 * const coverArt = createCoverArtClient()
 * const artwork = await coverArt.releaseArtwork('07aab296-9a40-42a9-8d1f-6b06aa032e8a', ctx)
 * ```
 *
 * @module
 */

export {
  COVER_ART_ARCHIVE_ORIGIN,
  COVER_ART_SIZES,
  type CoverArtClient,
  type CoverArtOptions,
  coverArtUrl,
  createCoverArtClient,
  parseCoverArt,
} from './api'
