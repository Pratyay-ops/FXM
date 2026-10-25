/**
 * Offline playback: the stream lifecycle's `OfflineStore` (stage 2.3), backed by completed
 * downloads. The playback policy tries it before anything else, so a downloaded track plays
 * from the device, also without a network.
 *
 * @module
 */

import {
  entityKey,
  isPlayable,
  modePolicy,
  type ProviderContext,
  type StreamOption,
  songForVideo,
  type Track,
} from '@fxm/core'
import { mimeTypeOf, type OfflineStore } from '@fxm/player'
import type { DownloadStorage } from './storage'
import type { DownloadStore } from './store'
import { type DownloadRecord, downloadId, isDownloadRecord } from './types'

/** What {@link createOfflineStore} reads. */
export interface OfflineStoreOptions {
  /** The download records. */
  store: Pick<DownloadStore, 'get'>
  /** The files. */
  storage: Pick<DownloadStorage, 'playbackUrl'>
}

/**
 * The downloads that could stand in for `track` in `mode`, by ID: its own, and for an official
 * music video in Music mode, which plays as its song, the linked song's.
 */
export function offlineIds(track: Track, mode: ProviderContext['mode']): string[] {
  const ids = [downloadId(track)]
  if (modePolicy(track, mode) === 'plays-linked-song') {
    const song = songForVideo(track)
    if (song !== undefined) ids.push(entityKey(song))
  }
  return ids
}

/** The stream that plays a completed download from `url`. */
export function offlineStream(record: DownloadRecord, url: string): StreamOption | undefined {
  const { format } = record
  if (format === undefined) return undefined
  return {
    url,
    codec: format.codec,
    container: format.container,
    media: format.media,
    tier: format.tier,
    ...(format.bitrateKbps === undefined ? {} : { bitrateKbps: format.bitrateKbps }),
    ...(format.sampleRateHz === undefined ? {} : { sampleRateHz: format.sampleRateHz }),
    ...(format.bitDepth === undefined ? {} : { bitDepth: format.bitDepth }),
    protocol: 'progressive',
    ipBound: false,
    // The whole file is on the device.
    fullLength: 'verified',
  }
}

/**
 * An `OfflineStore` for the stream lifecycle (`new StreamLifecycle({ offline, … })`): for a
 * track with a completed download whose audio may play in the context's catalog mode, a
 * `verified` stream of the stored file, at the storage's playback URL (a `blob:` URL in a
 * browser). The same file keeps its URL, so a copy that failed to play is not tried again.
 *
 * The mode rule is the playback policy's: a download of an official video's own audio (made in
 * Music + Video mode) never plays in Music mode, while in Music mode a downloaded song stands in
 * for its music video.
 */
export function createOfflineStore(options: OfflineStoreOptions): OfflineStore {
  return {
    async find(track, ctx) {
      for (const id of offlineIds(track, ctx.mode)) {
        const record = await options.store.get(id)
        if (!isDownloadRecord(record) || record.status !== 'completed') continue
        if (record.file === undefined || record.format === undefined) continue
        if (record.candidate === undefined || !isPlayable(record.candidate, ctx.mode)) continue
        const type = mimeTypeOf(record.format) ?? ''
        const url = await options.storage.playbackUrl(record.file, type)
        if (url === undefined) continue
        return offlineStream(record, url)
      }
      return undefined
    },
  }
}
