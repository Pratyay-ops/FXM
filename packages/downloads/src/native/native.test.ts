import { formatId } from '@fxm/core'
import { NativeEngine } from '@fxm/player'
import { createFakeFxmPlayer, testTrack } from '@fxm/player/testing'
import { describe, expect, it, vi } from 'vitest'
import * as downloads from '../index'
import { createOfflineStore } from '../offline'
import { isStorageFullError, isStorageUnavailableError } from '../storage'
import { archiveFile, mediaUrl, setup, song } from '../test-harness'
import { createFakeFxmDownloads, FAKE_DOWNLOADS_FOLDER } from '../testing/fake-fxm-downloads'
import { downloadCandidate, downloadStream } from '../testing/fake-resolver'
import { testBytes } from '../testing/fake-server'
import * as testing from '../testing/index'
import { downloadId } from '../types'
import { connectBackgroundDownloads } from './background'
import { canExportToMusic, exportDownloadToMusic } from './export'
import { findFxmDownloadsPlugin, fxmDownloadsErrorCode } from './plugin'
import { createNativeDownloadStorage, nativeStorageError } from './storage'

const ORIGIN = 'https://localhost'
const bytes = (...values: number[]) => new Uint8Array(values)

/** A manager over the Android app's storage (a fake plugin), as the app builds it. */
function android(options: Parameters<typeof setup>[0] = {}) {
  const plugin = createFakeFxmDownloads()
  const storage = createNativeDownloadStorage({ plugin, origin: ORIGIN })
  return { plugin, ...setup({ storage, ...options }) }
}

