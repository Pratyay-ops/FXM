/**
 * YouTube Music and YouTube in the app: the metadata providers of stage 1.3 and the audio source
 * of stage 1.4, as the YouTube module host of stage 1.13 holds them, loaded together on first
 * use, plus the adapter that makes the audio source the playback policy's `ytm` stream source
 * (stage 2.3).
 *
 * - **Lazy.** `@fxm/sources/youtube` and its module host are imported the first time a page or
 *   the player needs them (the providers about 25 KB gzipped), and the session imports
 *   youtubei.js (about 165 KB) on its first InnerTube call, so neither weighs on the app's first
 *   bundle.
 * - **One session.** The providers and the audio source share one session, so the device keeps
 *   one server-issued visitorData, persisted in IndexedDB (`device-store.ts`) so it survives
 *   reloads. The rung health is kept there too. Both stores outlive a switch of module or config.
 * - **Signed updates.** The providers are the host's live ones: each call goes to the module and
 *   config in use at that moment. The app keeps the config current from FXM's site, and in the
 *   desktop and Android apps the module too (`updates.ts`); the config's kill switches are read
 *   from the config in use ({@link YouTube.killSwitches}).
 * - **The request budget.** Every InnerTube call already draws a slot from the platform's
 *   transport (stage 1.2), so the audio source takes none itself. It tells the budget about the
 *   bot checks it tells apart from age gates; the platform is created with
 *   `reportLoginRequired: false`, so they count once (see {@link platformStreamBudget}).
 *
 * @module
 */

import type { LadderRung, RecoveryReason } from '@fxm/core'
import type { StreamSource } from '@fxm/player'
import type { PlaybackFailureReason, StreamBudget, YouTubeKillSwitches } from '@fxm/sources/youtube'
import type {
  YouTubeModuleAudio,
  YouTubeModuleHost,
  YouTubeModuleMusic,
  YouTubeModuleVideo,
} from '@fxm/sources/youtube/module'
import { type DeviceStore, rungHealthStore, visitorDataStore } from './device-store'
import { createLoader, type Loader } from './lazy-provider'

/** The module `@fxm/sources/youtube`: the providers' helpers and the bundled configs. */
export type YouTubeModule = typeof import('@fxm/sources/youtube')

/** The module `@fxm/sources/youtube/module`: the module host of stage 1.13. */
export type YouTubeHostModule = typeof import('@fxm/sources/youtube/module')

/** Everything YouTube, on one session. */
export interface YouTube {
  /** The module, for its helpers (`isYouTubeStreamOption`, `unavailableStateOf`, …). */
  readonly module: YouTubeModule
  /**
   * The module and config in use, and the two artifacts that `@fxm/platform`'s updater keeps
   * current (`host.updates`).
   */
  readonly host: YouTubeModuleHost
  /** YouTube Music (`ytm`), live: each call goes to the module and config in use. */
  readonly music: YouTubeModuleMusic
  /** Plain YouTube (`yt`), for Music + Video mode, live like `music`. */
  readonly video: YouTubeModuleVideo
  /** The stream ladder (stage 1.4), live like `music`. */
  readonly audio: YouTubeModuleAudio
  /** The kill switches of the config in use, the Lite tier's among them. */
  killSwitches(): YouTubeKillSwitches
  /** The ID of the ladder's last-resort rung (itag 18) in the config in use, if it has one. */
  fallbackRung(): string | undefined
  /** Calls `listener` whenever the module or the config in use changes. Returns a stop. */
  subscribe(listener: () => void): () => void
}

/** Options for {@link createYouTubeLoader}. */
export interface YouTubeLoaderOptions {
  /** Where the visitorData and the rung health are kept. */
  readonly store: DeviceStore
  /** The request budget the audio source reports bot checks to. */
  readonly budget: StreamBudget
  /** Imports `@fxm/sources/youtube`. Default: `import()`; tests may pass another. */
  readonly importModule?: () => Promise<YouTubeModule>
  /** Imports `@fxm/sources/youtube/module`. Default: `import()`; tests may pass another. */
  readonly importHost?: () => Promise<YouTubeHostModule>
  /**
   * Called once the modules loaded, e.g. to apply the config's kill switches and to start
   * keeping the config current.
   */
  readonly onLoad?: (youtube: YouTube) => void
}

/** What a config in use says, read once per config document. */
interface ConfigFacts {
  readonly document: unknown
  readonly killSwitches: YouTubeKillSwitches
  readonly fallbackRung: string | undefined
}

/**
 * The kill switches and the last-resort rung of a config document, with the bundled config's
 * as the fallback for a document this build's parsers can't read: the module in use read it,
 * and a config published under schema 1 stays readable by every module of the contract.
 */
function factsOf(module: YouTubeModule, document: unknown): ConfigFacts {
  const bundled = {
    killSwitches: module.BUNDLED_YOUTUBE_CONFIG.killSwitches,
    fallbackRung: module.BUNDLED_STREAM_CONFIG.rungs.find((rung) => rung.fallback)?.id,
  }
  let killSwitches = bundled.killSwitches
  let fallbackRung = bundled.fallbackRung
  try {
    killSwitches = module.parseYouTubeConfig(document).killSwitches
  } catch {
    // Kept: the bundled config's switches.
  }
  try {
    fallbackRung = module.parseStreamConfig(document).rungs.find((rung) => rung.fallback)?.id
  } catch {
    // Kept: the bundled config's rung.
  }
  return { document, killSwitches, fallbackRung }
}

/** Creates the loader of {@link YouTube}: nothing is imported until the first `load()`. */
export function createYouTubeLoader(options: YouTubeLoaderOptions): Loader<YouTube> {
  const importModule = options.importModule ?? (() => import('@fxm/sources/youtube'))
  const importHost = options.importHost ?? (() => import('@fxm/sources/youtube/module'))
  const importBoth = async () => {
    const [module, hostModule] = await Promise.all([importModule(), importHost()])
    return { module, hostModule }
  }
  return createLoader('YouTube Music', importBoth, ({ module, hostModule }) => {
    const host = hostModule.createYouTubeModuleHost({
      visitorDataStore: visitorDataStore(options.store),
      healthStore: rungHealthStore(options.store),
      budget: options.budget,
    })
    let facts = factsOf(module, host.current().config)
    const current = (): ConfigFacts => {
      const { config } = host.current()
      if (config !== facts.document) facts = factsOf(module, config)
      return facts
    }
    const youtube: YouTube = {
      module,
      host,
      music: host.music,
      video: host.video,
      audio: host.audio,
      killSwitches: () => current().killSwitches,
      fallbackRung: () => current().fallbackRung,
      subscribe: (listener) => host.subscribe(() => listener()),
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
      return option.rung === loaded.fallbackRung() ? 'fallback' : 'top'
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

/**
 * Keeps `youtube`'s config (and, where the platform loads code, its module) current from FXM's
 * site (stage 1.13): `keepYouTubeCurrent` of `updates.ts`, loaded only now that YouTube's code
 * has. The updater and its signature checks (`@noble/curves`) stay out of the chunks every page
 * loads, the Free tier's and the embed's first one included.
 */
export function keepYouTubeCurrentLater(youtube: Pick<YouTube, 'host'>): void {
  import('./updates')
    .then(({ keepYouTubeCurrent }) => keepYouTubeCurrent(youtube))
    .catch((error: unknown) => {
      console.warn('FXM: could not check for signed YouTube updates', error)
    })
}
