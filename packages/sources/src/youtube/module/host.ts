/**
 * The app's side of the YouTube module: which module and which config are in use, the providers
 * built from them, and the two update artifacts (`updates.module`, `updates.config`) that
 * `@fxm/platform`'s updater keeps current on desktop and Android.
 *
 * The providers it hands out are live: every call goes to the module and config in use at that
 * moment, so a module update that fixes a parser takes effect on the next call, without an app
 * update or a restart. The web app uses the host with its own module only.
 *
 * A few types mirror `@fxm/platform`'s under the same names (`UpdateOrigin`, `ActivationInfo`,
 * `VersionInUse`), because this package doesn't depend on the platform; a type test there keeps
 * them identical.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import type { StreamBudget } from '../stream/budget'
import type { RungHealthStore } from '../stream/health'
import type { VisitorDataStore } from '../visitor'
import {
  isYouTubeModule,
  type YouTubeModule,
  type YouTubeModuleAudio,
  type YouTubeModuleMusic,
  type YouTubeModuleProviders,
  type YouTubeModuleVideo,
} from './api'
import { youtubeModule } from './entry'
import {
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_CONFIG_SCHEMA,
  YOUTUBE_MODULE_API,
  YOUTUBE_MODULE_FILE,
  YOUTUBE_MODULE_KIND,
} from './version'

/** Where a module or config came from: the app, or an update (`@fxm/platform`'s name). */
export type UpdateOrigin = 'bundled' | 'stored' | 'fetched'

/** Where the config in use came from: the app, the module in use, or an update. */
export type YouTubeConfigOrigin = 'bundled' | 'module' | 'stored' | 'fetched'

