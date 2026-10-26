import { entityKey, formatId, playbackProblemOf } from '@fxm/core'
import { createMemoryDownloadStorage, downloadId, newDownloadRecord } from '@fxm/downloads'
import { testContext } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { DOWNLOADS_PLAYLIST_ID } from '../../db/types'
import { track } from '../../test/library-fixtures'
import { useSettingsStore } from '../settings/settings-store'
import {
  browserCanPlay,
  createAppDownloadEnvironment,
  createPendingEnvironment,
  FREE_TIER,
} from './environment'
import {
  browserNetwork,
  getDownloads,
  getOfflineStore,
  RUNNER_LOCK,
  reconcileDownloadsPlaylist,
  resetDownloads,
  startDownloads,
} from './runtime'
import { setupDownloads } from './testing'

async function downloadsOrder(): Promise<string[]> {
  const view = await getLibrary().getPlaylistView(DOWNLOADS_PLAYLIST_ID)
  return view?.rows.map((row) => row.track?.title ?? row.id) ?? []
}

afterEach(() => {
  delete (navigator as { locks?: unknown }).locks
})

describe('the app downloads', () => {
  it('download a track, add it to Downloads, and take it out when deleted', async () => {
    const { downloads, storage } = await setupDownloads()
    await downloads.manager.enqueue(track(1))
    await vi.waitFor(async () => expect(await downloadsOrder()).toEqual(['Song 1']))
    const record = await downloads.manager.get(track(1))
    expect(record).toMatchObject({ status: 'completed', bytesTotal: 3000 })
    expect(storage.bytes(record?.file ?? '')).toHaveLength(3000)
    await downloads.manager.remove(downloadId(track(1)))
    await vi.waitFor(async () => expect(await downloadsOrder()).toEqual([]))
    expect(await storage.list()).toEqual([])
  })

  it('play downloads offline through the offline store', async () => {
    const { downloads } = await setupDownloads()
    await downloads.manager.enqueue(track(1))
    await vi.waitFor(async () =>
      expect((await downloads.manager.get(track(1)))?.status).toBe('completed'),
    )
    const { file } = (await downloads.manager.get(track(1))) ?? {}
    const stream = await getOfflineStore().find(track(1), testContext('free'))
    expect(stream).toMatchObject({ url: `memory:${file}`, fullLength: 'verified', ipBound: false })
  })

  it('add completed downloads the playlist lacks when the queue starts', async () => {
    const { downloads, storage } = await setupDownloads({ run: false })
    await getLibrary().addDownload(track(2))
    const record = {
      ...newDownloadRecord(track(1), 1),
      status: 'completed' as const,
      completedAt: 2,
      file: 'kept',
      bytesDone: 3,
      bytesTotal: 3,
    }
    storage.put('kept', new Uint8Array(3))
    await downloads.store.update(record.id, () => record)
    expect(await reconcileDownloadsPlaylist(downloads.manager, getLibrary())).toBe(1)
    expect(await downloadsOrder()).toEqual(['Song 1', 'Song 2'])
    expect(await reconcileDownloadsPlaylist(downloads.manager, getLibrary())).toBe(0)
    const view = await getLibrary().getPlaylistView(DOWNLOADS_PLAYLIST_ID)
    expect(view?.rows.map((row) => entityKey(row.id))).toContain(record.id)
  })

  it('run the queue in the tab that holds the Web Lock', async () => {
    const requests: string[] = []
    let release: (() => void) | undefined
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (name: string, _options: unknown, callback: () => Promise<void>) => {
          requests.push(name)
          return new Promise<void>((resolve) => {
            release = resolve
            void callback().then(resolve)
          })
        },
      },
    })
    const { downloads } = await setupDownloads({ run: false })
    const stop = startDownloads()
    expect(startDownloads()).toBe(stop)
    await vi.waitFor(() => expect(requests).toEqual([RUNNER_LOCK]))
    await vi.waitFor(() => expect(downloads.manager.running).toBe(true))
    stop()
    await vi.waitFor(() => expect(downloads.manager.running).toBe(false))
    release?.()
  })

  it('offer nothing where the browser cannot store files', async () => {
    await resetDownloads({ supported: false })
    const downloads = getDownloads()
    expect(downloads.support.current).toBe('unsupported')
    expect(await downloads.support.known).toBe(false)
    startDownloads()
    await Promise.resolve()
    expect(downloads.manager.running).toBe(false)
    await expect(downloads.storage.open('x')).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(await downloads.storage.list()).toEqual([])
    expect(await downloads.storage.playbackUrl('x', '')).toBeUndefined()
  })

  it('run the queue only once the storage is known to work', async () => {
    let answer: ((supported: boolean) => void) | undefined
    await resetDownloads({
      storage: createMemoryDownloadStorage(),
      supported: new Promise((resolve) => {
        answer = resolve
      }),
    })
    const downloads = getDownloads()
    expect(downloads.support.current).toBe('checking')
    const heard = vi.fn()
    downloads.support.subscribe(heard)
    startDownloads()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(downloads.manager.running).toBe(false)
    answer?.(true)
    await vi.waitFor(() => expect(downloads.manager.running).toBe(true))
    expect(downloads.support.current).toBe('supported')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('take many deleted downloads out of Downloads in one change', async () => {
    const { downloads } = await setupDownloads()
    const tracks = [track(1), track(2), track(3)]
    await downloads.manager.enqueueAll(tracks)
    await vi.waitFor(async () =>
      expect((await downloadsOrder()).sort()).toEqual(['Song 1', 'Song 2', 'Song 3']),
    )
    const removeDownloads = vi.spyOn(getLibrary(), 'removeDownloads')
    await downloads.manager.removeMany(tracks.map(downloadId))
    await vi.waitFor(async () => expect(await downloadsOrder()).toEqual([]))
    expect(removeDownloads).toHaveBeenCalledTimes(1)
    expect(removeDownloads.mock.calls[0]?.[0]).toHaveLength(3)
  })
})

