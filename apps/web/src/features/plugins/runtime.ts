/**
 * The web app's plugins (stage 8.3): one registry of `@fxm/plugins` for the whole app, its
 * plugins kept in IndexedDB (`plugins-db.ts`), each run in a worker of a sandboxed evaluator
 * document of its own (`createSandboxEvaluator` of `@fxm/platform`, stage 1.11), never in the
 * app's page.
 *
 * - **Sources.** The catalog of every plugin that is on is registered with the app's sources
 *   (`appSources`), so it shows in the search page's source switch. A plugin's catalog is called
 *   only for what the user explicitly asks of it (`requestPolicy: 'explicit'`).
 * - **Hosts.** The hosts those plugins declare, and the host of a download in progress, are the
 *   platform's user hosts (`user-hosts.ts`).
 * - **Audio.** The resolvers of the plugins that are on go to the app's stream lifecycle, which
 *   the composition root connects with `connectPluginAudio` (`audio-target.ts`), so a plugin's
 *   songs play through it; they leave it when a plugin goes, or the lifecycle does.
 *   {@link pluginRecommendations} gives their radio.
 * - **Tabs.** A tab that installs, updates, switches or removes a plugin tells the others
 *   ({@link announcePluginChange}), which read the store again.
 *
 * Plugins run only in a browser for now: the desktop and Android evaluator hosts of 1.11 run one
 * document at a time, and their native networking asks the user about each host it reaches, so
 * those apps get plugins later (see the README). An F-Droid build starts nothing until the user
 * opted in.
 *
 * @module
 */

import type { AudioSource, RecommendationProvider } from '@fxm/core'
import {
  browserStorage,
  createSandboxEvaluator,
  type Distribution,
  detectEnvironment,
  type Environment,
  type KeyValueStorage,
  memoryStorage,
} from '@fxm/platform'
import { fromAudioSource } from '@fxm/player'
import {
  createPluginRegistry,
  type DownloadFetch,
  isolatedSandboxes,
  type PluginRegistry,
  type PluginSandboxes,
  type PluginStore,
  pluginPolicy,
  probePluginWorkers,
} from '@fxm/plugins'
import type { Sources } from '../search/sources'
import { appSources } from '../search/sources-context'
import {
  type PluginAudioTarget,
  pluginAudioTarget,
  resetPluginAudioTarget,
  subscribePluginAudioTarget,
} from './audio-target'
import { BUILD_DISTRIBUTION } from './distribution'
import { createDexiePluginStore, openPluginsDatabase } from './plugins-db'
import { usePluginsSettingsStore } from './plugins-store'
import { setPluginHostsSource } from './user-hosts'

/**
 * Whether plugins can run where the app runs: `supported` in a browser; `pending` in the desktop
 * and Android apps, until their evaluator hosts can run a document per plugin.
 */
export type PluginSupport = 'supported' | 'pending'

/** Whether plugins can run in `environment`. */
export function pluginSupport(environment: Environment): PluginSupport {
  return environment === 'browser' ? 'supported' : 'pending'
}

/** How the runtime is put together. Every field has a default; tests pass fakes. */
export interface PluginRuntimeOptions {
  /** Where plugins are kept. Default: the `fxm-plugins` IndexedDB database. */
  readonly store?: () => PluginStore
  /** Where they run. Default: a sandboxed evaluator document per plugin. */
  readonly sandboxes?: () => PluginSandboxes
  /** Where their request budgets are kept. Default: `localStorage`. */
  readonly budgetStorage?: () => KeyValueStorage
  /** The `fetch` for downloads. Default: the app platform's. */
  readonly download?: () => Promise<DownloadFetch>
  /** The sources plugin catalogs join. Default: `appSources`. */
  readonly sources?: Sources
  /** Where the app runs. Default: detected. */
  readonly environment?: Environment
  /** The build's distribution. Default: {@link BUILD_DISTRIBUTION}. */
  readonly distribution?: Distribution
  /** This FXM's version, which plugins' `minFxmVersion` is compared with. Default: the build's. */
  readonly appVersion?: string
  /**
   * Whether this browser can run plugins at all: whether an evaluator document starts the worker
   * each plugin runs in. Default: `probePluginWorkers` with a sandboxed evaluator document.
   */
  readonly probeWorkers?: () => Promise<boolean>
}

