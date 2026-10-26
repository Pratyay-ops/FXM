import { formatId } from '@fxm/core'
import {
  createMemoryDownloadStore,
  DownloadManager,
  isStorageFullError,
  isStorageUnavailableError,
} from '@fxm/downloads'
import { FakeDownloadResolver, FakeMediaServer, testBytes } from '@fxm/downloads/testing'
import { TEST_CAPABILITIES, testTrack } from '@fxm/player/testing'
import { describe, expect, it, vi } from 'vitest'
import { FakeDirectory } from './fake-opfs'
import { createOpfsHandler } from './handler'
import type { OpfsAnswer, OpfsMessage, OpfsRequest } from './protocol'
import {
  createOpfsStorage,
  createWorkerChannel,
  headroomBytes,
  type OpfsChannel,
  ROOM_CHECK_BYTES,
  type StorageRoom,
  safeMediaType,
  type WorkerLike,
} from './storage'

function setup(options: { estimate?: () => Promise<StorageRoom | undefined> } = {}) {
  const root = new FakeDirectory()
  const handle = createOpfsHandler(() => root.getDirectoryHandle('downloads', { create: true }))
  // The worker's handler, run in-process.
  const requests: OpfsRequest[] = []
  const channel: OpfsChannel = {
    request: (request) => {
      requests.push(request)
      return handle(request).catch((error: Error) => {
        throw new DOMException(error.message, error.name)
      })
    },
  }
  let urls = 0
  const revoked: string[] = []
  const blobs: Blob[] = []
  const storage = createOpfsStorage({
    channel,
    root: async () => root,
    createUrl: (blob) => {
      blobs.push(blob)
      urls += 1
      return `blob:fxm/${urls}`
    },
    revokeUrl: (url) => revoked.push(url),
    ...options,
  })
  const folder = () => root.folders.get('downloads')
  return { root, handle, storage, revoked, folder, requests, blobs }
}

const bytes = (...values: number[]) => new Uint8Array(values)

describe('the OPFS worker', () => {
  it('writes files in place through sync access handles', async () => {
    const { handle, folder } = setup()
    expect(await handle({ op: 'open', file: 'a' })).toBe(0)
    expect(await handle({ op: 'write', file: 'a', offset: 0, data: bytes(1, 2, 3).buffer })).toBe(3)
    expect(await handle({ op: 'write', file: 'a', offset: 5, data: bytes(9).buffer })).toBe(1)
    expect(await handle({ op: 'size', file: 'a' })).toBe(6)
    await handle({ op: 'truncate', file: 'a', size: 2 })
    await handle({ op: 'flush', file: 'a' })
    expect(folder()?.files.get('a')?.locked).toBe(true)
    await handle({ op: 'close', file: 'a' })
    await handle({ op: 'close', file: 'a' })
    expect(folder()?.files.get('a')).toMatchObject({ bytes: bytes(1, 2), locked: false })
    // Reopening continues where the file ends.
    expect(await handle({ op: 'open', file: 'a' })).toBe(2)
  })

  it('refuses a file that is not open, or open already', async () => {
    const { handle } = setup()
    await expect(handle({ op: 'size', file: 'a' })).rejects.toMatchObject({
      name: 'InvalidStateError',
    })
    await handle({ op: 'open', file: 'a' })
    await expect(handle({ op: 'open', file: 'a' })).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
    })
  })

  it('lets go of an open file before removing it, and ignores a missing one', async () => {
    const { handle, folder } = setup()
    await handle({ op: 'open', file: 'a' })
    await handle({ op: 'remove', file: 'a' })
    expect(folder()?.files.has('a')).toBe(false)
    await handle({ op: 'remove', file: 'a' })
  })

  it('reports a full storage', async () => {
    const { root, handle } = setup()
    root.quotaBytes = 2
    await handle({ op: 'open', file: 'a' })
    await expect(
      handle({ op: 'write', file: 'a', offset: 0, data: bytes(1, 2, 3).buffer }),
    ).rejects.toMatchObject({ name: 'QuotaExceededError' })
  })

  it('answers a probe: the folder is there, and so are sync access handles', async () => {
    const { handle } = setup()
    expect(await handle({ op: 'probe' })).toBe(1)
    const root = new FakeDirectory()
    const old = createOpfsHandler(() => root.getDirectoryHandle('downloads', { create: true }), {
      canSyncAccess: () => false,
    })
    expect(await old({ op: 'probe' })).toBe(0)
    const refused = createOpfsHandler(() =>
      Promise.reject(new DOMException('private window', 'SecurityError')),
    )
    await expect(refused({ op: 'probe' })).rejects.toMatchObject({ name: 'SecurityError' })
  })

  it('refuses a file name that could be a path before touching the folder', async () => {
    const { handle, folder } = setup()
    for (const op of ['open', 'size', 'flush', 'close', 'remove'] as const) {
      await expect(handle({ op, file: '../x' })).rejects.toBeInstanceOf(TypeError)
    }
    expect(folder()).toBeUndefined()
  })

  it('says when the browser has no sync access handles', async () => {
    const root = new FakeDirectory()
    const handle = createOpfsHandler(async () => ({
      ...root,
      getFileHandle: async () => ({ getFile: async () => new File([], 'a') }),
      getDirectoryHandle: root.getDirectoryHandle.bind(root),
      removeEntry: root.removeEntry.bind(root),
      keys: root.keys.bind(root),
    }))
    await expect(handle({ op: 'open', file: 'a' })).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
  })
})

