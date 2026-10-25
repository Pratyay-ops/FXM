/**
 * What a YouTube video is, from YouTube Music's `musicVideoType`. It decides the catalog-mode
 * policy (see `modePolicy` in `@fxm/core`):
 *
 * | `musicVideoType`                       | FXM kind      |
 * |----------------------------------------|---------------|
 * | `MUSIC_VIDEO_TYPE_ATV`                 | `song`        |
 * | `MUSIC_VIDEO_TYPE_OMV`                 | `music-video` |
 * | `MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC` | `music-video` |
 * | `MUSIC_VIDEO_TYPE_UGC`, missing or unknown | `video`   |
 * | podcast types (`…_PODCAST_EPISODE`)    | `episode`     |
 *
 * Plain YouTube's results are always videos, whatever they are.
 *
 * @module
 */

import type { TrackKind } from '@fxm/core'

/** The `musicVideoType` values FXM tells apart. */
export const MUSIC_VIDEO_TYPES = {
  /** "Art track": a song from an album, with its cover as the picture. */
  song: 'MUSIC_VIDEO_TYPE_ATV',
  /** An official music video. */
  officialVideo: 'MUSIC_VIDEO_TYPE_OMV',
  /** Official audio of a release that is not an art track, shown as a music video. */
  officialSource: 'MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC',
  /** Anything uploaded by a user. */
  upload: 'MUSIC_VIDEO_TYPE_UGC',
  /** A podcast episode. */
  podcastEpisode: 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE',
} as const

/**
 * The kind of a YouTube Music item with this `musicVideoType` (see the module documentation).
 * Unknown and missing types are videos, which Music mode hides: it fails closed.
 */
export function kindOfMusicVideoType(musicVideoType: string | undefined): TrackKind {
  switch (musicVideoType) {
    case MUSIC_VIDEO_TYPES.song:
      return 'song'
    case MUSIC_VIDEO_TYPES.officialVideo:
    case MUSIC_VIDEO_TYPES.officialSource:
      return 'music-video'
    default:
      return musicVideoType?.includes('PODCAST') ? 'episode' : 'video'
  }
}
