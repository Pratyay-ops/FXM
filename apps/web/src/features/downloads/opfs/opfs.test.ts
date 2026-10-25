import { describe, expect, it, vi } from 'vitest'
import { FakeDirectory } from './fake-opfs'
import { createOpfsHandler } from './handler'
import type { OpfsAnswer, OpfsMessage, OpfsRequest } from './protocol'
import {
  createOpfsStorage,
  createWorkerChannel,
  type OpfsChannel,
  type WorkerLike,
} from './storage'

function setup() {
  const root = new FakeDirectory()
  const handle = createOpfsHandler(() => root.getDirectoryHandle('downloads', { create: true }))
  // The worker's handler, run in-process.
  const channel: OpfsChannel = {
    request: (request) =>
      handle(request).catch((error: Error) => {
        throw new DOMException(error.message, error.name)
      }),
  }
  let urls = 0
  const revoked: string[] = []
  const storage = createOpfsStorage({
    channel,
    root: async () => root,
    createUrl: () => {
      urls += 1
      return `blob:fxm/${urls}`
    },
    revokeUrl: (url) => revoked.push(url),
  })
  const folder = () => root.folders.get('downloads')
  return { root, handle, storage, revoked, folder }
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

describe('the worker channel', () => {
  /** A worker that runs the handler and answers in a later task, like a real one. */
  function fakeWorker(handle: (request: OpfsRequest) => Promise<number | undefined>) {
    const listeners: {
      message: ((event: MessageEvent<OpfsAnswer>) => void)[]
      error: (() => void)[]
    } = {
      message: [],
      error: [],
    }
    const posted: { message: OpfsMessage; transfer: Transferable[] }[] = []
    const worker: WorkerLike & { fail(): void } = {
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
      addEventListener(type: 'message' | 'error', listener: never) {
        ;(listeners[type] as unknown[]).push(listener)
      },
      fail() {
        for (const listener of listeners.error) listener()
      },
    }
    const answer = (data: OpfsAnswer) =>
      setTimeout(() => {
        for (const listener of listeners.message) listener({ data } as MessageEvent<OpfsAnswer>)
      }, 0)
    return { worker, posted }
  }

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

  it('rejects pending requests when the worker fails', async () => {
    const { worker } = fakeWorker(() => new Promise(() => {}))
    const channel = createWorkerChannel(() => worker)
    const pending = channel.request({ op: 'size', file: 'a' })
    worker.fail()
    await expect(pending).rejects.toMatchObject({ name: 'InvalidStateError' })
  })
})