describe('the OPFS storage', () => {
  it('writes through the worker and reads on the page', async () => {
    const { storage } = setup()
    const writer = await storage.open('a')
    await writer.write(0, bytes(1, 2, 3, 4))
    expect(await writer.size()).toBe(4)
    await writer.truncate(3)
    await writer.flush()
    await writer.close()
    await writer.close()
    expect(await storage.list()).toEqual(['a'])
    expect(await storage.size('a')).toBe(3)
    expect(await storage.size('missing')).toBeUndefined()
    const blob = await storage.read('a', 'audio/webm')
    expect(blob?.type).toBe('audio/webm')
    expect(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      bytes(1, 2, 3),
    )
    expect(await storage.read('missing', '')).toBeUndefined()
  })

  it('keeps one playback URL per file until the file is removed', async () => {
    const { storage, revoked } = setup()
    const writer = await storage.open('a')
    await writer.write(0, bytes(1))
    await writer.close()
    const [first, second] = await Promise.all([
      storage.playbackUrl('a', 'audio/webm'),
      storage.playbackUrl('a', 'audio/webm'),
    ])
    expect(first).toBe('blob:fxm/1')
    expect(second).toBe('blob:fxm/1')
    expect(await storage.playbackUrl('missing', 'audio/webm')).toBeUndefined()
    await storage.remove('a')
    expect(revoked).toEqual(['blob:fxm/1'])
    expect(await storage.list()).toEqual([])
    await storage.remove('a')
  })

  it("passes on the worker's errors by name", async () => {
    const { storage, folder } = setup()
    const writer = await storage.open('a')
    const downloads = folder()
    if (downloads === undefined) throw new Error('The storage made no downloads folder')
    downloads.quotaBytes = 1
    await expect(writer.write(0, bytes(1, 2))).rejects.toMatchObject({ name: 'QuotaExceededError' })
  })

  it('refuses a file name that could be a path', async () => {
    const { storage, requests } = setup()
    await expect(storage.open('../../x')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.remove('a/b')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.size('..')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.read('a.webm', 'audio/webm')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.playbackUrl('CON', 'audio/webm')).rejects.toBeInstanceOf(TypeError)
    expect(requests).toEqual([])
  })

  it('serves files only as media, never as a type a browser renders as a page', async () => {
    const { storage, blobs } = setup()
    const writer = await storage.open('a')
    await writer.write(0, bytes(1, 2))
    await writer.close()
    expect((await storage.read('a', 'audio/webm; codecs="opus"'))?.type).toBe(
      'audio/webm; codecs="opus"',
    )
    expect((await storage.read('a', 'text/html'))?.type).toBe('application/octet-stream')
    expect((await storage.read('a', ''))?.type).toBe('application/octet-stream')
    await storage.playbackUrl('a', 'image/svg+xml')
    expect(blobs[0]?.type).toBe('application/octet-stream')
    for (const type of ['audio/mpeg', 'audio/mp4; codecs="mp4a.40.2"', 'video/mp4', 'video/webm']) {
      expect(safeMediaType(type)).toBe(type)
    }
    for (const type of ['text/plain', 'application/xhtml+xml', 'video/x-unknown', 'audio/']) {
      expect(safeMediaType(type)).toBe('application/octet-stream')
    }
  })

  it('keeps room for the rest of FXM: a file opens, and writes go on, only while there is', async () => {
    const quota = 10 * 1000 * 1000 * 1000
    let usage = quota - headroomBytes(quota) - 1
    const { storage } = setup({ estimate: async () => ({ usage, quota }) })
    const writer = await storage.open('a')
    // The room is checked again after every few megabytes written.
    usage = quota - headroomBytes(quota) + 1
    await writer.write(0, new Uint8Array(ROOM_CHECK_BYTES - 1))
    const failure = await writer
      .write(ROOM_CHECK_BYTES - 1, new Uint8Array(1))
      .catch((error: unknown) => error)
    expect(isStorageFullError(failure)).toBe(true)
    await writer.close()
    await expect(storage.open('b')).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(headroomBytes(1_000_000_000)).toBe(100_000_000)
    expect(headroomBytes(100_000_000_000)).toBe(200_000_000)
  })

  it('writes on when the browser says nothing about its quota', async () => {
    const { storage } = setup({ estimate: async () => undefined })
    const writer = await storage.open('a')
    await writer.write(0, bytes(1))
    await writer.close()
    const failing = setup({ estimate: () => Promise.reject(new Error('no')) })
    await (await failing.storage.open('a')).close()
  })

  it('finds out whether this browser can keep downloads', async () => {
    const { storage } = setup()
    expect(await storage.probe()).toBe(true)
    const root = new FakeDirectory()
    const noSyncAccess = createOpfsHandler(
      () => root.getDirectoryHandle('downloads', { create: true }),
      { canSyncAccess: () => false },
    )
    const old = createOpfsStorage({
      channel: { request: (request) => noSyncAccess(request) },
      root: async () => root,
    })
    expect(await old.probe()).toBe(false)
    // A private window that refuses the folder.
    const refused = createOpfsStorage({
      channel: { request: async () => 1 },
      root: () => Promise.reject(new DOMException('private window', 'SecurityError')),
    })
    expect(await refused.probe()).toBe(false)
    // A worker that never starts.
    const broken = createOpfsStorage({
      channel: { request: () => Promise.reject(new DOMException('gone', 'NotSupportedError')) },
      root: async () => root,
    })
    expect(await broken.probe()).toBe(false)
  })

  it('tries the folder again after the browser refused it', async () => {
    const root = new FakeDirectory()
    let refuse = true
    const storage = createOpfsStorage({
      channel: { request: async () => undefined },
      root: async () => {
        if (refuse) throw new DOMException('private window', 'SecurityError')
        return root
      },
    })
    await expect(storage.list()).rejects.toMatchObject({ name: 'SecurityError' })
    refuse = false
    expect(await storage.list()).toEqual([])
  })
})

