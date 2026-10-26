import { type DownloadRecord, newDownloadRecord } from '@fxm/downloads'
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

  it('tells listeners about changes the queue cares about, never about progress', async () => {
    const { store: records } = store()
    const listener = vi.fn()
    const stop = records.subscribe(listener)
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
    const calls = () => listener.mock.calls.length
    const before = calls()
    const record = newDownloadRecord(track(1), 5)
    await records.update(record.id, () => record)
    await vi.waitFor(() => expect(calls()).toBe(before + 1))
    // Progress saves change no status: no pass over the queue for them.
    for (const bytesDone of [100, 200, 300]) {
      await records.update(record.id, (current) =>
        current === undefined ? current : { ...current, bytesDone },
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls()).toBe(before + 1)
    await records.update(record.id, (current) =>
      current === undefined ? current : { ...current, status: 'paused' },
    )
    await vi.waitFor(() => expect(calls()).toBe(before + 2))
    // A completed download leaving for good is a change too.
    await records.update(record.id, (current) =>
      current === undefined ? current : { ...current, status: 'completed' },
    )
    await vi.waitFor(() => expect(calls()).toBe(before + 3))
    await records.update(record.id, (current) =>
      current === undefined ? current : { ...current, status: 'removing' },
    )
    await vi.waitFor(() => expect(calls()).toBe(before + 4))
    stop()
  })

  it('lists records by status through the index', async () => {
    const { store: records } = store()
    const a = newDownloadRecord(track(1), 1)
    const b: DownloadRecord = { ...newDownloadRecord(track(2), 2), status: 'completed' }
    await records.updateMany([a.id, b.id], (_current, id) => (id === a.id ? a : b))
    expect((await records.list(['completed'])).map((record) => record.id)).toEqual([b.id])
    expect(await records.list(['queued', 'completed'])).toHaveLength(2)
    expect(await records.list([])).toEqual([])
  })

  it('changes many records in one transaction', async () => {
    const { db, store: records } = store()
    const a = newDownloadRecord(track(1), 1)
    const b = newDownloadRecord(track(2), 2)
    await records.update(a.id, () => a)
    const results = await records.updateMany([a.id, b.id, a.id], (current, id) => {
      if (id === b.id) return b
      return current?.status === 'queued' ? { ...current, status: 'paused' } : null
    })
    // The second change of a sees the first: paused, so it goes.
    expect(results.map((record) => record?.status)).toEqual(['paused', 'queued', undefined])
    expect(await db.downloads.count()).toBe(1)
    await expect(records.updateMany([b.id], () => newDownloadRecord(track(3), 1))).rejects.toThrow(
      /returned the record/,
    )
    // A change that throws changes nothing.
    expect(await records.get(b.id)).toEqual(b)
  })

  it('lists every row for housekeeping, those it cannot read too', async () => {
    const { db, store: records } = store()
    const a = { ...newDownloadRecord(track(1), 1), file: 'file-a' }
    await db.downloads.put({ ...a, status: 'converting' } as never)
    await db.downloads.put({ ...newDownloadRecord(track(2), 2) })
    expect(await records.rows()).toEqual(
      expect.arrayContaining([
        { id: a.id, file: 'file-a', valid: false },
        { id: newDownloadRecord(track(2), 2).id, valid: true },
      ]),
    )
    // A change of it sees nothing, so "remove all" can delete it.
    expect(await records.updateMany([a.id], (current) => current ?? null)).toEqual([undefined])
    expect(await db.downloads.count()).toBe(1)
  })
})
