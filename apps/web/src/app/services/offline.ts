/**
 * The stream lifecycle's offline copies (stage 2.3's `OfflineStore`), which play before anything
 * is resolved, also without a network (ARCHITECTURE.md §7.4):
 *
 * 1. **Downloads** (stage 4.1): the downloads' own store (`getOfflineStore()` of
 *    `features/downloads/runtime.ts`), a `blob:` URL of the stored file; in the Android app the
 *    WebView URL of its file in the app's storage, which Media3 reads from the device (stage
 *    6.4). Its code, with Dexie and
 *    the download manager, loads with the first resolution, beside the first render (`main.tsx`
 *    loads it then anyway to run the queue), so the composition root's chunk doesn't carry it.
 * 2. **The user's own files** (stage 4.4): a music file tagged with the track's ISRC, so a song
 *    the user owns, perhaps in FLAC, plays from their copy (`createLocalAudioSource()`'s
 *    `match`). Only a catalog track with an ISRC can have one; local tracks themselves never
 *    reach the lifecycle (`withLocalFilesFirst`).
 *
 * A copy that can't be read (a folder that needs the user's permission again, a file gone) is
 * skipped, and the lifecycle resolves the track as usual.
 *
 * @module
 */

import {
  type AudioSource,
  DEFAULT_QUALITY_PREFS,
  isFxmError,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import type { OfflineStore } from '@fxm/player'
import { createLocalAudioSource } from '../../features/local-files/audio-source'

/** Asks each store in turn; the first copy found plays. A store that fails is skipped. */
export function firstOfflineCopy(stores: readonly OfflineStore[]): OfflineStore {
  return {
    async find(track, ctx) {
      for (const store of stores) {
        try {
          const found = await store.find(track, ctx)
          if (found !== undefined) return found
        } catch (error) {
          const signal = ctx.signal as AbortSignal | undefined
          if (signal?.aborted) throw error
        }
      }
      return undefined
    },
  }
}

/**
 * An offline store over a source of the user's own files (`createLocalAudioSource()`): the best
 * file tagged with the track's ISRC. Tracks without an ISRC, and local tracks, which play
 * through their own lane, find nothing, without opening anything.
 */
export function localIsrcCopies(files: Pick<AudioSource, 'match' | 'resolve'>): OfflineStore {
  return {
    async find(track: Track, ctx: ProviderContext) {
      if (track.source === 'local' || track.isrc === undefined) return undefined
      const [best] = await files.match(track, ctx)
      if (best === undefined) return undefined
      try {
        const [stream] = await files.resolve(best, ctx, DEFAULT_QUALITY_PREFS)
        return stream
      } catch (error) {
        // A file gone, or a folder that needs the user's permission again: stream instead.
        if (isFxmError(error)) return undefined
        throw error
      }
    },
  }
}

/** The downloads' offline store, loaded on first use. */
function downloadedCopies(): OfflineStore {
  return {
    async find(track, ctx) {
      const { getOfflineStore } = await import('../../features/downloads/runtime')
      return getOfflineStore().find(track, ctx)
    },
  }
}

/** The app's offline copies: downloads first, then the user's own files by ISRC. */
export function appOfflineStore(): OfflineStore {
  return firstOfflineCopy([downloadedCopies(), localIsrcCopies(createLocalAudioSource())])
}
