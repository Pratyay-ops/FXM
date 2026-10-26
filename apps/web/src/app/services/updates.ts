/**
 * Keeps the app's YouTube config, and where the platform can load code its YouTube resolver
 * module too, current from FXM's static site (stage 1.13): `@fxm/platform`'s updater over the
 * module host's two artifacts (`youtube.ts`), verified against the public keys compiled into the
 * build (`update-keys.json`). The config's kill switches follow the config in use.
 *
 * | Where | What | From |
 * |---|---|---|
 * | A browser | The config only: the web app's content security policy never lets it load code from `blob:`, and it gets new code by redeploy | Its own origin's `/updates/`, with the page's `fetch` (same origin: no CORS, and `connect-src 'self'` allows it) |
 * | The desktop app | The module and the config | `DEFAULT_UPDATE_BASE_URLS` (the site's `/updates/`), through its native HTTP (stage 7.2) |
 * | The Android app | The module and the config | The same, through the `FxmHttp` plugin (stage 6.2), where the app has it |
 *
 * **F-Droid builds** (`BUILD_DISTRIBUTION` of `lib/distribution.ts`, stage R.3) take the module
 * only once the user has opted in, in Settings → Sources (`features/youtube-updates`), as
 * F-Droid's inclusion policy requires for downloaded code; the config is data and always comes.
 * The answer applies at once: turning it on downloads the module, turning it off goes back to the
 * one the app came with and stops a module still downloading, whose code then never runs.
 *
 * A browser on its own origin matters because the app may run from a cached service worker
 * after a deploy: the signed config still reaches it, so a kill switch the owner sets applies
 * without waiting for the app to update. Before the owner publishes the first signed config,
 * the site answers 404 and the app keeps the config it ships with. Nothing here throws: every
 * problem is in the updater's report.
 *
 * @module
 */

import {
  androidHttpIfAvailable,
  browserStorage,
  codeArtifact,
  createDesktopFetch,
  createUpdater,
  DEFAULT_UPDATE_BASE_URLS,
  type Distribution,
  detectEnvironment,
  type Environment,
  indexedDbUpdateStore,
  jsonArtifact,
  type KeyValueStorage,
  memoryStorage,
  type TrustedKey,
  type UpdateArtifact,
  type UpdateFetch,
  type UpdateReport,
  type Updater,
  type UpdateStore,
  updateFetchFromNative,
} from '@fxm/platform'
import type { YouTubeModuleHost } from '@fxm/sources/youtube/module'
import {
  useYouTubeUpdatesStore,
  type YouTubeUpdatesStore,
} from '../../features/youtube-updates/youtube-updates-store'
import { BUILD_DISTRIBUTION } from '../../lib/distribution'

/** Options for {@link startYouTubeUpdates}. Everything but `host` has a default for the app. */
export interface YouTubeUpdatesOptions {
  /** The module host whose artifacts are kept current. */
  readonly host: Pick<YouTubeModuleHost, 'updates'>
  /** Where the app runs. Default: `detectEnvironment()`. */
  readonly environment?: Environment
  /** The page's origin, in a browser. Default: `location.origin`. */
  readonly origin?: string
  /** Fetches the update files. Default: as the table in the module documentation says. */
  readonly fetch?: UpdateFetch
  /** Where the files are. Default: as the table in the module documentation says. */
  readonly baseUrls?: readonly string[]
  /** Whether to keep the module current too. Default: everywhere but in a browser. */
  readonly code?: boolean
  /** Where the last good versions are kept. Default: IndexedDB (`fxm-updates`). */
  readonly store?: UpdateStore
  /** Where the floors are kept. Default: `localStorage`, else memory. */
  readonly state?: KeyValueStorage
  /** The trusted keys. Default: the build's (`update-keys.json`). Tests pass their own. */
  readonly keys?: readonly TrustedKey[]
  /** The build's distribution. Default: {@link BUILD_DISTRIBUTION}. */
  readonly distribution?: Distribution
  /**
   * Whether the module may be downloaded and loaded, read at every restore and check. Default:
   * in F-Droid builds the user's opt-in (`features/youtube-updates`), elsewhere always.
   */
  readonly allowCode?: () => boolean
  /** Cancels the first start (`UpdateCheckOptions.signal` of `@fxm/platform`). */
  readonly signal?: AbortSignal
}

/** The updater at work, and the report of its first restore and check. */
export interface YouTubeUpdates {
  readonly updater: Updater
  /** Resolves with the report once the stored copy is restored and the site was checked. */
  readonly done: Promise<UpdateReport>
}

/** The page's `fetch`, for update files on the app's own origin. */
const pageFetch: UpdateFetch = (url, init) => globalThis.fetch(url, init)

