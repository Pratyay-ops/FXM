import { testTrack } from '@fxm/player/testing'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryDownloadStore } from './store'
import { newDownloadRecord } from './types'

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