export { connectPluginAudio, type PluginAudioTarget } from './audio-target'

let options: PluginRuntimeOptions = {}
let registry: PluginRegistry | undefined
/** The answer of the worker probe, asked once per page. */
let workersRun: Promise<boolean> | undefined
let stopSync: (() => void) | undefined
/** The plugin catalogs registered with the sources, by plugin ID. */
const registered = new Map<string, { metadata: object; unregister: () => void }>()
/** The target the resolvers in {@link registeredAudio} were added to. */
let audioTarget: PluginAudioTarget | undefined
/** The plugin resolvers added to {@link audioTarget}, by plugin ID. */
const registeredAudio = new Map<string, { audio: AudioSource; remove: () => void }>()

/** The name of the channel the app's tabs tell each other about plugin changes on. */
export const PLUGINS_CHANNEL = 'fxm-plugins'

function environment(): Environment {
  if (options.environment !== undefined) return options.environment
  try {
    return detectEnvironment()
  } catch {
    return 'node'
  }
}

/** Where plugins can run here. */
export function currentPluginSupport(): PluginSupport {
  return pluginSupport(environment())
}

/**
 * Whether plugins can run in this browser: its evaluator document starts the worker each plugin
 * runs in. WebKit doesn't, so Safari and every browser on iPhone and iPad can't run plugins:
 * Settings says so there instead of offering to add one. Checked once, when first asked.
 */
export function pluginWorkersRun(): Promise<boolean> {
  workersRun ??= (options.probeWorkers ?? defaultWorkerProbe)().catch(() => false)
  return workersRun
}

/**
 * Asks a sandboxed evaluator document whether it starts a plugin's worker. A page without
 * workers at all (a DOM for tests, say) has its answer already, and frames no document.
 */
function defaultWorkerProbe(): Promise<boolean> {
  if (typeof Worker !== 'function') return Promise.resolve(false)
  return probePluginWorkers(() => createSandboxEvaluator())
}

/** Whether this build asks before plugins can be used (an F-Droid build). */
export function pluginsNeedOptIn(): boolean {
  return pluginPolicy(options.distribution ?? BUILD_DISTRIBUTION).needsOptIn
}

/** Whether plugins may run now: supported here, and opted in where the build asks first. */
export function pluginsAllowed(): boolean {
  if (currentPluginSupport() !== 'supported') return false
  return !pluginsNeedOptIn() || usePluginsSettingsStore.getState().optedIn
}

/** The app's plugin registry, created on first use. */
export function getPluginRegistry(): PluginRegistry {
  registry ??= createPluginRegistry({
    store: options.store?.() ?? createDexiePluginStore(openPluginsDatabase()),
    sandboxes: options.sandboxes?.() ?? isolatedSandboxes(() => createSandboxEvaluator()),
    budgetStorage: options.budgetStorage?.() ?? browserStorage() ?? memoryStorage(),
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
  })
  return registry
}

/** The `fetch` for downloading plugins: the app platform's, which reaches user hosts. */
export async function pluginDownloadFetch(): Promise<DownloadFetch> {
  if (options.download !== undefined) return options.download()
  const { getAppPlatform } = await import('../connect/app-platform')
  const platform = await getAppPlatform()
  return (url, init) => platform.transport.fetch(url, init)
}

/**
 * Adds the resolvers of the plugins that are on (of `current`, none without it) to the audio
 * target the composition root connected, and removes the others; all of them from a target that
 * was disconnected or replaced.
 */
function syncAudio(current: PluginRegistry | undefined): void {
  const target = pluginAudioTarget()
  if (target !== audioTarget) {
    for (const entry of registeredAudio.values()) entry.remove()
    registeredAudio.clear()
    audioTarget = target
  }
  const live = new Map<string, AudioSource>()
  if (audioTarget !== undefined && current !== undefined) {
    for (const providers of current.providers()) {
      if (providers.audio !== undefined) live.set(providers.id, providers.audio)
    }
  }
  for (const [id, entry] of registeredAudio) {
    if (live.get(id) !== entry.audio) {
      entry.remove()
      registeredAudio.delete(id)
    }
  }
  if (audioTarget === undefined) return
  for (const [id, audio] of live) {
    if (!registeredAudio.has(id)) {
      registeredAudio.set(id, { audio, remove: audioTarget.addSource(fromAudioSource(audio)) })
    }
  }
}

