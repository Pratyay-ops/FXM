/**
 * The installed plugins: what the settings page lists and the app runs. The registry keeps them
 * in a {@link PluginStore} (IndexedDB in the web app), offers new plugins and updates for the
 * user's approval, and gives the app the providers of the plugins that are on, and the hosts
 * those may contact, for the platform's user hosts.
 *
 * - **Installs and updates need the user.** {@link PluginRegistry.offerFromAddress} and
 *   {@link PluginRegistry.offerFromFile} only fetch and check; nothing is stored or run until the
 *   app calls {@link PluginRegistry.install} with the offer the user approved. An update is an
 *   offer too: the registry never installs one by itself, and checks for one only when asked
 *   ({@link PluginRegistry.checkForUpdate}). Versions only go up.
 * - **Stored copies are checked again** whenever they are read: the manifest, the code's SHA-256
 *   and the FXM version. A copy that fails stays listed, with its problem, but never runs.
 * - **Plugins that are off don't run**: no document, no requests, no providers.
 *
 * @module
 */

import { APP_VERSION } from '@fxm/core'
import {
  type Clock,
  createRequestBudget,
  type KeyValueStorage,
  memoryStorage,
  type RequestBudget,
  systemClock,
} from '@fxm/platform'
import { type BrokerLimits, createFetchBroker } from './broker'
import { verifyChecksum } from './checksum'
import { cleanText, PluginError } from './errors'
import { createPluginRunner, type PluginRunner, type RunnerLimits } from './host'
import {
  checkCompatible,
  compareVersions,
  type PluginManifest,
  type PluginOperation,
  parseManifest,
} from './manifest'
import {
  type DownloadFetch,
  downloadHosts,
  downloadPlugin,
  type PluginOrigin,
  type PluginPackage,
  pluginAddress,
  readPluginFile,
} from './package'
import { createPluginProviders, type PluginProviders } from './provider'
import type { PluginSandboxes } from './sandboxes'

/** A plugin as the store keeps it. */
export interface StoredPlugin {
  /** Its ID, the store's key. */
  readonly id: string
  /** Its manifest, as the user approved it. */
  readonly manifest: PluginManifest
  /** Its code. */
  readonly code: string
  /** Where it came from. */
  readonly origin: PluginOrigin
  /** Whether it is on. */
  readonly enabled: boolean
  /** When it was first installed, in epoch milliseconds. */
  readonly installedAt: number
  /** When this version was installed. */
  readonly updatedAt: number
}

/** Where the registry keeps plugins. Every method may reject when the storage fails. */
export interface PluginStore {
  /** Every stored plugin. */
  list(): Promise<StoredPlugin[]>
  /** Adds a plugin, or replaces the one with its ID. */
  put(plugin: StoredPlugin): Promise<void>
  /** Removes a plugin. */
  delete(id: string): Promise<void>
}

/** A store in memory, for tests and for apps without storage. */
export function memoryPluginStore(initial: readonly StoredPlugin[] = []): PluginStore {
  const plugins = new Map(initial.map((plugin) => [plugin.id, structuredClone(plugin)]))
  return {
    async list() {
      return [...plugins.values()].map((plugin) => structuredClone(plugin))
    },
    async put(plugin) {
      plugins.set(plugin.id, structuredClone(plugin))
    },
    async delete(id) {
      plugins.delete(id)
    },
  }
}

/** An installed plugin, as the settings page shows it. */
export interface PluginEntry {
  /** Its ID. */
  readonly id: string
  /** Its manifest. */
  readonly manifest: PluginManifest
  /** Where it came from. */
  readonly origin: PluginOrigin
  /** Whether it is on. */
  readonly enabled: boolean
  /** When it was first installed. */
  readonly installedAt: number
  /** When this version was installed. */
  readonly updatedAt: number
  /**
   * Why it can't run, if it can't: its stored copy fails the checks (a damaged manifest, code
   * that doesn't match its checksum) or it needs a newer FXM. Such a plugin never runs; the user
   * can remove it.
   */
  readonly problem?: string
}