/** A worker that runs the handler and answers in a later task, like a real one. */
function fakeWorker(handle: (request: OpfsRequest) => Promise<number | undefined>) {
  const listeners: {
    message: ((event: MessageEvent<OpfsAnswer>) => void)[]
    error: (() => void)[]
    messageerror: (() => void)[]
  } = {
    message: [],
    error: [],
    messageerror: [],
  }
  const posted: { message: OpfsMessage; transfer: Transferable[] }[] = []
  let terminated = false
  const worker: WorkerLike & {
    fail(type?: 'error' | 'messageerror'): void
    readonly terminated: boolean
  } = {
    postMessage(message, transfer) {
      posted.push({ message, transfer })
      handle(message.request).then(
        (value) =>
          answer({
            id: message.id,
            reply: value === undefined ? { ok: true } : { ok: true, value },
          }),
        (error: Error) =>
          answer({
            id: message.id,
            reply: { ok: false, name: error.name, message: error.message },
          }),
      )
    },
    addEventListener(type: 'message' | 'error' | 'messageerror', listener: never) {
      ;(listeners[type] as unknown[]).push(listener)
    },
    terminate() {
      terminated = true
    },
    get terminated() {
      return terminated
    },
    fail(type = 'error') {
      for (const listener of listeners[type]) listener()
    },
  }
  const answer = (data: OpfsAnswer) =>
    setTimeout(() => {
      if (terminated) return
      for (const listener of listeners.message) listener({ data } as MessageEvent<OpfsAnswer>)
    }, 0)
  return { worker, posted }
}

/** A worker that never answers: stuck, or never started (its script is gone). */
function silentWorker() {
  return fakeWorker(() => new Promise(() => {}))
}

