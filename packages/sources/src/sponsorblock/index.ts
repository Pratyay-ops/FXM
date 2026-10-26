/**
 * SponsorBlock (https://sponsor.ajay.app): the non-music parts of music videos, the intros, skits
 * and outros its community marks, so FXM can skip them in Music + Video mode (stage 8.7). Opt-in.
 * Only the first four hex characters of a hash of the videoId leave the device, so SponsorBlock
 * can't tell which video plays. Its data is CC BY-NC-SA 4.0, credited where FXM uses it.
 *
 * ```ts
 * import { createSponsorBlockClient, skippableVideoId } from '@fxm/sources/sponsorblock'
 *
 * const sponsorBlock = createSponsorBlockClient()
 * const videoId = skippableVideoId(item, mode) // undefined for songs and in Music mode
 * const segments = videoId === undefined ? [] : await sponsorBlock.nonMusicSegments(videoId, ctx)
 * ```
 *
 * @module
 */

export {
  createSponsorBlockClient,
  NON_MUSIC_CATEGORY,
  parseBucket,
  SPONSORBLOCK_DATA_LICENSE,
  SPONSORBLOCK_DEFAULTS,
  SPONSORBLOCK_ORIGIN,
  type SponsorBlockClient,
  type SponsorBlockOptions,
  type SponsorBlockSegment,
  toSegment,
} from './api'
export { HASH_PREFIX_LENGTH, hashPrefix, isVideoId, type Sha256, webCryptoSha256 } from './hash'
export { type SkippableItem, skippableVideoId } from './skippable'