describe('the browser network', () => {
  it("follows the browser's online state", () => {
    const network = browserNetwork()
    const listener = vi.fn()
    const stop = network.subscribe(listener)
    expect(network.online).toBe(true)
    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    window.dispatchEvent(new Event('online'))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('the pending environment', () => {
  it('reaches only free sources, and follows the catalog mode', async () => {
    const environment = createAppDownloadEnvironment()
    expect(environment.context()).toMatchObject({
      platform: 'web',
      capabilities: FREE_TIER,
      mode: 'music',
    })
    const listener = vi.fn()
    const stop = environment.subscribe(listener)
    useSettingsStore.getState().setCatalogMode('all')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(environment.context().mode).toBe('all')
    useSettingsStore.getState().setTheme('light')
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    // No sources yet: nothing resolves.
    const error = await environment.resolver
      .resolve(track(1), {
        ctx: { ...environment.context(), capabilities: { ...FREE_TIER } },
        prefs: {
          streaming: { wifi: 'high', cellular: 'normal' },
          download: { format: 'original' },
        },
        reason: 'start',
        attempt: 0,
        exclude: new Set(),
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught)
    expect(playbackProblemOf(error)).toMatchObject({ type: 'unavailable', reason: 'no-source' })
  })

  it('offers nothing it would fail to download, Internet Archive and Jamendo included', () => {
    const environment = createPendingEnvironment()
    const archive = {
      ...track(1),
      id: formatId('archive', 'track', 'item/a.flac'),
      source: 'archive' as const,
    }
    expect(environment.resolver.canResolve?.(archive)).toBe(false)
    expect(environment.resolver.canResolve?.(track(1))).toBe(false)
  })

  it("asks the browser whether it plays a stream's format", () => {
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType')
    canPlayType.mockReturnValue('probably')
    expect(browserCanPlay({ codec: 'opus', container: 'webm' })).toBe('probably')
    canPlayType.mockReturnValue('')
    expect(browserCanPlay({ codec: 'aac', container: 'm4a' })).toBe('no')
    // A codec the container can't hold has no MIME type to ask about.
    expect(browserCanPlay({ codec: 'flac', container: 'webm' })).toBe('maybe')
  })
})
