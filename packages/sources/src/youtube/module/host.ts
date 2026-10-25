/**
 * The app's side of the YouTube module: which module and which config are in use, the providers
 * built from them, and the two update artifacts (`updates.module`, `updates.config`) that
 * `@fxm/platform`'s updater keeps current on desktop and Android.
 *
 * The providers it hands out are live: every call goes to the module and config in use at that
 * moment, so a module update that fixes a parser takes effect on the next call, without an app
 * update or a restart. The web app uses the host with its own module only.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import type { YouTubeMusicProvider } from '../music'
import type { StreamBudget } from '../stream/budget'
import type { RungHealthStore } from '../stream/health'
import type { YouTubeAudioSource } from '../stream/resolver'
import type { YouTubeVideoProvider } from '../video'
import type { VisitorDataStore } from '../visitor'
import { isYouTubeModule, type YouTubeModule, type YouTubeModuleProviders } from './api'
import { youtubeModule } from './entry'
import {
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_MODULE_API,
  YOUTUBE_MODULE_FILE,
  YOUTUBE_MODULE_KIND,
} from './version'

/** Where the module or the config in use came from. */
export type YouTubeModuleOrigin = 'bundled' | 'stored' | 'fetched'

/** Where the config in use came from: the app, the module in use, or an update. */
export type YouTubeConfigOrigin = 'bundled' | 'module' | 'stored' | 'fetched'

/** What the host uses right now. */
export interface YouTubeModuleState {
  /** The module in use. */
  readonly module: YouTubeModule
  /** Where it came from. */
  readonly moduleOrigin: YouTubeModuleOrigin
  /** The config document in use. */
  readonly config: unknown
  /** Its revision. */
  readonly configRevision: number
  /** Where it came from. */
  readonly configOrigin: YouTubeConfigOrigin
}

/**
 * The parts of a signed statement the host reads, as `@fxm/platform`'s `UpdateStatement` has
 * them.
 */
export interface SignedVersion {
  /** The signed version. */
  readonly version: number
}

/** What the updater tells the host when it switches to a verified version. */
export interface UpdateActivation {
  /** `stored` (from an earlier run) or `fetched` (just downloaded). */
  readonly origin: 'stored' | 'fetched'
  /** The version. */
  readonly version: number
}

/** The module as an update artifact: `codeArtifact(host.updates.module)` in `@fxm/platform`. */
export interface YouTubeModuleUpdate {
  readonly kind: string
  readonly file: string
  readonly api: number
  readonly bundledVersion: number
  accept(exports: Readonly<Record<string, unknown>>, statement: SignedVersion): YouTubeModule
  activate(value: YouTubeModule, info: UpdateActivation): void
  useBundled(): void
}

/** A verified config document and its revision. */
export interface YouTubeConfigDocument {
  /** The document. */
  readonly document: unknown
  /** Its revision, the signed version. */
  readonly revision: number
}

/** The config as an update artifact: `jsonArtifact(host.updates.config)` in `@fxm/platform`. */
export interface YouTubeConfigUpdate {
  readonly kind: string
  readonly file: string
  readonly bundledVersion: number
  accept(json: unknown, statement: SignedVersion): YouTubeConfigDocument
  activate(value: YouTubeConfigDocument, info: UpdateActivation): void
  useBundled(): void
}

/** Options for {@link createYouTubeModuleHost}. */
export interface YouTubeModuleHostOptions {
  /** The module the app ships with. Default: this build's own `youtubeModule`. */
  readonly bundled?: YouTubeModule
  /** Where the visitorData is kept, shared by every module instance. */
  readonly visitorDataStore?: VisitorDataStore
  /** Where the stream ladder's health is kept, shared by every module instance. */
  readonly healthStore?: RungHealthStore
  /** The request budget for the stream calls (see `YouTubeModuleOptions.budget`). */
  readonly budget?: StreamBudget
  /** How long one request may take, in milliseconds. */
  readonly timeoutMs?: number
}

/** The app's YouTube: the module and config in use, and providers that follow them. */
export interface YouTubeModuleHost {
  /** What is in use now. */
  current(): YouTubeModuleState
  /** The provider instances in use now. Use the live providers below to follow updates. */
  providers(): YouTubeModuleProviders
  /** YouTube Music (`ytm`). Each call goes to the module and config in use at that moment. */
  readonly music: YouTubeMusicProvider
  /** Plain YouTube (`yt`), live like `music`. */
  readonly video: YouTubeVideoProvider
  /** The audio source (the stream ladder), live like `music`. */
  readonly audio: YouTubeAudioSource
  /** Calls `listener` whenever the module or the config in use changes. Returns an unsubscribe. */
  subscribe(listener: (state: YouTubeModuleState) => void): () => void
  /** The two artifacts for `@fxm/platform`'s updater: put the module first. */
  readonly updates: {
    readonly module: YouTubeModuleUpdate
    readonly config: YouTubeConfigUpdate
  }
}

interface ConfigCandidate {
  readonly document: unknown
  readonly origin: YouTubeConfigOrigin
}

/**
 * A view of the object `target` returns, read again on every access, so that callers can keep
 * one provider object while the module underneath changes. It can't be written to.
 */