describe('the Android download storage', () => {
  it('writes, truncates, flushes and reads a file in the app’s storage', async () => {
    const plugin = createFakeFxmDownloads()
    const storage = createNativeDownloadStorage({ plugin, origin: ORIGIN })
    expect(await storage.probe()).toBe(true)
    const writer = await storage.open('a-1')
    expect(await writer.size()).toBe(0)
    await writer.write(0, bytes(1, 2, 3))
    await writer.write(5, bytes(9))
    expect(await writer.size()).toBe(6)
    expect(plugin.files.get('a-1')).toEqual(bytes(1, 2, 3, 0, 0, 9))
    await writer.truncate(4)
    await writer.flush()
    await writer.close()
    await writer.close()
    await expect(writer.write(0, bytes(1))).rejects.toMatchObject({ name: 'InvalidStateError' })
    expect(await storage.size('a-1')).toBe(4)
    expect(await storage.size('b')).toBeUndefined()
    expect(await storage.list()).toEqual(['a-1'])
    const blob = await storage.read('a-1', 'audio/flac')
    expect(blob?.type).toBe('audio/flac')
    expect(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      bytes(1, 2, 3, 0),
    )
    expect(await storage.read('b', 'audio/flac')).toBeUndefined()
  })

  it('reads a large file in chunks the bridge can carry', async () => {
    const plugin = createFakeFxmDownloads()
    const storage = createNativeDownloadStorage({ plugin, origin: ORIGIN })
    const content = testBytes(2.5 * 1024 * 1024)
    plugin.files.set('big', content)
    const read = vi.spyOn(plugin, 'read')
    const blob = await storage.read('big', 'audio/webm')
    // Compared in a loop: a deep comparison of megabytes takes seconds.
    const back = new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))
    expect(back.length).toBe(content.length)
    expect(back.every((byte, index) => byte === content[index])).toBe(true)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('plays a file from its WebView URL, which the native engine maps back to the file', async () => {
    const plugin = createFakeFxmDownloads()
    const storage = createNativeDownloadStorage({ plugin, origin: ORIGIN })
    plugin.files.set('a-1', bytes(1))
    const url = await storage.playbackUrl('a-1', 'audio/webm')
    expect(url).toBe(`${ORIGIN}/_capacitor_file_${FAKE_DOWNLOADS_FOLDER}/a-1`)
    // The same file keeps its URL; a file that's gone has none.
    expect(await storage.playbackUrl('a-1', 'audio/webm')).toBe(url)
    expect(await storage.playbackUrl('gone', 'audio/webm')).toBeUndefined()
    // Without a page the file's own URI, which only the native engine plays.
    const pageless = createNativeDownloadStorage({ plugin, origin: null })
    expect(await pageless.playbackUrl('a-1', 'audio/webm')).toBe(
      `file://${FAKE_DOWNLOADS_FOLDER}/a-1`,
    )
  })

  it('refuses names the manager never gives before it calls the plugin', async () => {
    const plugin = createFakeFxmDownloads()
    const open = vi.spyOn(plugin, 'open')
    const storage = createNativeDownloadStorage({ plugin, origin: ORIGIN })
    await expect(storage.open('../escape')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.remove('a.b')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.playbackUrl('con', 'audio/webm')).rejects.toBeInstanceOf(TypeError)
    expect(open).not.toHaveBeenCalled()
    plugin.files.set('odd name', bytes(1))
    plugin.files.set('fine', bytes(1))
    expect(await storage.list()).toEqual(['fine'])
  })

  it('speaks the storage errors the manager acts on', async () => {
    const plugin = createFakeFxmDownloads()
    const storage = createNativeDownloadStorage({ plugin, origin: ORIGIN })
    const writer = await storage.open('a')
    await expect(storage.open('a')).rejects.toMatchObject({ name: 'NoModificationAllowedError' })
    await expect(storage.remove('a')).rejects.toMatchObject({ name: 'NoModificationAllowedError' })
    plugin.freeBytes = 2
    const full = await writer.write(0, bytes(1, 2, 3)).catch((error: unknown) => error)
    expect(isStorageFullError(full)).toBe(true)
    plugin.failNext('write', 'UNAVAILABLE')
    expect(
      isStorageUnavailableError(await writer.write(0, bytes(1)).catch((e: unknown) => e)),
    ).toBe(true)
    plugin.failNext('flush', 'IO')
    const passing = await writer.flush().catch((error: unknown) => error)
    expect(passing).toBeInstanceOf(Error)
    expect(isStorageFullError(passing) || isStorageUnavailableError(passing)).toBe(false)
    // An answer without the plugin's code: the bridge has no such plugin.
    expect(isStorageUnavailableError(nativeStorageError(new Error('not implemented')))).toBe(true)
    expect(nativeStorageError(Object.assign(new Error('x'), { code: 'NOT_FOUND' }))).toMatchObject({
      name: 'NotFoundError',
    })
  })

  it('settles every call, also one the app never answers', async () => {
    vi.useFakeTimers()
    try {
      const plugin = createFakeFxmDownloads()
      const storage = createNativeDownloadStorage({ plugin, origin: ORIGIN, timeoutMs: 1000 })
      plugin.hold('list')
      const listing = storage.list().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1000)
      expect(isStorageUnavailableError(await listing)).toBe(true)
      plugin.hold('info')
      const probe = storage.probe()
      await vi.advanceTimersByTimeAsync(1000)
      expect(await probe).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('downloads in the Android app', () => {
  it('fetch through the platform and land in the app’s storage, playing offline from there', async () => {
    const h = android()
    const track = song('a')
    const content = h.serve(track, 5000)
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    const record = await h.record(track)
    expect(record).toMatchObject({ status: 'completed', file: 'file-1' })
    expect(h.plugin.files.get('file-1')).toEqual(content)
    expect(h.plugin.openFiles.size).toBe(0)
    // The policy plays the copy from the device, and Media3 can play it.
    const offline = createOfflineStore({ store: h.store, storage: h.storage })
    const stream = await offline.find(track, h.context())
    expect(stream?.url).toBe(`${ORIGIN}/_capacitor_file_${FAKE_DOWNLOADS_FOLDER}/file-1`)
    const engine = new NativeEngine({ plugin: createFakeFxmPlayer(), origin: ORIGIN })
    expect(stream === undefined ? 'no' : engine.canPlay(stream)).toBe('probably')
    engine.destroy()
  })

  it('download only YouTube URLs that passed the end-of-file probe, as on the web', async () => {
    const h = android({ maxRefreshes: 0 })
    const track = song('a')
    h.serve(track, 1000)
    h.resolver.handler = (_track, _request, call) => ({
      candidate: downloadCandidate(track),
      stream: downloadStream(mediaUrl(track, call), { fullLength: 'unverified' }),
    })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'failed', error: { code: 'unverified' } })
    expect(h.server.requests).toHaveLength(0)
    expect(h.plugin.files.size).toBe(0)
  })

  it('resolve afresh when a URL is refused or about to expire, and continue the same file', async () => {
    const h = android({ retryDelaysMs: [1] })
    const track = song('a')
    const content = h.serve(track, 5000)
    // The first URL is refused past 3000 bytes: a fresh one continues where the file ends.
    h.server.rule(mediaUrl(track, 1), { capAt: 3000 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'completed' })
    expect(h.plugin.files.get('file-1')).toEqual(content)
    expect(h.resolver.reasonsFor(track)).toEqual(['start', 'refresh'])
    // A URL about to expire is not used again after a break: the next attempt resolves first.
    const other = song('b')
    const second = h.serve(other, 3000)
    const calls = h.resolver.calls.length
    h.resolver.handler = (_track, _request, call) => {
      h.server.add(mediaUrl(other, call), second)
      return {
        candidate: downloadCandidate(other),
        stream: downloadStream(mediaUrl(other, call), { expiresAt: Date.now() + 30_000 }),
      }
    }
    h.server.rule(mediaUrl(other, calls + 1), { breakAt: 1500 })
    await h.manager.enqueue(other)
    await h.manager.idle()
    expect(await h.record(other)).toMatchObject({ status: 'completed', file: 'file-2' })
    expect(h.plugin.files.get('file-2')).toEqual(second)
    expect(h.resolver.calls.length - calls).toBe(2)
  })

  it('pause the queue when the phone is full', async () => {
    const h = android({ concurrency: 1 })
    const a = archiveFile('a')
    const b = archiveFile('b')
    h.serve(a, 3000)
    h.serve(b, 3000)
    h.plugin.freeBytes = 1000
    await h.manager.start()
    await h.manager.enqueueAll([a, b])
    await h.manager.idle()
    expect(await h.record(a)).toMatchObject({ status: 'failed', error: { code: 'storage-full' } })
    expect(await h.record(b)).toMatchObject({ status: 'paused', error: { code: 'storage-full' } })
  })

  it('keep the app running while the queue has work, and let it go after', async () => {
    const h = android()
    const track = song('a')
    h.serve(track, 3000)
    const stop = connectBackgroundDownloads({
      plugin: h.plugin,
      store: h.store,
      network: h.network,
    })
    await vi.waitFor(() => expect(h.plugin.reports).toHaveLength(1))
    expect(h.plugin.reports[0]).toEqual({ downloading: 0, queued: 0, online: true })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    await vi.waitFor(() =>
      expect(h.plugin.reports.at(-1)).toEqual({ downloading: 0, queued: 0, online: true }),
    )
    // While it downloaded, the service knew which song.
    expect(h.plugin.reports).toContainEqual({ downloading: 1, queued: 0, online: true, title: 'a' })
    // Repeated states are not reported twice.
    const count = h.plugin.reports.length
    await h.store.update(downloadId(track), (record) => record)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.plugin.reports).toHaveLength(count)
    stop()
    stop()
    expect(h.plugin.reports).toHaveLength(count)
  })

  it('report a queue that waits for the network, and an empty one when they stop', async () => {
    const h = android()
    const track = song('a')
    h.serve(track, 3000)
    h.network.set(false)
    await h.manager.start()
    await h.manager.enqueue(track)
    const stop = connectBackgroundDownloads({
      plugin: h.plugin,
      store: h.store,
      network: h.network,
    })
    await vi.waitFor(() =>
      expect(h.plugin.reports.at(-1)).toEqual({ downloading: 0, queued: 1, online: false }),
    )
    stop()
    await vi.waitFor(() =>
      expect(h.plugin.reports.at(-1)).toEqual({ downloading: 0, queued: 0, online: false }),
    )
  })
})

describe('saving a download to Music', () => {
  it('copies a finished song to Music/FXM, named after it', async () => {
    const h = android()
    const track = testTrack('Creep', {
      artists: [{ name: 'Radiohead' }],
      album: { id: formatId('ytm', 'album', 'x'), name: 'Pablo Honey' },
    })
    const content = h.serve(track, 2000)
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    const record = await h.record(track)
    if (record === undefined) throw new Error('no record')
    expect(canExportToMusic(record)).toBe(true)
    expect(await exportDownloadToMusic(h.plugin, record)).toEqual({
      uri: 'content://media/external_primary/audio/media/1',
      path: 'Music/FXM/Radiohead - Creep',
    })
    expect(h.plugin.exports[0]).toMatchObject({
      file: 'file-1',
      codec: 'opus',
      container: 'webm',
      media: 'audio',
      title: 'Creep',
      artists: ['Radiohead'],
      album: 'Pablo Honey',
      bytes: content,
    })
  })

  it('refuses a video file, and says why a copy failed', async () => {
    const h = android()
    const track = song('a')
    const content = testBytes(1000)
    h.resolver.handler = (_track, _request, call) => {
      h.server.add(mediaUrl(track, call), content)
      return {
        candidate: downloadCandidate(track),
        stream: downloadStream(mediaUrl(track, call), {
          codec: 'aac',
          container: 'mp4',
          media: 'muxed-video',
        }),
      }
    }
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    const video = await h.record(track)
    if (video?.format === undefined) throw new Error('no record')
    expect(video.status).toBe('completed')
    expect(canExportToMusic(video)).toBe(false)
    await expect(exportDownloadToMusic(h.plugin, video)).rejects.toMatchObject({
      code: 'Unsupported',
      message: expect.stringContaining('video file'),
    })
    expect(h.plugin.exports).toHaveLength(0)
    const audio = { ...video, format: { ...video.format, media: 'audio' as const } }
    h.plugin.refuseMusicFolder = true
    await expect(exportDownloadToMusic(h.plugin, audio)).rejects.toMatchObject({
      code: 'AuthRequired',
    })
    h.plugin.refuseMusicFolder = false
    h.plugin.failNext('exportToMusic', 'NO_SPACE')
    await expect(exportDownloadToMusic(h.plugin, audio)).rejects.toMatchObject({
      code: 'Unavailable',
      message: 'There is no room left on this device',
    })
    h.plugin.files.clear()
    await expect(exportDownloadToMusic(h.plugin, audio)).rejects.toMatchObject({ code: 'NotFound' })
    await expect(
      exportDownloadToMusic(h.plugin, { ...audio, status: 'downloading' }),
    ).rejects.toMatchObject({ code: 'Unsupported' })
  })
})

describe('the FxmDownloads plugin', () => {
  it('is found only in the Android app, with all its methods', () => {
    const plugin = createFakeFxmDownloads()
    const android = {
      Capacitor: { isNativePlatform: () => true, Plugins: { FxmDownloads: plugin } },
    }
    expect(findFxmDownloadsPlugin(android)).toBe(plugin)
    expect(findFxmDownloadsPlugin({})).toBeUndefined()
    expect(
      findFxmDownloadsPlugin({
        Capacitor: { isNativePlatform: () => false, Plugins: { FxmDownloads: plugin } },
      }),
    ).toBeUndefined()
    const { exportToMusic: _export, ...partial } = plugin
    expect(
      findFxmDownloadsPlugin({
        Capacitor: { isNativePlatform: () => true, Plugins: { FxmDownloads: partial } },
      }),
    ).toBeUndefined()
    expect(fxmDownloadsErrorCode(Object.assign(new Error('x'), { code: 'BUSY' }))).toBe('BUSY')
    expect(fxmDownloadsErrorCode(Object.assign(new Error('x'), { code: 'NOPE' }))).toBeUndefined()
  })

  it('and its storage are exported, with the fake under @fxm/downloads/testing', () => {
    for (const name of [
      'createNativeDownloadStorage',
      'connectBackgroundDownloads',
      'exportDownloadToMusic',
      'canExportToMusic',
      'findFxmDownloadsPlugin',
      'FXM_DOWNLOADS_PLUGIN',
      'FXM_DOWNLOADS_ERROR_CODES',
    ]) {
      expect(downloads).toHaveProperty(name)
    }
    expect(testing).toHaveProperty('createFakeFxmDownloads')
  })
})
