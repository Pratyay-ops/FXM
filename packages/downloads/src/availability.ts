/**
 * Where a track can be downloaded: only where its bytes are readable (ARCHITECTURE.md §14).
 *
 * @module
 */

import {
  isBuiltInSourceId,
  isYouTubeCandidate,
  modePolicy,
  type ProviderContext,
  type StreamOption,
  type Track,
} from '@fxm/core'
import type { DownloadResolver } from './resolver'

/**
 * Whether a track can be downloaded here, and if not, why:
 *
 * - `local`: it is a local file, already on the device
 * - `hidden`: the catalog mode hides it (a video in Music mode)
 * - `needs-full-access`: its audio is on YouTube, and this platform can't read YouTube's bytes:
 *   a browser without FXM Connect, the experimental Lite tier included. Downloads are never
 *   offered there
 * - `unsupported-source`: a plugin source, whose bytes FXM can't vouch for yet
 * - `no-source`: nothing here can resolve its audio yet (the resolver has no stream source for
 *   it, see `DownloadResolver.canResolve`)
 */
export type DownloadAvailability =
  | { readonly available: true }
  | {
      readonly available: false
      readonly reason: 'local' | 'hidden' | 'needs-full-access' | 'unsupported-source' | 'no-source'
    }

const AVAILABLE: DownloadAvailability = Object.freeze({ available: true })

/**
 * Whether `track` can be downloaded with the platform's capabilities in the catalog mode:
 *
 * - Internet Archive and Jamendo audio everywhere: both serve their files with CORS headers
 *   that any page may read;
 * - YouTube audio, and the matched song of a track from a catalog without audio (Spotify) or of
 *   a music video in Music mode, only with `capabilities.mediaBytes`: FXM Connect, the desktop
 *   app or the Android app. Never in the Lite tier, where googlevideo's bytes are unreadable;
 * - never a local file (it is already here), a track the mode hides, or a plugin source;
 * - with a `resolver`, only a track it can resolve (`canResolve`): an app whose stream sources
 *   aren't wired in offers nothing it would then fail to download.
 */
export function downloadAvailability(
  track: Pick<Track, 'source' | 'kind' | 'songId' | 'id'>,
  ctx: Pick<ProviderContext, 'capabilities' | 'mode'>,
  resolver?: Pick<DownloadResolver, 'canResolve'>,
): DownloadAvailability {
  if (track.source === 'local') return { available: false, reason: 'local' }
  if (modePolicy(track, ctx.mode) === 'hidden') return { available: false, reason: 'hidden' }
  if (!isBuiltInSourceId(track.source)) return { available: false, reason: 'unsupported-source' }
  // Internet Archive and Jamendo files are readable anywhere; YouTube's own audio, and the
  // YouTube song matched to anything else, only where its bytes are.
  const free = track.source === 'archive' || track.source === 'jamendo'
  if (!free && !ctx.capabilities.mediaBytes) {
    return { available: false, reason: 'needs-full-access' }
  }
  if (resolver?.canResolve?.(track) === false) return { available: false, reason: 'no-source' }
  return AVAILABLE
}

/**
 * The downloads that wait together when a source asks FXM to slow down (or a bot check stops
 * it): every download whose audio comes from YouTube or is matched there shares the `youtube`
 * lane, and Internet Archive and Jamendo have one each.
 */
export function downloadLane(track: Pick<Track, 'source'>): 'youtube' | 'archive' | 'jamendo' {
  return track.source === 'archive' || track.source === 'jamendo' ? track.source : 'youtube'
}

/**
 * Whether a stream may be downloaded: a progressive file that is not `capped`, and for YouTube,
 * whose URLs are often cut off after 0.4-2 MiB, one that passed the end-of-file probe
 * (`fullLength` `verified`). Other sources never cap their URLs, and the transfer finds out the
 * real size as it goes.
 */
export function isDownloadableStream(
  candidate: Parameters<typeof isYouTubeCandidate>[0],
  stream: Pick<StreamOption, 'protocol' | 'fullLength'>,
): boolean {
  if (stream.protocol !== 'progressive' || stream.fullLength === 'capped') return false
  return !isYouTubeCandidate(candidate) || stream.fullLength === 'verified'
}