/** What the host uses right now. */
export interface YouTubeModuleState {
  /** The module in use. */
  readonly module: YouTubeModule
  /** Where it came from. */
  readonly moduleOrigin: UpdateOrigin
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
export interface ActivationInfo {
  /** `stored`: kept from an earlier run; `fetched`: just downloaded. */
  readonly origin: Exclude<UpdateOrigin, 'bundled'>
  /** The version. */
  readonly version: number
}

/** The version of an artifact in use, and where it came from. */
export interface VersionInUse {
  /** The version. */
  readonly version: number
  /** Where it came from. */
  readonly origin: UpdateOrigin
}

/** Hears about a version that failed at first use, after the host went back to another one. */
export type FailureListener = (version: number, reason: string) => void

/** The module as an update artifact: `codeArtifact(host.updates.module)` in `@fxm/platform`. */
export interface YouTubeModuleArtifactSpec {
  readonly kind: string
  readonly file: string
  readonly api: number
  readonly bundledVersion: number
  accept(exports: Readonly<Record<string, unknown>>, statement: SignedVersion): YouTubeModule
  activate(value: YouTubeModule, info: ActivationInfo): void
  useBundled(): void
  inUse(): VersionInUse
  watch(failed: FailureListener): void
}

/** A verified config document and its revision. */
export interface YouTubeConfigDocument {
  /** The document. */
  readonly document: unknown
  /** Its revision, the signed version. */
  readonly revision: number
}

/** The config as an update artifact: `jsonArtifact(host.updates.config)` in `@fxm/platform`. */
export interface YouTubeConfigArtifactSpec {
  readonly kind: string
  readonly file: string
  readonly api: number
  readonly bundledVersion: number
  accept(json: unknown, statement: SignedVersion): YouTubeConfigDocument
  activate(value: YouTubeConfigDocument, info: ActivationInfo): void
  useBundled(): void
  inUse(): VersionInUse
  watch(failed: FailureListener): void
}

/** Options for {@link createYouTubeModuleHost}. */
export interface YouTubeModuleHostOptions {
  /** The module the app ships with. Default: this build's own `youtubeModule`. */
  readonly bundled?: YouTubeModule
  /**
   * Where the visitorData is kept, shared by every module instance. Desktop and Android must
   * pass it, and `healthStore`: every switch of module or config creates new provider
   * instances, and without the stores each one starts a new YouTube session (a new
   * `sw.js_data` request) and forgets the ladder's health.
   */
  readonly visitorDataStore?: VisitorDataStore
  /** Where the stream ladder's health is kept, shared by every module instance. */
  readonly healthStore?: RungHealthStore
  /** The request budget for the stream calls (see `YouTubeModuleOptions.budget`). */
  readonly budget?: StreamBudget
  /** How long one request may take, in milliseconds. */
  readonly timeoutMs?: number
}

/**
 * The app's YouTube: the module and config in use, and providers that follow them.
 *
 * Use `music`, `video` and `audio` as they are, or take their methods (`const { resolve } =
 * youtube.audio`): each call goes to the module in use at that moment. Values read from them,
 * such as a flag, are read at that moment too, so read them through the live object each time.
 */
export interface YouTubeModuleHost {
  /** What is in use now. */
  current(): YouTubeModuleState
  /** The provider instances in use now. Use the live providers below to follow updates. */
  providers(): YouTubeModuleProviders
  /** YouTube Music (`ytm`). Each call goes to the module and config in use at that moment. */
  readonly music: YouTubeModuleMusic
  /** Plain YouTube (`yt`), live like `music`. */
  readonly video: YouTubeModuleVideo
  /** The audio source (the stream ladder), live like `music`. */
  readonly audio: YouTubeModuleAudio
  /** Calls `listener` whenever the module or the config in use changes. Returns an unsubscribe. */
  subscribe(listener: (state: YouTubeModuleState) => void): () => void
  /** The two artifacts for `@fxm/platform`'s updater: put the module first. */
  readonly updates: {
    readonly module: YouTubeModuleArtifactSpec
    readonly config: YouTubeConfigArtifactSpec
  }
}

/** The module in use, with its version as signed. */
interface ModuleInUse {
  readonly module: YouTubeModule
  readonly origin: UpdateOrigin
  readonly version: number
}

/** A config update in use, or waiting for a module that can read it. */
interface ConfigInUse {
  readonly document: unknown
  readonly revision: number
  readonly origin: 'stored' | 'fetched'
}

interface ConfigCandidate {
  readonly document: unknown
  readonly origin: YouTubeConfigOrigin
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A view of the object `target` returns, read again on every access, so that callers can keep
 * one provider object while the module underneath changes. Its methods are wrappers, one per
 * name, that call the module in use when they are called, so a method taken from it follows
 * updates too. It can't be written to.
 */
function live<T extends object>(target: () => T): T {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>()

  function method(property: PropertyKey): (...args: unknown[]) => unknown {
    let wrapper = methods.get(property)
    if (wrapper === undefined) {
      wrapper = (...args: unknown[]) => {
        const current = target()
        const value: unknown = Reflect.get(current, property, current)
        if (typeof value !== 'function') {
          throw new FxmError('Unsupported', `The YouTube module in use has no ${String(property)}`)
        }
        return Reflect.apply(value, current, args)
      }
      methods.set(property, wrapper)
    }
    return wrapper
  }

  return new Proxy({} as T, {
    get(_, property) {
      const current = target()
      const value: unknown = Reflect.get(current, property, current)
      return typeof value === 'function' ? method(property) : value
    },
    has: (_, property) => Reflect.has(target(), property),
    ownKeys: () => Reflect.ownKeys(target()),
    getOwnPropertyDescriptor(_, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target(), property)
      if (descriptor === undefined) return undefined
      const value: unknown = descriptor.value
      return typeof value === 'function'
        ? { ...descriptor, value: method(property), configurable: true }
        : { ...descriptor, configurable: true }
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
  const bundledInUse: ModuleInUse = { module: bundled, origin: 'bundled', version: bundled.version }
  let active = bundledInUse
  let configUpdate: ConfigInUse | undefined
  let state = stateFor(active, configUpdate)
  let instance: YouTubeModuleProviders | undefined
  const listeners = new Set<(state: YouTubeModuleState) => void>()
  const moduleWatchers = new Set<FailureListener>()
  const configWatchers = new Set<FailureListener>()

  /** The state with `candidate` in use: the newest config it reads. Changes nothing. */
  function stateFor(candidate: ModuleInUse, update: ConfigInUse | undefined): YouTubeModuleState {
    const candidates: ConfigCandidate[] = [
      ...(update === undefined ? [] : [update]),
      { document: candidate.module.config, origin: 'module' },
      { document: bundled.config, origin: 'bundled' },
    ]
    let best: { candidate: ConfigCandidate; revision: number } | undefined
    for (const config of candidates) {
      let revision: number
      try {
        revision = candidate.module.checkConfig(config.document)
      } catch {
        continue
      }
      if (best === undefined || revision > best.revision) best = { candidate: config, revision }
    }
    if (best === undefined) throw new FxmError('Parse', 'The YouTube module accepts no config')
    const configOrigin =
      best.candidate.origin === 'module' && candidate.module === bundled
        ? 'bundled'
        : best.candidate.origin
    return {
      module: candidate.module,
      moduleOrigin: candidate.origin,
      config: best.candidate.document,
      configRevision: best.revision,
      configOrigin,
    }
  }

  /** Switches module and config update together, or, when no config fits, not at all. */
  function switchTo(nextModule: ModuleInUse, nextUpdate: ConfigInUse | undefined): void {
    const next = stateFor(nextModule, nextUpdate)
    active = nextModule
    configUpdate = nextUpdate
    const changed = next.module !== state.module || next.config !== state.config
    state = next
    if (!changed) return
    instance = undefined
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  function tell(watchers: ReadonlySet<FailureListener>, version: number, reason: string): void {
    for (const watcher of watchers) {
      try {
        watcher(version, reason)
      } catch {
        // A watcher's failure is its own.
      }
    }
  }

  function providers(): YouTubeModuleProviders {
    for (;;) {
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
        return instance
      } catch (error) {
        // A downloaded config or module that doesn't start: back to the app's own, one at a
        // time, and the updater hears which version failed so that it never restores it.
        const failed = configUpdate
        if (failed !== undefined && state.config === failed.document) {
          switchTo(active, undefined)
          tell(configWatchers, failed.revision, messageOf(error))
        } else if (active.origin !== 'bundled') {
          const failedModule = active
          switchTo(bundledInUse, configUpdate)
          tell(moduleWatchers, failedModule.version, messageOf(error))
        } else {
          throw error
        }
      }
    }
  }

  const moduleUpdate: YouTubeModuleArtifactSpec = {
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
      // It must read its own config and start, which makes no request. Whatever it throws is
      // its own fault, so it is remembered as bad.
      try {
        const own = (candidate.config as { revision?: unknown } | null)?.revision
        const revision = candidate.checkConfig(candidate.config)
        if (revision !== own) {
          throw new Error(`it reads its own config as revision ${revision}, not ${String(own)}`)
        }
        candidate.create({ config: candidate.config })
      } catch (cause) {
        throw new FxmError(
          'Parse',
          `Version ${statement.version} of the YouTube module does not start: ${messageOf(cause)}`,
          { cause },
        )
      }
      return candidate
    },
    activate(value, info) {
      switchTo({ module: value, origin: info.origin, version: info.version }, configUpdate)
    },
    useBundled() {
      switchTo(bundledInUse, configUpdate)
    },
    inUse: () => ({ version: active.version, origin: active.origin }),
    watch(failed) {
      moduleWatchers.add(failed)
    },
  }

  const configUpdateSpec: YouTubeConfigArtifactSpec = {
    kind: YOUTUBE_CONFIG_KIND,
    file: YOUTUBE_CONFIG_FILE,
    api: YOUTUBE_CONFIG_SCHEMA,
    bundledVersion: bundledRevision,
    accept(json, statement) {
      const revision = (json as { revision?: unknown } | null)?.revision
      if (
        typeof json !== 'object' ||
        json === null ||
        Array.isArray(json) ||
        revision !== statement.version
      ) {
        throw new FxmError(
          'Parse',
          `The config says it is revision ${String(revision)}, but its signature says ${statement.version}`,
        )
      }
      // The module in use must read it. One it can't read isn't bad (another module may), so
      // the updater keeps what it has without remembering this revision.
      const reader = active.module
      let checked: number
      try {
        checked = reader.checkConfig(json)
      } catch (cause) {
        throw new FxmError(
          'Unsupported',
          `Version ${active.version} of the YouTube module can't read config revision ${revision}: ${messageOf(cause)}`,
          { cause },
        )
      }
      if (checked !== revision) {
        throw new FxmError('Parse', `The config reads as revision ${checked}, not ${revision}`)
      }
      // And start with it, which makes no request.
      try {
        reader.create({ config: json })
      } catch (cause) {
        throw new FxmError(
          'Parse',
          `Config revision ${revision} does not start the YouTube module: ${messageOf(cause)}`,
          { cause },
        )
      }
      return { document: json, revision }
    },
    activate(value, info) {
      switchTo(active, { document: value.document, revision: value.revision, origin: info.origin })
    },
    useBundled() {
      switchTo(active, undefined)
    },
    inUse() {
      const origin = state.configOrigin === 'module' ? active.origin : state.configOrigin
      return { version: state.configRevision, origin }
    },
    watch(failed) {
      configWatchers.add(failed)
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
    updates: { module: moduleUpdate, config: configUpdateSpec },
  }
}