/** A plugin offered for the user's approval: a new one, or an update of an installed one. */
export interface PluginOffer {
  /** The plugin, checked. */
  readonly package: PluginPackage
  /** The installed version an update replaces; absent for a new plugin. */
  readonly current?: PluginEntry
  /** Hosts the offered version may contact and the installed one may not (all, when new). */
  readonly addedHosts: readonly string[]
  /** Hosts the installed version may contact and the offered one may not. */
  readonly removedHosts: readonly string[]
  /** What the offered version does and the installed one doesn't (all, when new). */
  readonly addedOperations: readonly PluginOperation[]
  /** What the installed version does and the offered one doesn't. */
  readonly removedOperations: readonly PluginOperation[]
}

/** Options for {@link createPluginRegistry}. */
export interface PluginRegistryOptions {
  /** Where plugins are kept. */
  readonly store: PluginStore
  /** Where their code runs: documents of the isolated evaluator. */
  readonly sandboxes: PluginSandboxes
  /**
   * Where each plugin's request budget is kept, so that reloads and tabs share it (the app's
   * `localStorage`). Default: memory.
   */
  readonly budgetStorage?: KeyValueStorage
  /** This FXM's version. Default: `APP_VERSION` of `@fxm/core`. */
  readonly appVersion?: string
  /** Overrides of the limits, for tests. */
  readonly limits?: {
    readonly runner?: Partial<RunnerLimits>
    readonly broker?: Partial<BrokerLimits>
  }
  /** The clock, for tests. */
  readonly clock?: Clock
}

/** The installed plugins. */
export interface PluginRegistry {
  /** Reads the store and starts the plugins that are on. Later calls wait for the first. */
  load(): Promise<void>
  /** Reads the store again, e.g. after another tab changed it. */
  reload(): Promise<void>
  /** The installed plugins, by name. The same array until something changes. */
  entries(): readonly PluginEntry[]
  /** Calls `listener` after every change; returns the function that removes it. */
  subscribe(listener: () => void): () => void
  /** The providers of the plugins that are on and can run. The same array until a change. */
  providers(): readonly PluginProviders[]
  /**
   * The hosts the plugins that are on may contact, plus the host of a download in progress:
   * for the platform's user hosts (`createPlatform({ userHosts: () => registry.hosts() })`).
   */
  hosts(): readonly string[]
  /**
   * Downloads a plugin from an address the user entered (see `downloadPlugin`), through `fetch`,
   * while its host is in {@link hosts}, and offers it. Nothing is installed.
   */
  offerFromAddress(
    address: string,
    fetch: DownloadFetch,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PluginOffer>
  /** Reads a plugin file the user picked and offers it. Nothing is installed. */
  offerFromFile(text: string, name: string): PluginOffer
  /**
   * Installs an offer the user approved, switched on: a new plugin, or an update that replaces
   * the installed version (whose document stops). Rejects with `not-newer` when the installed
   * version changed meanwhile and the offer is no longer newer.
   */
  install(offer: PluginOffer): Promise<PluginEntry>
  /** Switches a plugin on or off. Off, it stops at once and makes no more requests. */
  setEnabled(id: string, enabled: boolean): Promise<void>
  /** Removes a plugin and its request budget. */
  remove(id: string): Promise<void>
  /**
   * Downloads a plugin again from the address it was installed from, and offers the download
   * when it is a newer version; `undefined` when it isn't. Only when the user asks: FXM never
   * checks by itself. A plugin installed from a file updates from a newer file instead
   * ({@link offerFromFile}).
   */
  checkForUpdate(
    id: string,
    fetch: DownloadFetch,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PluginOffer | undefined>
  /** Stops every plugin. */
  dispose(): void
}

/** What runs for a plugin that is on. */
interface Running {
  readonly stored: StoredPlugin
  readonly manifest: PluginManifest
  readonly runner: PluginRunner
  readonly providers: PluginProviders
  readonly budget: RequestBudget
}

/** Whether two stored copies are the same installed version. */
function sameInstall(a: StoredPlugin, b: StoredPlugin): boolean {
  return a.updatedAt === b.updatedAt && sha256Of(a) === sha256Of(b) && a.code === b.code
}

/** The checksum a stored copy's manifest declares, read without trusting its shape. */
function sha256Of(plugin: StoredPlugin): unknown {
  const manifest = plugin.manifest as unknown
  return typeof manifest === 'object' && manifest !== null
    ? (manifest as { sha256?: unknown }).sha256
    : undefined
}

/** Whether two lists hold the same items, in order. */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** Whether two snapshots of entries show the same thing. */
function sameEntries(a: readonly PluginEntry[], b: readonly PluginEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index]
      return (
        other !== undefined &&
        entry.id === other.id &&
        entry.updatedAt === other.updatedAt &&
        entry.enabled === other.enabled &&
        entry.problem === other.problem &&
        entry.manifest.sha256 === other.manifest.sha256
      )
    })
  )
}

