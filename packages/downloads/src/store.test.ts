import { testTrack } from '@fxm/player/testing'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryDownloadStore } from './store'
import { type DownloadRecord, newDownloadRecord } from './types'

const a = newDownloadRecord(testTrack('a'), 1)
const b = newDownloadRecord(testTrack('b'), 2)

describe('the memory store', () => {
  it('starts with the records it is given', async () => {
    const store = createMemoryDownloadStore([b, a])
    expect(store.size).toBe(2)
    expect(store.snapshot().map((record) => record.id)).toEqual([a.id, b.id])
    expect(await store.get(a.id)).toBe(a)
    expect(await store.list()).toHaveLength(2)
  })

  it('changes a record atomically', async () => {
    const store = createMemoryDownloadStore()
    expect(await store.update(a.id, (current) => current ?? a)).toBe(a)
    const paused = await store.update(a.id, (current) =>
      current === undefined ? current : { ...current, status: 'paused' },
    )
    expect(paused?.status).toBe('paused')
    expect(await store.update(a.id, () => undefined)).toBe(paused)
    expect(await store.update(a.id, (current) => current)).toBe(paused)
    expect(await store.update(a.id, () => null)).toBeUndefined()
    expect(store.size).toBe(0)
    expect(await store.update('missing', () => null)).toBeUndefined()
  })

  it('refuses a change that returns another record', async () => {
    const store = createMemoryDownloadStore()
    await expect(store.update(a.id, () => b)).rejects.toThrow(/returned the record/)
  })

  it('lists records by status', async () => {
    const paused: DownloadRecord = { ...b, status: 'paused' }
    const store = createMemoryDownloadStore([a, paused])
    expect((await store.list(['paused'])).map((record) => record.id)).toEqual([b.id])
    expect(await store.list(['queued', 'paused'])).toHaveLength(2)
    expect(await store.list([])).toEqual([])
  })

  it('changes many records in one go', async () => {
    const store = createMemoryDownloadStore([a])
    const listener = vi.fn()
    store.subscribe(listener)
    const results = await store.updateMany([a.id, b.id, 'missing', a.id], (current, id) => {
      if (id === b.id) return b
      if (id === 'missing') return null
      return current === undefined ? current : { ...current, status: 'paused' }
    })
    expect(results.map((record) => record?.status)).toEqual([
      'paused',
      'queued',
      undefined,
      'paused',
    ])
    expect(store.size).toBe(2)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    // A change that throws changes nothing.
    await expect(
      store.updateMany([a.id, b.id], (current, id) => {
        if (id === b.id) throw new Error('no')
        return current === undefined ? current : { ...current, status: 'queued' }
      }),
    ).rejects.toThrow('no')
    expect((await store.get(a.id))?.status).toBe('paused')
    await expect(store.updateMany([a.id], () => b)).rejects.toThrow(/returned the record/)
  })

  it('treats rows it cannot read as the web app does', async () => {
    const newer = { ...a, status: 'converting', file: 'file-newer' } as unknown as DownloadRecord
    const store = createMemoryDownloadStore([newer, { ...b, file: 'file-b' }])
    expect(await store.get(a.id)).toBeUndefined()
    expect((await store.list()).map((record) => record.id)).toEqual([b.id])
    expect(await store.rows()).toEqual([
      { id: a.id, file: 'file-newer', valid: false },
      { id: b.id, file: 'file-b', valid: true },
    ])
    // A change sees nothing there, and replaces the row.
    expect(await store.update(a.id, (current) => current ?? a)).toBe(a)
    expect(await store.rows()).toContainEqual({ id: a.id, valid: true })
  })

  it('tells listeners once per burst of changes', async () => {
    const store = createMemoryDownloadStore()
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    await Promise.all([store.update(a.id, () => a), store.update(b.id, () => b)])
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    await store.update(a.id, (current) => current)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    await store.update(a.id, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
