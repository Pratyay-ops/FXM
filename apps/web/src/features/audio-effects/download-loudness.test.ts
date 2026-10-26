import {
  createMemoryDownloadStorage,
  createMemoryDownloadStore,
  type DownloadRecord,
  newDownloadRecord,
} from '@fxm/downloads'
import { testTrack } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import { flacFile } from '../local-files/testing'
import { attachFileLoudness, readFileLoudness } from './download-loudness'

const TAGGED: [string, string][] = [
  ['REPLAYGAIN_TRACK_GAIN', '-6.50 dB'],
  ['REPLAYGAIN_TRACK_PEAK', '0.95'],
]

function completed(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    ...newDownloadRecord(testTrack('a'), 1),
    status: 'completed',
    completedAt: 2,
    bytesDone: 3,
    bytesTotal: 3,
    file: 'file-a',
    format: { codec: 'flac', container: 'flac', media: 'audio', tier: 'lossless' },
    ...overrides,
  }
}

function setup(record: DownloadRecord, bytes: Uint8Array) {
  const store = createMemoryDownloadStore([record])
  const storage = createMemoryDownloadStorage()
  storage.put('file-a', bytes)
  return { store, storage }
}

describe('downloads’ file loudness', () => {
  it('reads a downloaded FLAC’s ReplayGain into its record', async () => {
    const record = completed()
    const { store, storage } = setup(record, flacFile({ tags: { title: 'A', extra: TAGGED } }))
    await attachFileLoudness(record, { store, storage })
    expect((await store.get(record.id))?.format?.loudness).toEqual({
      trackLufs: -11.5,
      trackPeak: 0.95,
      source: 'replaygain',
    })
  })

  it('keeps the loudness the stream had', async () => {
    const loudness = { trackLufs: -10.11, source: 'youtube' } as const
    const record = completed({
      format: { codec: 'opus', container: 'webm', media: 'audio', tier: 'high', loudness },
    })
    const { store, storage } = setup(record, flacFile({ tags: { extra: TAGGED } }))
    let reads = 0
    await attachFileLoudness(record, {
      store,
      storage,
      read: async () => {
        reads += 1
        return undefined
      },
    })
    expect(reads).toBe(0)
    expect((await store.get(record.id))?.format?.loudness).toEqual(loudness)
  })

  it('leaves a record that changed meanwhile, and files without tags', async () => {
    const record = completed()
    const { store, storage } = setup(record, flacFile({ tags: { extra: TAGGED } }))
    await store.update(record.id, (current) =>
      current === undefined ? undefined : { ...current, status: 'removing' },
    )
    await attachFileLoudness(record, { store, storage })
    expect((await store.get(record.id))?.format?.loudness).toBeUndefined()

    const plain = completed()
    const untagged = setup(plain, flacFile({ tags: { title: 'A' } }))
    await attachFileLoudness(plain, untagged)
    expect((await untagged.store.get(plain.id))?.format?.loudness).toBeUndefined()
  })

  it('never rejects on a file it can’t read', async () => {
    const record = completed()
    const { store, storage } = setup(record, new Uint8Array([1, 2, 3]))
    await expect(attachFileLoudness(record, { store, storage })).resolves.toBeUndefined()
    await expect(readFileLoudness(new Blob([new Uint8Array([0, 1])]))).rejects.toBeDefined()
  })
})
