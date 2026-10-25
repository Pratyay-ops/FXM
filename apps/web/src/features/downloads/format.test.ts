import { type DownloadRecord, newDownloadRecord } from '@fxm/downloads'
import { describe, expect, it } from 'vitest'
import { track } from '../../test/library-fixtures'
import { bytesLabel, ERROR_TEXT, formatBytes, formatLabel, progressOf, statusLine } from './format'

function record(overrides: Partial<DownloadRecord>): DownloadRecord {
  return { ...newDownloadRecord(track(1), 1), ...overrides }
}

describe('sizes', () => {
  it.each([
    [0, '0 bytes'],
    [-5, '0 bytes'],
    [Number.NaN, '0 bytes'],
    [1, '1 byte'],
    [999, '999 bytes'],
    [1000, '1.0 KB'],
    [4_200_000, '4.2 MB'],
    [12_345_678, '12 MB'],
    [3_500_000_000, '3.5 GB'],
    [7e15, '7000 TB'],
  ])('%d bytes read %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })
})

describe('progress', () => {
  it('is a share of the size, once known', () => {
    expect(progressOf({ bytesDone: 50, bytesTotal: 200 })).toBe(0.25)
    expect(progressOf({ bytesDone: 500, bytesTotal: 200 })).toBe(1)
    expect(progressOf({ bytesDone: 50 })).toBeUndefined()
    expect(progressOf({ bytesDone: 0, bytesTotal: 0 })).toBeUndefined()
    expect(bytesLabel({ bytesDone: 2_100_000, bytesTotal: 4_300_000 })).toBe('2.1 MB of 4.3 MB')
    expect(bytesLabel({ bytesDone: 2_100_000 })).toBe('2.1 MB')
  })
})

describe('status lines', () => {
  it('say where a download stands', () => {
    expect(statusLine(record({ status: 'queued' }), true)).toBe('Waiting')
    expect(statusLine(record({ status: 'queued' }), false)).toBe('Waiting for a connection')
    expect(statusLine(record({ status: 'downloading' }), true)).toBe('Starting')
    expect(
      statusLine(
        record({ status: 'downloading', bytesDone: 1_000_000, bytesTotal: 4_000_000 }),
        true,
      ),
    ).toBe('1.0 MB of 4.0 MB')
    expect(statusLine(record({ status: 'downloading', bytesDone: 1_000_000 }), false)).toBe(
      'Waiting for a connection · 1.0 MB',
    )
    expect(statusLine(record({ status: 'paused' }), true)).toBe('Paused')
    expect(statusLine(record({ status: 'paused', bytesDone: 1_000_000 }), true)).toBe(
      'Paused · 1.0 MB',
    )
    expect(
      statusLine(
        record({ status: 'failed', error: { code: 'storage-full', message: '', at: 1 } }),
        true,
      ),
    ).toBe(ERROR_TEXT['storage-full'])
    expect(statusLine(record({ status: 'failed' }), true)).toBe(ERROR_TEXT.unknown)
    expect(statusLine(record({ status: 'completed', bytesTotal: 3_000_000 }), true)).toBe('3.0 MB')
    expect(statusLine(record({ status: 'completed' }), true)).toBe('Downloaded')
    expect(statusLine(record({ status: 'removing' }), true)).toBe('Removing')
  })
})

describe('format labels', () => {
  it('name the original format honestly', () => {
    expect(
      formatLabel({
        codec: 'opus',
        container: 'webm',
        media: 'audio',
        tier: 'high',
        bitrateKbps: 150.4,
      }),
    ).toBe('Opus · 150 kbps')
    expect(
      formatLabel({ codec: 'flac', container: 'flac', media: 'audio', tier: 'lossless' }),
    ).toBe('FLAC')
    expect(
      formatLabel({
        codec: 'aac',
        container: 'mp4',
        media: 'muxed-video',
        tier: 'normal',
        bitrateKbps: 96,
      }),
    ).toBe('AAC from 360p video')
  })
})