/**
 * A stored manifest to show: the manifest itself when it passes the checks, else a stand-in
 * with the stored name, no hosts and no operations, for a plugin that never runs.
 */
function shownManifest(plugin: StoredPlugin): PluginManifest {
  try {
    return parseManifest(plugin.manifest)
  } catch {
    const raw = (typeof plugin.manifest === 'object' && plugin.manifest !== null
      ? plugin.manifest
      : {}) as unknown as Record<string, unknown>
    const name = typeof raw.name === 'string' ? cleanText(raw.name, 60) : ''
    return {
      fxmPlugin: 1,
      id: plugin.id,
      name: name === '' ? plugin.id : name,
      version:
        typeof raw.version === 'string' && /^\d+\.\d+\.\d+$/u.test(raw.version)
          ? raw.version
          : '0.0.0',
      minFxmVersion: '0.0.0',
      hosts: [],
      entry: 'plugin.js',
      sha256: '0'.repeat(64),
      provides: [],
      requestsPerHour: 1,
    }
  }
}

/** The storage key of a plugin's request budget. */
export function budgetKey(id: string): string {
  return `fxm.plugins.budget.${id}`
}

/** Creates the registry. Call {@link PluginRegistry.load} before using it. */
export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const { store, sandboxes } = options
  const clock = options.clock ?? systemClock
  const appVersion = options.appVersion ?? APP_VERSION
  const budgetStorage = options.budgetStorage ?? memoryStorage()
  const listeners = new Set<() => void>()
  const running = new Map<string, Running>()
  /** Hosts of downloads in progress, counted. */
  const downloading = new Map<string, number>()
  let stored = new Map<string, StoredPlugin>()
  let entries: readonly PluginEntry[] = []
  let providers: readonly PluginProviders[] = []
  let hosts: readonly string[] = []
  let loading: Promise<void> | undefined
  let disposed = false
  /** Store changes, one at a time. */
  let queue: Promise<unknown> = Promise.resolve()

  function serially<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  /** Problems found, by stored version, so a copy is checked once. */
  const problems = new Map<string, string | null>()

  /** Why a stored plugin can't run, or `undefined` when it can. */
  function problemOf(plugin: StoredPlugin): string | undefined {
    const size = typeof plugin.code === 'string' ? plugin.code.length : -1
    const key = `${plugin.id}\n${plugin.updatedAt}\n${String(sha256Of(plugin))}\n${size}`
    const known = problems.get(key)
    if (known !== undefined) return known ?? undefined
    const found = findProblem(plugin)
    problems.set(key, found ?? null)
    return found
  }

  function findProblem(plugin: StoredPlugin): string | undefined {
    try {
      const manifest = parseManifest(plugin.manifest)
      if (manifest.id !== plugin.id) return 'Its stored copy is damaged: remove it and add it again'
      verifyChecksum(plugin.code, manifest.sha256)
      checkCompatible(manifest, appVersion)
      return undefined
    } catch (error) {
      if (error instanceof PluginError && error.pluginCode === 'needs-newer-fxm') {
        return cleanText(error.message, 200)
      }
      return 'Its stored copy is damaged: remove it and add it again'
    }
  }

  function stopRunning(id: string): void {
    const current = running.get(id)
    if (current === undefined) return
    running.delete(id)
    current.runner.dispose()
    sandboxes.stop(id)
  }

  function start(plugin: StoredPlugin): void {
    const manifest = parseManifest(plugin.manifest)
    const budget = createRequestBudget({
      hourlyLimit: manifest.requestsPerHour,
      reserves: { 'current-track': 0, prefetch: 0, interactive: 0, bulk: 0 },
      storage: budgetStorage,
      storageKey: budgetKey(manifest.id),
      clock,
    })
    const broker = createFetchBroker({
      plugin: manifest,
      budget,
      clock,
      ...(options.limits?.broker === undefined ? {} : { limits: options.limits.broker }),
    })
    const runner = createPluginRunner({
      manifest,
      code: plugin.code,
      sandboxes,
      broker,
      clock,
      ...(options.limits?.runner === undefined ? {} : { limits: options.limits.runner }),
    })
    running.set(plugin.id, {
      stored: plugin,
      manifest,
      runner,
      providers: createPluginProviders(runner),
      budget,
    })
  }

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  /**
   * Brings what runs and the snapshots in line with `stored`, and tells the listeners when a
   * snapshot changed. Snapshots that didn't change keep their arrays, for React's
   * `useSyncExternalStore`.
   */
  function refresh(): void {
    const next: PluginEntry[] = []
    for (const plugin of stored.values()) {
      const problem = problemOf(plugin)
      next.push({
        id: plugin.id,
        manifest: shownManifest(plugin),
        origin: plugin.origin,
        enabled: plugin.enabled,
        installedAt: plugin.installedAt,
        updatedAt: plugin.updatedAt,
        ...(problem === undefined ? {} : { problem }),
      })
      const current = running.get(plugin.id)
      const runs = plugin.enabled && problem === undefined && !disposed
      if (current !== undefined && (!runs || !sameInstall(current.stored, plugin))) {
        stopRunning(plugin.id)
      }
      if (runs && running.get(plugin.id) === undefined) start(plugin)
    }
    for (const id of [...running.keys()]) if (!stored.has(id)) stopRunning(id)
    next.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.id.localeCompare(b.id))
    const nextProviders = next.flatMap((entry) => {
      const current = running.get(entry.id)
      return current === undefined ? [] : [current.providers]
    })
    let changed = false
    if (!sameEntries(next, entries)) {
      entries = next
      changed = true
    }
    if (!sameItems(nextProviders, providers)) {
      providers = nextProviders
      changed = true
    }
    if (updateHosts() || changed) notify()
  }

  /** Recomputes the hosts; returns whether they changed. */
  function updateHosts(): boolean {
    const all = new Set<string>()
    for (const current of running.values()) {
      for (const host of current.manifest.hosts) all.add(host)
    }
    for (const host of downloading.keys()) all.add(host)
    const next = [...all].sort()
    if (sameItems(next, hosts)) return false
    hosts = next
    return true
  }

  async function read(): Promise<void> {
    const records = await store.list()
    stored = new Map(records.map((plugin) => [plugin.id, plugin]))
    refresh()
  }

  function entryOf(id: string): PluginEntry | undefined {
    return entries.find((entry) => entry.id === id)
  }

  function offer(pkg: PluginPackage): PluginOffer {
    const current = entryOf(pkg.manifest.id)
    const { manifest } = pkg
    if (current !== undefined) {
      const installed = current.manifest
      const order = compareVersions(manifest.version, installed.version)
      // A stored copy that fails the checks may be replaced by the same version, to repair it.
      const repairs = current.problem !== undefined && order === 0
      if (order < 0 || (order === 0 && !repairs)) {
        throw new PluginError(
          'not-newer',
          order === 0 && manifest.sha256 === installed.sha256 && current.problem === undefined
            ? `${installed.name} ${installed.version} is already installed`
            : `${installed.name} ${installed.version} is installed; FXM installs only a higher version (this one is ${manifest.version})`,
        )
      }
    }
    const before = current?.manifest
    return {
      package: pkg,
      ...(current === undefined ? {} : { current }),
      addedHosts: manifest.hosts.filter((host) => !before?.hosts.includes(host)),
      removedHosts: before?.hosts.filter((host) => !manifest.hosts.includes(host)) ?? [],
      addedOperations: manifest.provides.filter((op) => !before?.provides.includes(op)),
      removedOperations: before?.provides.filter((op) => !manifest.provides.includes(op)) ?? [],
    }
  }

  async function withDownloadHosts<T>(address: string, work: () => Promise<T>): Promise<T> {
    const url = pluginAddress(address)
    const added = url === undefined ? [] : downloadHosts(url)
    for (const host of added) downloading.set(host, (downloading.get(host) ?? 0) + 1)
    if (updateHosts()) notify()
    try {
      return await work()
    } finally {
      for (const host of added) {
        const count = (downloading.get(host) ?? 1) - 1
        if (count <= 0) downloading.delete(host)
        else downloading.set(host, count)
      }
      if (updateHosts()) notify()
    }
  }

  function ensureOpen(): void {
    if (disposed) throw new PluginError('disabled', 'Plugins were shut down')
  }

  function load(): Promise<void> {
    loading ??= serially(read)
    return loading
  }

  return {
    load,
    async reload() {
      ensureOpen()
      return serially(read)
    },
    entries: () => entries,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    providers: () => providers,
    hosts: () => hosts,
    async offerFromAddress(address, fetch, callOptions = {}) {
      ensureOpen()
      await load()
      const pkg = await withDownloadHosts(address, () =>
        downloadPlugin(address, fetch, {
          appVersion,
          ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
        }),
      )
      return offer(pkg)
    },
    offerFromFile(text, name) {
      ensureOpen()
      return offer(readPluginFile(text, name, { appVersion }))
    },
    async install(approved) {
      ensureOpen()
      return serially(async () => {
        await read()
        // Checked again: the installed version may have changed since the offer was made.
        const fresh = offer(approved.package)
        const { manifest, code, origin } = fresh.package
        const now = clock.now()
        const record: StoredPlugin = {
          id: manifest.id,
          manifest,
          code,
          origin,
          enabled: true,
          installedAt: fresh.current?.installedAt ?? now,
          updatedAt: now,
        }
        await store.put(record)
        stored.set(record.id, record)
        refresh()
        const entry = entryOf(record.id)
        if (entry === undefined) throw new PluginError('disabled', 'The plugin was removed')
        return entry
      })
    },
    async setEnabled(id, enabled) {
      ensureOpen()
      return serially(async () => {
        await read()
        const current = stored.get(id)
        if (current === undefined || current.enabled === enabled) return
        const record = { ...current, enabled }
        await store.put(record)
        stored.set(id, record)
        refresh()
      })
    },
    async remove(id) {
      ensureOpen()
      return serially(async () => {
        await store.delete(id)
        stored.delete(id)
        try {
          budgetStorage.removeItem(budgetKey(id))
        } catch {
          // The budget expires by itself within the hour.
        }
        refresh()
      })
    },
    async checkForUpdate(id, fetch, callOptions = {}) {
      ensureOpen()
      await load()
      const current = entryOf(id)
      if (current === undefined) throw new PluginError('disabled', 'The plugin is not installed')
      if (current.origin.kind !== 'url') {
        throw new PluginError(
          'invalid-file',
          `${current.manifest.name} was added from a file: add a newer file to update it`,
        )
      }
      const { url } = current.origin
      const pkg = await withDownloadHosts(url, () =>
        downloadPlugin(url, fetch, {
          appVersion,
          ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
        }),
      )
      if (pkg.manifest.id !== id) {
        throw new PluginError(
          'id-mismatch',
          `${url} now serves another plugin (${pkg.manifest.id}), not ${id}`,
        )
      }
      if (compareVersions(pkg.manifest.version, current.manifest.version) <= 0) return undefined
      return offer(pkg)
    },
    dispose() {
      disposed = true
      for (const id of [...running.keys()]) stopRunning(id)
      sandboxes.dispose()
      providers = []
      hosts = []
      notify()
    },
  }
}
