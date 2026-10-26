/**
 * The MediaSource engine (stage 1.11): plays YouTube's SABR streams through `MediaSource`, on the
 * web with FXM Connect and in the desktop app. See `README.md` in this folder.
 *
 * The engine contract it implements is stage 2.2's (`engine-contract.ts` re-exports it from
 * `../../engine`), so it is not exported again here.
 *
 * @module
 */

export {
  browserMediaSource,
  type MediaSourceHost,
  MseEngine,
  type MseEngineOptions,
} from './mse-engine'
export { googleVideoOnly, type SabrFeed, type SabrFeedStarter, startSabrFeed } from './sabr-feed'
export {
  isGoogleVideoUrl,
  parseSabrPlayback,
  SABR_PLAYBACK_FORMAT,
  type SabrPlayback,
  type SabrPlaybackFormat,
} from './sabr-playback'
