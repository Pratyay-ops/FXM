/**
 * Test helpers for the plugins feature: the runtime with an in-memory store, in-process
 * evaluators (the real runtime of `eval.html`, run in the test's realm, starting each plugin's
 * worker in a fresh realm), a fake download site and fresh sources. Never import this from app
 * code.
 *
 * @module
 */

import type { Distribution, Environment } from '@fxm/platform'
import { memoryStorage } from '@fxm/platform'
import type { DownloadFetch, PluginStore, StoredPlugin } from '@fxm/plugins'
import { inProcessSandboxes, memoryPluginStore } from '@fxm/plugins/testing'
import { createSources, type Sources } from '../search/sources'
import { usePluginsSettingsStore } from './plugins-store'
import { configurePluginRuntime, resetPluginRuntime } from './runtime'

/** A download site: files by URL, which a test can change, and what was asked of it. */
export interface FakeSite {
  readonly fetch: DownloadFetch
  readonly asked: readonly string[]
  serve(url: string, body: string): void
}

/** Creates a {@link FakeSite}. Unknown URLs answer 404. */
export function fakeSite(files: Record<string, string> = {}): FakeSite {
  const served = new Map(Object.entries(files))
  const asked: string[] = []
  return {
    fetch: async (url) => {
      asked.push(url)
      const body = served.get(url)
      return body === undefined ? new Response('', { status: 404 }) : new Response(body)
    },
    asked,
    serve(url, body) {
      served.set(url, body)
    },
  }
}

/** What {@link setupPluginTestRuntime} set up. */
export interface PluginTestRuntime {
  readonly store: PluginStore
  readonly site: FakeSite
  readonly sources: Sources
}

/**
 * Puts the plugin runtime together with fakes, for one test: an in-memory store (with `initial`
 * plugins), in-process evaluators, a fake site for downloads and fresh sources. Call
 * {@link resetPluginTestRuntime} after the test.
 */
export function setupPluginTestRuntime(
  options: {
    initial?: StoredPlugin[]
    environment?: Environment
    distribution?: Distribution
    sources?: Sources
    appVersion?: string
    /** Whether the browser's evaluator starts plugin workers (WebKit's doesn't). Default yes. */
    workersRun?: boolean
  } = {},
): PluginTestRuntime {
  const store = memoryPluginStore(options.initial ?? [])
  const site = fakeSite()
  const sources = options.sources ?? createSources()
  configurePluginRuntime({
    store: () => store,
    sandboxes: () => inProcessSandboxes(),
    budgetStorage: () => memoryStorage(),
    download: async () => site.fetch,
    sources,
    environment: options.environment ?? 'browser',
    distribution: options.distribution ?? 'standard',
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    // The in-process evaluators run workers: plugins run here unless a test says otherwise.
    probeWorkers: async () => options.workersRun ?? true,
  })
  return { store, site, sources }
}

/** Stops the test runtime and forgets the opt-in. */
export function resetPluginTestRuntime(): void {
  resetPluginRuntime()
  usePluginsSettingsStore.setState(usePluginsSettingsStore.getInitialState(), true)
}