function live<T extends object>(target: () => T): T {
  return new Proxy({} as T, {
    get(_, property) {
      const current = target()
      const value: unknown = Reflect.get(current, property, current)
      return typeof value === 'function' ? value.bind(current) : value
    },
    has: (_, property) => Reflect.has(target(), property),
    ownKeys: () => Reflect.ownKeys(target()),
    getOwnPropertyDescriptor(_, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target(), property)
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
}

/**
 * Creates the app's YouTube host, starting with the module the app ships with and its config.
 *
 * ```ts
 * // Desktop and Android (with @fxm/platform):
 * const youtube = createYouTubeModuleHost({ visitorDataStore, healthStore })
 * const updater = createUpdater({
 *   artifacts: [codeArtifact(youtube.updates.module), jsonArtifact(youtube.updates.config)],
 *   fetch: updateFetchFromNative(nativeHttp),
 *   store: indexedDbUpdateStore(),
 *   state: localStorage,
 * })
 * await updater.start()
 * const { tracks } = await youtube.music.search('Creep', { types: ['track'] }, ctx)
 * ```
 */
export function createYouTubeModuleHost(options: YouTubeModuleHostOptions = {}): YouTubeModuleHost {
  const bundled = options.bundled ?? youtubeModule
  const bundledRevision = bundled.checkConfig(bundled.config)
  let module = bundled
  let moduleOrigin: YouTubeModuleOrigin = 'bundled'
  let updated: ConfigCandidate | undefined
  let state = choose()
  let instance: YouTubeModuleProviders | undefined
  const listeners = new Set<(state: YouTubeModuleState) => void>()

  /** The newest config the module in use accepts: an update, its own, or the app's. */
  function choose(): YouTubeModuleState {
    const candidates: ConfigCandidate[] = [
      ...(updated === undefined ? [] : [updated]),
      { document: module.config, origin: 'module' },
      { document: bundled.config, origin: 'bundled' },
    ]
    let best: { candidate: ConfigCandidate; revision: number } | undefined
    for (const candidate of candidates) {
      let revision: number
      try {
        revision = module.checkConfig(candidate.document)
      } catch {
        continue
      }
      if (best === undefined || revision > best.revision) best = { candidate, revision }
    }
    if (best === undefined) throw new FxmError('Parse', 'The YouTube module accepts no config')
    const configOrigin =
      best.candidate.origin === 'module' && module === bundled ? 'bundled' : best.candidate.origin
    return {
      module,
      moduleOrigin,
      config: best.candidate.document,
      configRevision: best.revision,
      configOrigin,
    }
  }

  function update(): void {
    const next = choose()
    if (next.module === state.module && next.config === state.config) {
      state = next
      return
    }
    state = next
    instance = undefined
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  function setModule(next: YouTubeModule, origin: YouTubeModuleOrigin): void {
    module = next
    moduleOrigin = origin
    update()
  }

  function providers(): YouTubeModuleProviders {
    if (instance !== undefined) return instance
    try {
      instance = state.module.create({
        config: state.config,
        ...(options.visitorDataStore === undefined
          ? {}
          : { visitorDataStore: options.visitorDataStore }),
        ...(options.healthStore === undefined ? {} : { healthStore: options.healthStore }),
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
    } catch (error) {
      // A downloaded module that can't even start: back to the one the app ships with.
      if (module === bundled) throw error
      setModule(bundled, 'bundled')
      return providers()
    }
    return instance
  }

  const moduleUpdate: YouTubeModuleUpdate = {
    kind: YOUTUBE_MODULE_KIND,
    file: YOUTUBE_MODULE_FILE,
    api: YOUTUBE_MODULE_API,
    bundledVersion: bundled.version,
    accept(exports, statement) {
      const candidate = exports.youtubeModule
      if (!isYouTubeModule(candidate)) {
        throw new FxmError(
          'Parse',
          `The module is not a YouTube module of contract ${YOUTUBE_MODULE_API}`,
        )
      }
      if (candidate.version !== statement.version) {
        throw new FxmError(
          'Parse',
          `The module says it is version ${candidate.version}, but its signature says ${statement.version}`,
        )
      }
      // It must read its own config and start, which makes no request.
      candidate.create({ config: candidate.config })
      return candidate
    },
    activate: (value, info) => setModule(value, info.origin),
    useBundled: () => setModule(bundled, 'bundled'),
  }

  const configUpdate: YouTubeConfigUpdate = {
    kind: YOUTUBE_CONFIG_KIND,
    file: YOUTUBE_CONFIG_FILE,
    bundledVersion: bundledRevision,
    accept(json, statement) {
      // Only the binding to the signature is checked here. Whether a module can read it is
      // checked whenever a module is chosen: a config published for a newer module waits for it.
      const revision = (json as { revision?: unknown } | null)?.revision
      if (typeof json !== 'object' || json === null || revision !== statement.version) {
        throw new FxmError(
          'Parse',
          `The config says it is revision ${String(revision)}, but its signature says ${statement.version}`,
        )
      }
      return { document: json, revision }
    },
    activate(value, info) {
      updated = { document: value.document, origin: info.origin }
      update()
    },
    useBundled() {
      updated = undefined
      update()
    },
  }

  return {
    current: () => state,
    providers,
    music: live(() => providers().music),
    video: live(() => providers().video),
    audio: live(() => providers().audio),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    updates: { module: moduleUpdate, config: configUpdate },
  }
}