/** The fetch and the folders a platform takes its updates from, or `undefined` for none. */
function sourceFor(
  environment: Environment,
  origin: string | undefined,
): { fetch: UpdateFetch; baseUrls: readonly string[] } | undefined {
  switch (environment) {
    case 'browser': {
      if (origin === undefined || origin === 'null') return undefined
      return { fetch: pageFetch, baseUrls: [`${origin}/updates/`] }
    }
    case 'tauri':
      return {
        fetch: updateFetchFromNative(createDesktopFetch()),
        baseUrls: DEFAULT_UPDATE_BASE_URLS,
      }
    case 'capacitor': {
      const http = androidHttpIfAvailable()
      if (http === undefined) return undefined
      return { fetch: updateFetchFromNative(http), baseUrls: DEFAULT_UPDATE_BASE_URLS }
    }
    default:
      return undefined
  }
}

/** The page's origin, or `undefined` outside a page. */
function pageOrigin(): string | undefined {
  return (globalThis as { location?: { origin?: string } }).location?.origin
}

/**
 * Starts keeping `host`'s config (and, where the platform loads code, its module) current: it
 * restores the last good stored copy, then checks the site once. Returns `undefined` where there
 * is nothing to update from (no page origin, an Android app without its HTTP plugin, Node).
 */
export function startYouTubeUpdates(options: YouTubeUpdatesOptions): YouTubeUpdates | undefined {
  const environment = options.environment ?? detectEnvironment()
  const found = sourceFor(environment, options.origin ?? pageOrigin())
  const fetch = options.fetch ?? found?.fetch
  const baseUrls = options.baseUrls ?? found?.baseUrls
  if (fetch === undefined || baseUrls === undefined) return undefined
  const code = options.code ?? environment !== 'browser'
  const artifacts: UpdateArtifact[] = [
    // Code first, so that a new config is checked by the newest module.
    ...(code ? [codeArtifact(options.host.updates.module) as UpdateArtifact] : []),
    jsonArtifact(options.host.updates.config) as UpdateArtifact,
  ]
  const distribution = options.distribution ?? BUILD_DISTRIBUTION
  // F-Droid builds ask the user first (the setting in features/youtube-updates).
  const allowCode =
    options.allowCode ??
    (distribution === 'fdroid' ? () => useYouTubeUpdatesStore.getState().optedIn : undefined)
  let updater: Updater
  try {
    updater = createUpdater({
      artifacts,
      fetch,
      baseUrls,
      store: options.store ?? indexedDbUpdateStore(),
      state: options.state ?? browserStorage() ?? memoryStorage(),
      distribution,
      ...(allowCode === undefined ? {} : { allowCode }),
      ...(options.keys === undefined ? {} : { keys: options.keys }),
    })
  } catch (error) {
    // A folder that isn't HTTPS (a development server on another machine's address), say.
    console.warn('FXM: signed YouTube updates are off here', error)
    return undefined
  }
  return {
    updater,
    done: updater.start(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

const warnFailedCheck = (error: unknown) => {
  console.warn('FXM: could not check for signed YouTube updates', error)
}

/** A start's failure, unless the start was cancelled on purpose. */
const warnUnlessCancelled = (signal: AbortSignal) => (error: unknown) => {
  if (!signal.aborted) warnFailedCheck(error)
}

/**
 * Applies the F-Droid opt-in as soon as the user changes it: `start()` restores, which goes back
 * to the module the app came with once the user turns the updates off, then checks, which
 * downloads the module once they turn them on.
 *
 * Each change cancels the start that the answer before began (to begin with `running`, the app's
 * first start), so a module still downloading for an answer the user took back stops there. The
 * updater also asks for the opt-in again right before downloaded code loads, so none runs once
 * the user said no. Returns the unsubscribe function, which cancels the start under way too.
 */
export function followYouTubeUpdatesOptIn(
  updater: Pick<Updater, 'start'>,
  store: YouTubeUpdatesStore = useYouTubeUpdatesStore,
  running?: AbortController,
): () => void {
  let current = running
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.optedIn === previous.optedIn) return
    current?.abort(new DOMException('The answer about YouTube updates changed', 'AbortError'))
    const controller = new AbortController()
    current = controller
    updater.start({ signal: controller.signal }).catch(warnUnlessCancelled(controller.signal))
  })
  return () => {
    unsubscribe()
    current?.abort(new DOMException('FXM no longer follows the answer', 'AbortError'))
  }
}

/**
 * The app's default for `AppServicesOptions.updates`: {@link startYouTubeUpdates} on the loaded
 * YouTube's host, in the background. What it finds applies as it arrives.
 */
export function keepYouTubeCurrent(youtube: { readonly host: Pick<YouTubeModuleHost, 'updates'> }) {
  const first = new AbortController()
  const updates = startYouTubeUpdates({ host: youtube.host, signal: first.signal })
  updates?.done.catch(warnUnlessCancelled(first.signal))
  if (updates !== undefined && BUILD_DISTRIBUTION === 'fdroid') {
    followYouTubeUpdatesOptIn(updates.updater, useYouTubeUpdatesStore, first)
  }
}
