/**
 * The installed plugins: what the settings page lists and the app runs. The registry keeps them
 * in a {@link PluginStore} (IndexedDB in the web app), offers new plugins and updates for the
 * user's approval, and gives the app the providers of the plugins that are on, and the hosts
 * those may contact, for the platform's user hosts.
 *
 * - **Installs and updates need the user.** {@link PluginRegistry.offerFromAddress} and
 *   {@link PluginRegistry.offerFromFile} only fetch and check; nothing is stored or run until the
 *   app calls {@link PluginRegistry.install} with the offer the user approved, which checks the
 *   package again. An update is an offer too: the registry never installs one by itself, and
 *   checks for one only when asked ({@link PluginRegistry.checkForUpdate}). Versions only go up,
 *   except that a plugin which can't run may be replaced by any version.
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
  type RequestPriority,
  systemClock,
} from '@fxm/platform'
import { type BrokerLimits, createFetchBroker } from './broker'
import { verifyChecksum } from './checksum'
import { cleanText, isPluginError, PluginError } from './errors'
import { createPluginRunner, type PluginRunner, type RunnerLimits } from './host'
import {
  compareVersions,
  type PluginManifest,
  type PluginOperation,
  parseManifest,
  parseVersion,
} from './manifest'
import {
  checkPackage,
  type DownloadFetch,
  downloadHosts,
  downloadPlugin,
  type PluginOrigin,
  type PluginPackage,
  parseOrigin,
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

/** A store in memory, for tests. */
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

/**
 * Why an installed plugin can't run. `message` is English, for logs; the app words each `code`
 * itself:
 *
 * - `damaged`: its stored copy fails the checks (a damaged manifest, code that doesn't match its
 *   checksum, a missing origin). Removing it, or adding any version of it again, repairs it.
 * - `needs-newer-fxm`: it needs FXM `minFxmVersion` or later, and this is `appVersion` (FXM went
 *   back to an older version, say). Updating FXM, or adding a version of the plugin that runs on
 *   this one, repairs it.
 */
export type PluginProblem =
  | { readonly code: 'damaged'; readonly message: string }
  | {
      readonly code: 'needs-newer-fxm'
      readonly message: string
      readonly minFxmVersion: string
      readonly appVersion: string
    }

/** What every {@link PluginEntry} has. */
interface PluginEntryBase {
  /** Its ID. */
  readonly id: string
  /** Its name for people: the manifest's, or the ID when a damaged copy names none. */
  readonly name: string
  /** Where it came from. */
  readonly origin: PluginOrigin
  /** Whether it is on. */
  readonly enabled: boolean
  /** When it was first installed. */
  readonly installedAt: number
  /** When this version was installed. */
  readonly updatedAt: number
}

/** An installed plugin that can run. */
export interface RunnablePluginEntry extends PluginEntryBase {
  /** Its version. */
  readonly version: string
  /** Its manifest, which passed every check. */
  readonly manifest: PluginManifest
  readonly problem?: undefined
}

/** An installed plugin that can't run: it never does, and the user can remove or replace it. */
export interface BrokenPluginEntry extends PluginEntryBase {
  /** Its version, when the stored copy names a valid one. */
  readonly version?: string
  readonly manifest?: undefined
  /** Why it can't run. */
  readonly problem: PluginProblem
}

/** An installed plugin, as the settings page shows it. */
export type PluginEntry = RunnablePluginEntry | BrokenPluginEntry

