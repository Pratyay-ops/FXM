/**
 * YouTube Music and YouTube in the app: the session and metadata providers of stage 1.3 and the
 * audio source of stage 1.4, loaded together on first use, plus the adapter that makes the audio
 * source the playback policy's `ytm` stream source (stage 2.3).
 *
 * - **Lazy.** `@fxm/sources/youtube` is imported the first time a page or the player needs it
 *   (its providers about 25 KB gzipped), and the session imports youtubei.js (about 165 KB) on
 *   its first InnerTube call, so neither weighs on the app's first bundle.
 * - **One session.** The providers and the audio source share one session, so the device keeps
 *   one server-issued visitorData, persisted in IndexedDB (`device-store.ts`) so it survives
 *   reloads. The rung health is kept there too.
 * - **The request budget.** Every InnerTube call already draws a slot from the platform's
 *   transport (stage 1.2), so the audio source takes none itself. It tells the budget about the
 *   bot checks it tells apart from age gates; the platform is created with
 *   `reportLoginRequired: false`, so they count once (see {@link platformStreamBudget}).
 *
 * @module
 */

import type { LadderRung, RecoveryReason } from '@fxm/core'
import type { StreamSource } from '@fxm/player'
import type {
  PlaybackFailureReason,
  StreamBudget,
  YouTubeAudioSource,
  YouTubeMusicProvider,
  YouTubeSession,
  YouTubeVideoProvider,
} from '@fxm/sources/youtube'
import { type DeviceStore, rungHealthStore, visitorDataStore } from './device-store'
import { createLoader, type Loader } from './lazy-provider'

/** The module `@fxm/sources/youtube`. */
export type YouTubeModule = typeof import('@fxm/sources/youtube')

/** Everything YouTube, on one session. */
export interface YouTube {
  /** The module, for its helpers (`isYouTubeStreamOption`, `unavailableStateOf`, …). */
  readonly module: YouTubeModule
  /** The device's session: one visitorData for every call. */
  readonly session: YouTubeSession
  /** YouTube Music (`ytm`). */
  readonly music: YouTubeMusicProvider
  /** Plain YouTube (`yt`), for Music + Video mode. */
  readonly video: YouTubeVideoProvider
  /** The stream ladder (stage 1.4). */
  readonly audio: YouTubeAudioSource
  /** The ID of the ladder's last-resort rung (itag 18), if the config has one. */
  readonly fallbackRung: string | undefined
}

/** Options for {@link createYouTubeLoader}. */
export interface YouTubeLoaderOptions {
  /** Where the visitorData and the rung health are kept. */
  readonly store: DeviceStore
  /** The request budget the audio source reports bot checks to. */
  readonly budget: StreamBudget
  /** Imports the module. Default: `import('@fxm/sources/youtube')`; tests may pass another. */
  readonly importModule?: () => Promise<YouTubeModule>
  /** Called once the module loaded, e.g. to apply its config's kill switches. */
  readonly onLoad?: (youtube: YouTube) => void
}

/** Creates the loader of {@link YouTube}: nothing is imported until the first `load()`. */
export function createYouTubeLoader(options: YouTubeLoaderOptions): Loader<YouTube> {
  const importModule = options.importModule ?? (() => import('@fxm/sources/youtube'))
  return createLoader('YouTube Music', importModule, (module) => {
    const { session, music, video } = module.createYouTubeProviders({
      visitorDataStore: visitorDataStore(options.store),
    })
    const audio = module.createYouTubeAudioSource({
      session,
      budget: options.budget,
      healthStore: rungHealthStore(options.store),
    })
    const youtube: YouTube = {
      module,
      session,
      music,
      video,
      audio,
      fallbackRung: module.BUNDLED_STREAM_CONFIG.rungs.find((rung) => rung.fallback)?.id,
    }
    options.onLoad?.(youtube)
    return youtube
  })
}

/** What {@link platformStreamBudget} reports bot checks to: `FxmPlatform.budget`. */
export interface BotCheckSink {
  reportBotCheck(cause: 'login-required' | 'rate-limited'): void
}

/**
 * The stream ladder's view of the platform's request budget (stage 1.2):
 *
 * - `acquire` takes nothing: the platform's transport already draws one slot for every InnerTube
 *   call the ladder sends, at the priority of the `ctx.fetch` it was given;
 * - `reportBotCheck` passes on a `LOGIN_REQUIRED` bot check, which only the ladder tells apart
 *   from an age gate and from a bot check FXM caused itself (a call sent before YouTube issued a
 *   visitorData). The transport reports HTTP 429 itself, so the ladder's own report of one is
 *   dropped, and it counts once.
 */
export function platformStreamBudget(sink: () => BotCheckSink | undefined): StreamBudget {
  return {
    acquire: () => Promise.resolve(),
    reportBotCheck(cause) {
      if (cause === 'login-required') sink()?.reportBotCheck(cause)
    },
  }
}

/**
 * The ladder's words for why a stream failed, from the playback policy's recovery plan. Only
 * `probe-failed`, `fallback-failed` and `forbidden-again` count against a rung; `unsupported`
 * (the player refused a format whose URL may work) says nothing about it.
 */
function failureReason(reason: RecoveryReason): PlaybackFailureReason | undefined {
  return reason === 'unsupported' ? undefined : reason
}

/**
 * The playback policy's stream source for `ytm` (stage 2.3), over the YouTube ladder (stage
 * 1.4), as the lifecycle's README describes it:
 *
 * - `resolve` with `rung: 'top'` runs the whole ladder; `rung: 'fallback'` only its last-resort
 *   rung (itag 18), after the top rung's URLs failed their probe in the player;
 * - `rungOf` names an option of the last-resort rung `fallback`, any other `top`;
 * - `reportFailure` tells the ladder which rung failed, so its health cools it down;
 * - `stateOf` reads the labelled state of an unplayable video (`age-restricted`, …), and every
 *   such error already carries the playability verdict that Smart Replace reads;
 * - `checkStatus` reads a URL's status where bytes are readable (an IP change shows as 403).
 */
export function youtubeStreamSource(youtube: Loader<YouTube>): StreamSource {
  return {
    id: 'ytm',
    // Asked only after a resolution, by which time the module has loaded.
    get hasFallback() {
      return youtube.current?.audio.hasFallback ?? true
    },
    async resolve(candidate, { ctx, prefs, rung, priority, signal }) {
      const { audio } = await youtube.load()
      return audio.resolve(candidate, { ...ctx, signal }, prefs, {
        rungs: rung === 'fallback' ? 'fallback' : 'all',
        priority,
      })
    },
    rungOf(option): LadderRung | undefined {
      const loaded = youtube.current
      if (loaded === undefined || !loaded.module.isYouTubeStreamOption(option)) return undefined
      return option.rung === loaded.fallbackRung ? 'fallback' : 'top'
    },
    reportFailure(stream, report, { ctx }) {
      const reason = failureReason(report.recovery.reason)
      if (reason !== undefined) youtube.current?.audio.reportPlaybackFailure(stream, ctx, reason)
    },
    stateOf: (error) => youtube.current?.module.unavailableStateOf(error),
    async checkStatus(stream, { ctx, signal }) {
      const { audio } = await youtube.load()
      return audio.checkStatus(stream, { ...ctx, signal })
    },
  }
}
