/**
 * The setup the manager tests share: a download manager over an in-memory store and storage, a
 * fake media server as the network, and a fake resolver. Not exported from the package.
 *
 * @module
 */

import { formatId, type NetworkCapabilities, type ProviderContext, type Track } from '@fxm/core'
import { TEST_CAPABILITIES, testTrack } from '@fxm/player/testing'
import { DownloadManager, type DownloadManagerOptions } from './manager'
import { createMemoryDownloadStorage } from './storage'
import { createMemoryDownloadStore } from './store'
import { FakeNetwork } from './testing/fake-network'
import { downloadCandidate, downloadStream, FakeDownloadResolver } from './testing/fake-resolver'
import { FakeMediaServer, testBytes } from './testing/fake-server'
import { type DownloadRecord, downloadId } from './types'

/** The fake clock's start: 2026-10-26, midnight UTC. */
export const START = Date.UTC(2026, 9, 26)

/** The chunk size the tests use: small, so a file takes several requests. */
export const CHUNK = 1024

/** Options for {@link setup}. */
export interface HarnessOptions extends Partial<Omit<DownloadManagerOptions, 'context'>> {
  /** The tier. Default: `full`. */
  tier?: keyof typeof TEST_CAPABILITIES
  /** Records the store starts with. */
  records?: DownloadRecord[]
  /** The media server's piece size. Default: 256 bytes. */
  pieceBytes?: number
}

/** The URL the default resolver hands out for `track` on call `n`. */
export function mediaUrl(track: Track, call: number): string {
  return `https://media.test/${encodeURIComponent(downloadCandidate(track).ref)}?n=${call}`
}

/**
 * Builds a manager with fakes. The resolver hands out `https://media.test/<ref>?n=<call>`, and
 * {@link serve} puts a file behind every URL of a track, so fresh resolutions keep working.
 */
export function setup(options: HarnessOptions = {}) {
  const { tier = 'full', records = [], pieceBytes = 256, ...overrides } = options
  const server = new FakeMediaServer({ pieceBytes })
  const store = overrides.store ?? createMemoryDownloadStore(records)
  const storage = overrides.storage ?? createMemoryDownloadStorage()
  const resolver = new FakeDownloadResolver()
  const network = new FakeNetwork()
  let capabilities: NetworkCapabilities = TEST_CAPABILITIES[tier]
  let names = 0
  // Offline, every request fails without an answer, as a browser's does.
  const fetchOnline: typeof fetch = (input, init) =>
    network.online ? server.fetch(input, init) : Promise.reject(new TypeError('Failed to fetch'))
  const context = (): ProviderContext => ({
    fetch: fetchOnline,
    platform: 'web',
    capabilities,
    mode: 'music',
  })
  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  // Every URL of a served track answers with its file, whatever the call number.
  const serveFor = (track: Track, bytes: Uint8Array<ArrayBuffer>, call: number) => {
    server.add(mediaUrl(track, call), bytes)
  }
  resolver.handler = (track, _request, call) => {
    const bytes = files.get(track.id)
    if (bytes !== undefined) serveFor(track, bytes, call)
    return { candidate: downloadCandidate(track), stream: downloadStream(mediaUrl(track, call)) }
  }
  const manager = new DownloadManager({
    store,
    storage,
    resolver,
    network,
    context,
    chunkBytes: CHUNK,
    createFileName: () => {
      names += 1
      return `file-${names}`
    },
    ...overrides,
  })
  return {
    manager,
    store,
    storage: storage as ReturnType<typeof createMemoryDownloadStorage>,
    server,
    resolver,
    network,
    context,
    /** Serves a file of `size` bytes (or these bytes) for `track`, and returns its bytes. */
    serve(track: Track, size: number | Uint8Array<ArrayBuffer> = 5000): Uint8Array<ArrayBuffer> {
      const bytes = typeof size === 'number' ? testBytes(size, track.title.length) : size
      files.set(track.id, bytes)
      return bytes
    },
    /** Switches the tier, e.g. when FXM Connect goes away. */
    setTier(next: keyof typeof TEST_CAPABILITIES) {
      capabilities = TEST_CAPABILITIES[next]
    },
    /** The record of `track`, straight from the store (removing ones included). */
    async record(track: Track): Promise<DownloadRecord | undefined> {
      return store.get(downloadId(track))
    },
  }
}

/** A YouTube Music song called `name`. */
export function song(name: string): Track {
  return testTrack(name)
}

/** An Internet Archive file called `name`, whose download never needs YouTube. */
export function archiveFile(name: string): Track {
  return testTrack(name, {
    id: formatId('archive', 'track', `item/${name}.flac`),
    source: 'archive',
  })
}