/** A plugin offered for the user's approval: a new one, or an update of an installed one. */
export interface PluginOffer {
  /** The plugin, checked. */
  readonly package: PluginPackage
  /** The installed version it replaces; absent for a new plugin. */
  readonly current?: PluginEntry
  /**
   * Hosts the offered version may contact and the installed one may not: all of them for a new
   * plugin, or for one whose installed copy can't run.
   */
  readonly addedHosts: readonly string[]
  /** Hosts the installed version may contact and the offered one may not. */
  readonly removedHosts: readonly string[]
  /** What the offered version does and the installed one doesn't (all, as for hosts). */
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
  /**
   * Reads the store and starts the plugins that are on. Later calls wait for the first; after a
   * failure (the store couldn't be read), the next call tries again.
   */
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
  offerFromFile(text: string, name: string): Promise<PluginOffer>
  /**
   * Installs an offer the user approved, switched on: a new plugin, or an update that replaces
   * the installed version (whose document stops). The package is checked again first, as if it
   * had just been read: an offer built by hand gets no further than one that was downloaded.
   * Rejects with `not-newer` when the installed version changed meanwhile and the offer is no
   * longer newer.
   */
  install(offer: PluginOffer): Promise<PluginEntry>
  /** Switches a plugin on or off. Off, it stops at once and makes no more requests. */
  setEnabled(id: string, enabled: boolean): Promise<void>
  /** Removes a plugin and its request budget. */
  remove(id: string): Promise<void>
  /**
   * Downloads a plugin again from the address it was installed from, and offers the download
   * when it is a newer version, or any version when the installed copy can't run; `undefined`
   * when there is nothing to update. Only when the user asks: FXM never checks by itself. A
   * plugin installed from a file updates from a newer file instead ({@link offerFromFile}).
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

/** What the checks of a stored copy found: its manifest, or why it can't run. */
type Verdict =
  | { readonly manifest: PluginManifest; readonly problem?: undefined }
  | { readonly manifest?: undefined; readonly problem: PluginProblem }

const DAMAGED: Verdict = {
  problem: { code: 'damaged', message: 'Its stored copy is damaged: remove it and add it again' },
}

/** Whether two stored copies are the same installed version. */
function sameInstall(a: StoredPlugin, b: StoredPlugin): boolean {
  return a.updatedAt === b.updatedAt && sha256Of(a) === sha256Of(b) && a.code === b.code
}

/** A stored copy's manifest, read without trusting its shape. */
function rawManifest(plugin: StoredPlugin): Record<string, unknown> {
  const manifest = plugin.manifest as unknown
  return typeof manifest === 'object' && manifest !== null
    ? (manifest as Record<string, unknown>)
    : {}
}

/** The checksum a stored copy's manifest declares, read without trusting its shape. */
function sha256Of(plugin: StoredPlugin): unknown {
  return rawManifest(plugin).sha256
}

/** JSON text of a value, or `undefined` when it has none (a cycle, say). */
function jsonOf(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
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
        entry.name === other.name &&
        entry.version === other.version &&
        entry.updatedAt === other.updatedAt &&
        entry.enabled === other.enabled &&
        entry.problem?.message === other.problem?.message &&
        entry.manifest?.sha256 === other.manifest?.sha256
      )
    })
  )
}

/** A number from storage, or 0. */
function timeOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The storage key of a plugin's request budget. */
export function budgetKey(id: string): string {
  return `fxm.plugins.budget.${id}`
}

/**
 * The calls of the hour each priority leaves for the ones above it, in a plugin's budget of
 * `hourlyLimit` requests: search and pages stop with a quarter left, and prefetching with a tenth,
 * so the stream of the song the user is waiting for can still be found.
 */
