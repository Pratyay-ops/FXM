import { newDownloadRecord } from '@fxm/downloads'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { track } from '../../test/library-fixtures'
import {
  createDexieDownloadStore,
  type DownloadsDatabase,
  openDownloadsDatabase,
} from './download-db'

const opened: DownloadsDatabase[] = []

function store() {
  const db = openDownloadsDatabase(`fxm-downloads-test-${opened.length}-${Math.random()}`)
  opened.push(db)
  return { db, store: createDexieDownloadStore(db) }
}

afterEach(async () => {
  for (const db of opened.splice(0)) {
    db.close()
    await Dexie.delete(db.name)
  }
})

describe('the downloads database', () => {
  it('stores records and changes them atomically', async () => {
    const { store: records } = store()
    const record = newDownloadRecord(track(1), 5)
    expect(await records.update(record.id, (current) => current ?? record)).toEqual(record)
    expect(await records.get(record.id)).toEqual(record)
    const paused = await records.update(record.id, (current) =>
      current === undefined ? current : { ...current, status: 'paused' },
    )
    expect(paused?.status).toBe('paused')
    expect(await records.update(record.id, () => undefined)).toEqual(paused)
    expect(await records.list()).toEqual([paused])
    expect(await records.update(record.id, () => null)).toBeUndefined()
    expect(await records.list()).toEqual([])
    await expect(records.update(record.id, () => newDownloadRecord(track(2), 1))).rejects.toThrow(
      /returned the record/,
    )
  })

  it('ignores records it cannot trust, and replaces them on a change', async () => {
    const { db, store: records } = store()
    const record = newDownloadRecord(track(1), 5)
    await db.downloads.put({ ...record, status: 'mystery' } as never)
    expect(await records.get(record.id)).toBeUndefined()
    expect(await records.list()).toEqual([])
    expect(await records.update(record.id, (current) => current ?? record)).toEqual(record)
    expect(await records.get(record.id)).toEqual(record)
  })

  it('tells listeners about changes', async () => {
    const { store: records } = store()
    const listener = vi.fn()
    const stop = records.subscribe(listener)
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
    const calls = listener.mock.calls.length
    const record = newDownloadRecord(track(1), 5)
    await records.update(record.id, () => record)
    await vi.waitFor(() => expect(listener.mock.calls.length).toBeGreaterThan(calls))
    stop()
  })
})
