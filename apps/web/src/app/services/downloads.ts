/**
 * Downloads (stage 4.1) on the app's services: the environment `features/downloads` runs on,
 * which `index.ts` connects with `connectDownloadEnvironment`, and the catalog pages' Download
 * entries (2.4's `DownloadActions`).
 *
 * - **The context** is the app's platform's, at the request budget's `bulk` priority: downloads
 *   are background work, so "Download all" on a long playlist never gets in the way of search
 *   and playback. Its capabilities decide what is offered: YouTube songs only where their bytes
 *   are readable (`mediaBytes`: FXM Connect, the desktop and Android apps, never the Lite tier),
 *   Internet Archive and Jamendo everywhere.
 * - **The resolver** is `createPolicyDownloadResolver` over the very stream sources, matching
 *   engine and match cache the stream lifecycle uses, with the playback settings and this
 *   browser's `canPlayType`, so a download is the audio playback would choose, at its best
 *   quality, and a file that plays offline here.
 * - **The queue** runs once the tier is known (`startAppDownloads`): a queue that started while
 *   FXM Connect was still waking up would find the Free tier, and fail every YouTube download
 *   it resumed as one that can't be downloaded here.
 *
 * @module
 */

import type { StreamOption, StreamSupport, Track } from '@fxm/core'
import { createPolicyDownloadResolver } from '@fxm/downloads'
import { browserCanPlay, type DownloadEnvironment } from '../../features/downloads/environment'
import type { DownloadActions } from '../../features/search/actions'
import type { Sources } from '../../features/search/sources'
import { useSettingsStore } from '../../features/settings/settings-store'
import type { AppServices } from './app-services'

/** Options for {@link createAppDownloadEnvironment}. */
export interface AppDownloadOptions {
  /** How sure this device is that it plays a stream. Default: the browser's `canPlayType`. */
  readonly canPlay?: (stream: StreamOption) => StreamSupport
}

/** The download environment over the app's services (see the module documentation). */
export function createAppDownloadEnvironment(
  app: Pick<
    AppServices,
    'context' | 'sources' | 'streamSources' | 'matcher' | 'matches' | 'playbackSettings'
  >,
  options: AppDownloadOptions = {},
): DownloadEnvironment {
  const resolver = createPolicyDownloadResolver({
    sources: app.streamSources,
    matcher: app.matcher,
    matches: app.matches,
    settings: () => app.playbackSettings(),
    canPlay: options.canPlay ?? browserCanPlay,
  })
  return {
    context: () => app.context({ priority: 'bulk' }),
    resolver,
    subscribe(listener) {
      // What the platform reaches (the registry follows it), and the catalog mode.
      let capabilities = app.sources.getSnapshot().capabilities
      const stopSources = app.sources.subscribe(() => {
        const next = app.sources.getSnapshot().capabilities
        if (next === capabilities) return
        capabilities = next
        listener()
      })
      const stopMode = useSettingsStore.subscribe((state, previous) => {
        if (state.catalogMode !== previous.catalogMode) listener()
      })
      return () => {
        stopSources()
        stopMode()
      }
    },
  }
}

/**
 * The catalog pages' Download entries (2.4's `DownloadActions`): the downloads' own action,
 * which says what became of the click ("Downloading …", "… can't be downloaded here"). The bulk
 * of its code, the downloads' runtime with Dexie and the manager, loads as soon as the entries
 * are connected (`startAppDownloads`), so the click still counts as the user's when it asks the
 * browser to keep FXM's data.
 */
export const appDownloadActions: DownloadActions = {
  download(tracks: readonly Track[]) {
    void import('../../features/downloads/actions').then(({ downloadTracks }) =>
      downloadTracks(tracks),
    )
  },
}

/** What {@link startAppDownloads} runs: stage 4.1's runtime (`features/downloads/runtime.ts`). */
export interface DownloadQueueRuntime {
  /** Runs the queue in this tab once it holds the downloads' Web Lock; returns how to stop it. */
  startDownloads(): () => void
}

/**
 * Runs the download queue in this tab (stage 4.1's `startDownloads`, which one tab at a time
 * holds) once the tier is known: when the registry no longer says `detecting`, that is, FXM
 * Connect has answered or its grace period ended. Until then a resumed YouTube download would
 * meet the Free tier and fail as one that can't be downloaded here. The runtime's code starts
 * loading at once. Returns a function that stops the queue, or keeps it from starting.
 */
export function startAppDownloads(
  sources: Pick<Sources, 'getSnapshot' | 'subscribe'>,
  load: () => Promise<DownloadQueueRuntime> = () => import('../../features/downloads/runtime'),
): () => void {
  const runtime = load()
  // A failed load is reported once the queue would start (`begin`), not before.
  runtime.catch(() => {})
  let stopped = false
  let stopQueue: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  const begin = () => {
    unsubscribe?.()
    unsubscribe = undefined
    runtime.then(
      ({ startDownloads }) => {
        if (!stopped) stopQueue = startDownloads()
      },
      (error: unknown) => console.error('FXM: could not start the downloads', error),
    )
  }
  if (sources.getSnapshot().detecting === true) {
    unsubscribe = sources.subscribe(() => {
      if (unsubscribe !== undefined && sources.getSnapshot().detecting !== true) begin()
    })
  } else {
    begin()
  }
  return () => {
    stopped = true
    unsubscribe?.()
    unsubscribe = undefined
    stopQueue?.()
  }
}
