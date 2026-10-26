/**
 * Where the non-music parts of videos come from: SponsorBlock, through the client of stage 8.7
 * (`@fxm/sources/sponsorblock`). SponsorBlock answers every origin, so skipping works on every
 * tier that plays videos.
 *
 * @module
 */

import type { CatalogMode, ProviderContext, QueueItem } from '@fxm/core'
import type { SkipSegment } from '@fxm/player'
import {
  createSponsorBlockClient,
  type SponsorBlockClient,
  skippableVideoId,
} from '@fxm/sources/sponsorblock'
import { useSettingsStore } from '../settings/settings-store'
import { useSponsorBlockStore } from './sponsorblock-store'

let client: SponsorBlockClient | undefined

/**
 * The app's SponsorBlock client. One instance for the app, so lookups share its cache: one
 * answer covers every video of its hash prefix for an hour.
 */
export function getSponsorBlockClient(): SponsorBlockClient {
  client ??= createSponsorBlockClient()
  return client
}

/** Replaces the client, e.g. with a fake in tests; `undefined` goes back to SponsorBlock. */
export function setSponsorBlockClient(next: SponsorBlockClient | undefined): void {
  client = next
}

/**
 * The provider context for SponsorBlock lookups: the page's own `fetch`, without cookies.
 * SponsorBlock is CORS-friendly, so this reaches it on every tier, and it is the only service
 * the lookups contact, so the capabilities stay at their most limited.
 *
 * Integration with stage 1.2 (platform transports): use the platform's context instead, so the
 * desktop and Android apps send these requests through their native HTTP clients.
 */
export function sponsorBlockContext(mode: CatalogMode, signal: AbortSignal): ProviderContext {
  return {
    fetch: (input, init) => fetch(input, { ...init, credentials: 'omit' }),
    platform: 'web',
    capabilities: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
    mode,
    signal,
  }
}

/**
 * The parts of `item` to skip: SponsorBlock's non-music segments, when skipping is on, the mode
 * is Music + Video and the item is a video playing as itself (`skippableVideoId`). Anything else
 * gets an empty list without a request, so SponsorBlock hears nothing while skipping is off.
 */
export async function segmentsFor(item: QueueItem, signal: AbortSignal): Promise<SkipSegment[]> {
  if (!useSponsorBlockStore.getState().enabled) return []
  const mode = useSettingsStore.getState().catalogMode
  const videoId = skippableVideoId(item, mode)
  if (videoId === undefined) return []
  const segments = await getSponsorBlockClient().nonMusicSegments(
    videoId,
    sponsorBlockContext(mode, signal),
  )
  return segments.map(({ startMs, endMs, videoDurationMs }) =>
    videoDurationMs === undefined
      ? { startMs, endMs }
      : { startMs, endMs, mediaDurationMs: videoDurationMs },
  )
}
