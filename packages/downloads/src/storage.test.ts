import { describe, expect, it } from 'vitest'
import { createMemoryDownloadStorage, isStorageFullError, storageFullError } from './storage'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('the memory storage', () => {
  it('writes, grows, truncates and reads a file', async () => {
    const storage = createMemoryDownloadStorage()
    const writer = await storage.open('a')
    expect(await writer.size()).toBe(0)
    await writer.write(0, bytes(1, 2, 3))
    await writer.write(5, bytes(9))
    expect(await writer.size()).toBe(6)
    expect(storage.bytes('a')).toEqual(bytes(1, 2, 3, 0, 0, 9))
    await writer.truncate(2)
    expect(storage.bytes('a')).toEqual(bytes(1, 2))
    await writer.truncate(4)
    expect(storage.bytes('a')).toEqual(bytes(1, 2, 0, 0))
    await writer.flush()
    await writer.close()
    await writer.close()
    expect(await storage.size('a')).toBe(4)
    const blob = await storage.read('a', 'audio/webm')
    expect(blob?.type).toBe('audio/webm')
    expect(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      bytes(1, 2, 0, 0),
    )
    expect(await storage.playbackUrl('a', 'audio/webm')).toBe('memory:a')
    expect(await storage.playbackUrl('b', 'audio/webm')).toBeUndefined()
    expect(await storage.read('b', '')).toBeUndefined()
    expect(await storage.list()).toEqual(['a'])
  })

  it('keeps one writer per file, and an open file in place', async () => {
    const storage = createMemoryDownloadStorage()
    const writer = await storage.open('a')
    expect(storage.openFiles.has('a')).toBe(true)
    await expect(storage.open('a')).rejects.toMatchObject({ name: 'NoModificationAllowedError' })
    await expect(storage.remove('a')).rejects.toMatchObject({ name: 'NoModificationAllowedError' })
    await writer.close()
    await expect(writer.write(0, bytes(1))).rejects.toMatchObject({ name: 'InvalidStateError' })
    await storage.remove('a')
    await storage.remove('a')
    expect(await storage.size('a')).toBeUndefined()
  })

  it('fails writes past the quota like a full disk', async () => {
    const storage = createMemoryDownloadStorage({ quotaBytes: 4 })
    const writer = await storage.open('a')
    await writer.write(0, bytes(1, 2, 3))
    const failure = await writer.write(3, bytes(4, 5)).catch((error: unknown) => error)
    expect(isStorageFullError(failure)).toBe(true)
    // Overwriting doesn't grow the file.
    await writer.write(0, bytes(7, 7, 7))
  })

  it('breaks on request', async () => {
    const storage = createMemoryDownloadStorage()
    storage.put('a', bytes(1))
    storage.failNext('list', new Error('nope'))
    await expect(storage.list()).rejects.toThrow('nope')
    expect(await storage.list()).toEqual(['a'])
    storage.failNext('open', new Error('locked'))
    await expect(storage.open('a')).rejects.toThrow('locked')
    const writer = await storage.open('a')
    storage.failNext('write', storageFullError())
    await expect(writer.write(0, bytes(2))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    storage.failNext('remove', new Error('busy'))
    await writer.close()
    await expect(storage.remove('a')).rejects.toThrow('busy')
  })

  it('notices a file removed under an open writer', async () => {
    const storage = createMemoryDownloadStorage()
    const writer = await storage.open('a')
    storage.put('a', bytes(1))
    await expect(writer.size()).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})

describe('storage errors', () => {
  it('say when the storage is full', () => {
    expect(isStorageFullError(storageFullError())).toBe(true)
    expect(isStorageFullError(new DOMException('x', 'QuotaExceededError'))).toBe(true)
    expect(isStorageFullError(new Error('QuotaExceededError'))).toBe(false)
    expect(isStorageFullError('QuotaExceededError')).toBe(false)
  })
})