/** Registers the catalogs of the plugins that are on, and unregisters the others. */
function syncSources(current: PluginRegistry): void {
  const sources = options.sources ?? appSources
  const live = new Map<string, object>()
  for (const providers of current.providers()) {
    if (providers.metadata !== undefined) live.set(providers.id, providers.metadata)
  }
  for (const [id, entry] of registered) {
    if (live.get(id) !== entry.metadata) {
      entry.unregister()
      registered.delete(id)
    }
  }
  for (const providers of current.providers()) {
    const { metadata } = providers
    if (metadata === undefined || registered.has(providers.id)) continue
    registered.set(providers.id, { metadata, unregister: sources.register(metadata) })
  }
  syncAudio(current)
}

/**
 * Starts the plugins that are on: called from `main.tsx` after the first render, and when an
 * F-Droid build's user opts in. Does nothing where plugins can't run or aren't allowed yet.
 * Never rejects: a store that can't be read leaves plugins off.
 */
export async function startPlugins(): Promise<void> {
  if (!pluginsAllowed()) return
  const current = getPluginRegistry()
  if (stopSync === undefined) {
    setPluginHostsSource(() => current.hosts())
    const unsubscribe = current.subscribe(() => syncSources(current))
    // The app's stream lifecycle, which the composition root connects when it starts and takes
    // back when it stops: the resolver of every plugin that is on becomes one of its stream
    // sources (2.3's `fromAudioSource`), and leaves it when the plugin is switched off, updated
    // or removed.
    const unfollow = subscribePluginAudioTarget(() => syncAudio(current))
    let channel: BroadcastChannel | undefined
    try {
      channel = new BroadcastChannel(PLUGINS_CHANNEL)
      channel.onmessage = () => {
        current.reload().catch(() => undefined)
      }
    } catch {
      channel = undefined
    }
    stopSync = () => {
      unsubscribe()
      unfollow()
      channel?.close()
    }
  }
  try {
    await current.load()
  } catch {
    // The store can't be read (storage blocked): no plugins this time.
  }
  syncSources(current)
}

/** Stops every plugin and forgets the registry: an F-Droid build's user opted out. */
export function stopPlugins(): void {
  stopSync?.()
  stopSync = undefined
  for (const entry of registered.values()) entry.unregister()
  registered.clear()
  syncAudio(undefined)
  registry?.dispose()
  registry = undefined
  setPluginHostsSource(() => [])
}

/** Tells the app's other tabs that the plugins changed, so they read them again. */
export function announcePluginChange(): void {
  try {
    const channel = new BroadcastChannel(PLUGINS_CHANNEL)
    channel.postMessage('changed')
    channel.close()
  } catch {
    // No BroadcastChannel: other tabs see the change after a reload.
  }
}

/** The resolvers of the plugins that are on. */
export function pluginAudioSources(): AudioSource[] {
  return (registry?.providers() ?? []).flatMap((providers) =>
    providers.audio === undefined ? [] : [providers.audio],
  )
}

/** The radio of the plugins that are on, for the recommendations. */
export function pluginRecommendations(): RecommendationProvider[] {
  return (registry?.providers() ?? []).flatMap((providers) =>
    providers.recommendations === undefined ? [] : [providers.recommendations],
  )
}

/** Puts the runtime together differently: tests pass fakes before anything starts. */
export function configurePluginRuntime(next: PluginRuntimeOptions): void {
  stopPlugins()
  options = next
  workersRun = undefined
}

/** Stops everything and goes back to the defaults, for tests. */
export function resetPluginRuntime(): void {
  stopPlugins()
  resetPluginAudioTarget()
  audioTarget = undefined
  options = {}
  workersRun = undefined
}
