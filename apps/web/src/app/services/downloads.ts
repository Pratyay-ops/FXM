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
 *
 * @module
 */

import type { StreamOption, StreamSupport, Track } from '@fxm/core'
import { createPolicyDownloadResolver } from '@fxm/downloads'
import { browserCanPlay, type DownloadEnvironment } from '../../features/downloads/environment'
import type { DownloadActions } from '../../features/search/actions'
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
 * which says what became of the click ("Downloading …", "… can't be downloaded here"). Its code
 * is loaded beside the first render already (`main.tsx` starts the download queue), so the click
 * still counts as the user's when it asks the browser to keep FXM's data.
 */
export const appDownloadActions: DownloadActions = {
  download(tracks: readonly Track[]) {
    void import('../../features/downloads/actions').then(({ downloadTracks }) =>
      downloadTracks(tracks),
    )
  },
}