describe('the worker channel', () => {
  it('starts the worker on first use and matches answers to requests', async () => {
    const root = new FakeDirectory()
    const handle = createOpfsHandler(() => root.getDirectoryHandle('downloads', { create: true }))
    const { worker, posted } = fakeWorker(handle)
    const create = vi.fn(() => worker)
    const channel = createWorkerChannel(create)
    expect(create).not.toHaveBeenCalled()
    expect(await channel.request({ op: 'open', file: 'a' })).toBe(0)
    const data = bytes(1, 2).buffer
    const [written, size] = await Promise.all([
      channel.request({ op: 'write', file: 'a', offset: 0, data }, [data]),
      channel.request({ op: 'size', file: 'a' }),
    ])
    expect(written).toBe(2)
    expect(size).toBe(2)
    await expect(channel.request({ op: 'open', file: 'a' })).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(posted[1]?.transfer).toEqual([data])
  })

  it('rejects pending requests when the worker fails, and starts a fresh one next time', async () => {
    const root = new FakeDirectory()
    const handle = createOpfsHandler(() => root.getDirectoryHandle('downloads', { create: true }))
    const dead = silentWorker()
    const fresh = fakeWorker(handle)
    const create = vi.fn().mockReturnValueOnce(dead.worker).mockReturnValueOnce(fresh.worker)
    const channel = createWorkerChannel(create)
    const pending = channel.request({ op: 'size', file: 'a' })
    dead.worker.fail()
    const error = await pending.catch((caught: unknown) => caught)
    // A failure the download manager takes as final: no retry into the same dead worker.
    expect(isStorageUnavailableError(error)).toBe(true)
    expect(dead.worker.terminated).toBe(true)
    // The next request settles, on a fresh worker.
    expect(await channel.request({ op: 'open', file: 'a' })).toBe(0)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('treats a message it cannot read like a failed worker', async () => {
    const { worker } = silentWorker()
    const channel = createWorkerChannel(() => worker)
    const pending = channel.request({ op: 'size', file: 'a' })
    worker.fail('messageerror')
    await expect(pending).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(worker.terminated).toBe(true)
  })

  it('gives up on a worker that stops answering', async () => {
    const root = new FakeDirectory()
    const handle = createOpfsHandler(() => root.getDirectoryHandle('downloads', { create: true }))
    const stuck = silentWorker()
    const fresh = fakeWorker(handle)
    const create = vi.fn().mockReturnValueOnce(stuck.worker).mockReturnValueOnce(fresh.worker)
    const channel = createWorkerChannel(create, { timeoutMs: 20 })
    const [first, second] = await Promise.all([
      channel.request({ op: 'remove', file: 'a' }).catch((caught: unknown) => caught),
      channel.request({ op: 'size', file: 'a' }).catch((caught: unknown) => caught),
    ])
    expect(isStorageUnavailableError(first)).toBe(true)
    expect(isStorageUnavailableError(second)).toBe(true)
    expect(stuck.worker.terminated).toBe(true)
    expect(await channel.request({ op: 'open', file: 'a' })).toBe(0)
  })

  it('lets a download fail and the next one run after the worker died', async () => {
    const root = new FakeDirectory()
    const handle = createOpfsHandler(() => root.getDirectoryHandle('downloads', { create: true }))
    const dead = silentWorker()
    const create = vi
      .fn()
      .mockReturnValueOnce(dead.worker)
      .mockReturnValue(fakeWorker(handle).worker)
    const storage = createOpfsStorage({
      channel: createWorkerChannel(create, { timeoutMs: 50 }),
      root: async () => root,
    })
    const server = new FakeMediaServer()
    const resolver = new FakeDownloadResolver((track, _request, call) => {
      const url = `https://media.test/${track.title}?n=${call}`
      server.add(url, testBytes(2000))
      return {
        candidate: {
          source: 'archive',
          ref: track.title,
          kind: 'song',
          title: track.title,
          artists: [],
          confidence: 1,
          evidence: [],
        },
        stream: {
          url,
          codec: 'flac',
          container: 'flac',
          media: 'audio',
          tier: 'lossless',
          protocol: 'progressive',
          ipBound: false,
          fullLength: 'unverified',
        },
      }
    })
    const archive = (name: string) =>
      testTrack(name, { id: formatId('archive', 'track', `item/${name}.flac`), source: 'archive' })
    const store = createMemoryDownloadStore()
    let names = 0
    const manager = new DownloadManager({
      store,
      storage,
      resolver,
      concurrency: 1,
      createFileName: () => {
        names += 1
        return `file-${names}`
      },
      context: () => ({
        fetch: server.fetch,
        platform: 'web',
        capabilities: TEST_CAPABILITIES.free,
        mode: 'music',
      }),
    })
    await manager.start()
    const [a, b] = [archive('a'), archive('b')]
    await manager.enqueue(a)
    await vi.waitFor(() => expect(dead.worker.terminated).toBe(true))
    await manager.idle()
    expect(await manager.get(a)).toMatchObject({ status: 'failed', error: { code: 'storage' } })
    await manager.enqueue(b)
    await manager.idle()
    expect(await manager.get(b)).toMatchObject({ status: 'completed', bytesTotal: 2000 })
    await manager.destroy()
  })
})