export function pluginReserves(hourlyLimit: number): Record<RequestPriority, number> {
  return {
    'current-track': 0,
    prefetch: Math.floor(hourlyLimit * 0.1),
    interactive: Math.floor(hourlyLimit * 0.25),
    bulk: Math.floor(hourlyLimit * 0.5),
  }
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

  /**
   * The last verdict on each plugin's stored copy, with the code and the manifest it was for:
   * it is reused only for that very code and manifest, so a copy that changed is checked again.
   */
  const verdicts = new Map<string, { code: unknown; manifest: string; verdict: Verdict }>()

  /** What the checks find for a stored copy. */
  function verdictOf(plugin: StoredPlugin): Verdict {
    const manifestJson = jsonOf(plugin.manifest)
    const known = verdicts.get(plugin.id)
    if (
      known !== undefined &&
      manifestJson !== undefined &&
      known.manifest === manifestJson &&
      known.code === plugin.code
    ) {
      return known.verdict
    }
    const verdict = check(plugin)
    if (manifestJson !== undefined) {
      verdicts.set(plugin.id, { code: plugin.code, manifest: manifestJson, verdict })
    }
    return verdict
  }

  function check(plugin: StoredPlugin): Verdict {
    try {
      const manifest = parseManifest(plugin.manifest, { appVersion })
      if (manifest.id !== plugin.id || typeof plugin.code !== 'string') return DAMAGED
      if (parseOrigin(plugin.origin) === undefined) return DAMAGED
      verifyChecksum(plugin.code, manifest.sha256)
      return { manifest }
    } catch (error) {
      if (isPluginError(error, 'needs-newer-fxm')) {
        return {
          problem: {
            code: 'needs-newer-fxm',
            message: cleanText(error.message, 200),
            minFxmVersion: String(rawManifest(plugin).minFxmVersion),
            appVersion,
          },
        }
      }
      return DAMAGED
    }
  }

  /** The entry the settings page shows for a stored copy. */
  function entryFor(plugin: StoredPlugin, verdict: Verdict): PluginEntry {
    const base = {
      id: plugin.id,
      origin: parseOrigin(plugin.origin) ?? { kind: 'file' as const, name: '' },
      enabled: plugin.enabled === true,
      installedAt: timeOf(plugin.installedAt),
      updatedAt: timeOf(plugin.updatedAt),
    }
    if (verdict.manifest !== undefined) {
      const { manifest } = verdict
      return { ...base, name: manifest.name, version: manifest.version, manifest }
    }
    const raw = rawManifest(plugin)
    const name = typeof raw.name === 'string' ? cleanText(raw.name, 60) : ''
    const version = parseVersion(raw.version) === undefined ? undefined : String(raw.version)
    return {
      ...base,
      name: name === '' ? plugin.id : name,
      ...(version === undefined ? {} : { version }),
      problem: verdict.problem,
    }
  }

  function stopRunning(id: string): void {
    const current = running.get(id)
    if (current === undefined) return
    running.delete(id)
    current.runner.dispose()
    sandboxes.stop(id)
  }

  function start(plugin: StoredPlugin, manifest: PluginManifest): void {
    const budget = createRequestBudget({
      hourlyLimit: manifest.requestsPerHour,
      reserves: pluginReserves(manifest.requestsPerHour),
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
      const verdict = verdictOf(plugin)
      next.push(entryFor(plugin, verdict))
      const current = running.get(plugin.id)
      const runs = plugin.enabled === true && verdict.manifest !== undefined && !disposed
      if (current !== undefined && (!runs || !sameInstall(current.stored, plugin))) {
        stopRunning(plugin.id)
      }
      if (runs && running.get(plugin.id) === undefined) start(plugin, verdict.manifest)
    }
    for (const id of [...running.keys()]) if (!stored.has(id)) stopRunning(id)
    next.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
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
    // An installed plugin that runs is replaced only by a higher version; one that can't run, by
    // any version, which repairs it.
    if (current !== undefined && current.problem === undefined) {
      const order = compareVersions(manifest.version, current.version)
      if (order <= 0) {
        throw new PluginError(
          'not-newer',
          order === 0 && manifest.sha256 === current.manifest.sha256
            ? `${current.name} ${current.version} is already installed`
            : `${current.name} ${current.version} is installed; FXM installs only a higher version (this one is ${manifest.version})`,
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

  /** Reads the store as the latest load; a failed read leaves the next load to try again. */
  function readAsLoad(): Promise<void> {
    const attempt = serially(read)
    loading = attempt
    attempt.catch(() => {
      if (loading === attempt) loading = undefined
    })
    return attempt
  }

  function load(): Promise<void> {
    return loading ?? readAsLoad()
  }

  return {
    load,
    async reload() {
      ensureOpen()
      return readAsLoad()
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
    async offerFromFile(text, name) {
      ensureOpen()
      // Compared with the stored copies, so an update shows what it changes.
      await load()
      return offer(readPluginFile(text, name, { appVersion }))
    },
    async install(approved) {
      ensureOpen()
      return serially(async () => {
        await read()
        // Checked again, whoever built the offer, and against the installed version as it is
        // now: it may have changed since the offer was made.
        const fresh = offer(checkPackage(approved?.package, appVersion))
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
        verdicts.delete(id)
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
          `${current.name} was added from a file: add a newer file to update it`,
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
      // A plugin that can't run takes whatever version its address serves.
      if (
        current.problem === undefined &&
        compareVersions(pkg.manifest.version, current.version) <= 0
      ) {
        return undefined
      }
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
