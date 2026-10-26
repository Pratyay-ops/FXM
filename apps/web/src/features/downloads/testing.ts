/**
 * Test setup for the downloads feature: the app's downloads on an in-memory storage, a fake
 * media server as the network and a fake resolver, for a tier the test picks. Not used by the
 * app itself.
 *
 * @module
 */

import type { NetworkCapabilities, ProviderContext, Track } from '@fxm/core'
import { createMemoryDownloadStorage, type MemoryDownloadStorage } from '@fxm/downloads'
import {
  createFakeFxmDownloads,
  downloadCandidate,
  downloadStream,
  FakeDownloadResolver,
  type FakeFxmDownloads,
  FakeMediaServer,
  FakeNetwork,
  testBytes,
} from '@fxm/downloads/testing'
import { useSettingsStore } from '../settings/settings-store'
import type { DownloadEnvironment } from './environment'
import { getDownloads, resetDownloads, startDownloads } from './runtime'

/** What each tier lets downloads reach. */
export const TIERS = {
  free: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  lite: { youtube: 'simple', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  full: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
} satisfies Record<string, NetworkCapabilities>

/** The URL the fake resolver hands out for `track` on call `n`. */
export function fakeMediaUrl(track: Track, call: number): string {
  return `https://media.test/${encodeURIComponent(downloadCandidate(track).ref)}?n=${call}`
}

/** Options for {@link setupDownloads}. */
export interface SetupDownloadsOptions {
  /** The tier. Default: `full`. */
  tier?: keyof typeof TIERS
  /** Whether to run the queue in this "tab". Default: true. */
  run?: boolean
  /** Whether the browser can store downloads. Default: true. */
  supported?: boolean
  /**
   * Whether FXM runs in the Android app: the downloads then go to the app's own storage through
   * a fake `FxmDownloads` plugin (`plugin` in the result), not to the memory storage.
   */
  android?: boolean
}

/**
 * Makes the app's downloads use fakes, and runs the queue. Every track a test downloads gets a
 * file of 3000 bytes unless {@link serve} says otherwise. The test setup resets the downloads
 * after each test.
 */
export async function setupDownloads(options: SetupDownloadsOptions = {}) {
  const server = new FakeMediaServer({ pieceBytes: 512 })
  const storage: MemoryDownloadStorage = createMemoryDownloadStorage()
  const sizes = new Map<string, number>()
  const listeners = new Set<() => void>()
  let capabilities: NetworkCapabilities = TIERS[options.tier ?? 'full']
  const resolver = new FakeDownloadResolver((track, _request, call) => {
    const url = fakeMediaUrl(track, call)
    server.add(url, testBytes(sizes.get(track.id) ?? 3000, call))
    return { candidate: downloadCandidate(track), stream: downloadStream(url) }
  })
  const environment: DownloadEnvironment = {
    context: (): ProviderContext => ({
      fetch: server.fetch,
      platform: 'web',
      capabilities,
      mode: useSettingsStore.getState().catalogMode,
    }),
    resolver,
    subscribe: (listener) => {
      listeners.add(listener)
      const stop = useSettingsStore.subscribe(listener)
      return () => {
        listeners.delete(listener)
        stop()
      }
    },
  }
  const plugin: FakeFxmDownloads | undefined = options.android
    ? createFakeFxmDownloads()
    : undefined
  // In the Android app a network the test switches; in a browser the browser's own.
  const network = plugin === undefined ? undefined : new FakeNetwork()
  await resetDownloads({
    environment,
    ...(plugin === undefined
      ? { storage, supported: options.supported ?? true, plugin: null }
      : { plugin }),
    ...(network === undefined ? {} : { network }),
    manager: { chunkBytes: 1024, retryDelaysMs: [1], progressIntervalMs: 0 },
  })
  if (options.run !== false) startDownloads()
  return {
    server,
    /** The memory storage, outside the Android app. */
    storage,
    /** The fake `FxmDownloads` plugin, in the Android app. */
    plugin,
    /** The network the test switches, in the Android app. */
    network,
    resolver,
    downloads: getDownloads(),
    /** Gives `track`'s file `size` bytes. */
    serve(track: Track, size: number) {
      sizes.set(track.id, size)
    },
    /** Switches the tier, e.g. when FXM Connect goes away. */
    setTier(tier: keyof typeof TIERS) {
      capabilities = TIERS[tier]
      for (const listener of [...listeners]) listener()
    },
  }
}
