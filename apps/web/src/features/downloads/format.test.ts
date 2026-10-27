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

  it('ask an older FXM Connect to update when YouTube moved the download to another server', () => {
    const redirected = record({
      status: 'failed',
      error: { code: 'redirected', message: '', at: 1 },
    })
    expect(statusLine(redirected, true, '0.2.0')).toBe(
      'YouTube moved this download to another server that FXM Connect 0.2.0 can’t read. Update FXM Connect to 0.2.1',
    )
    // FXM Connect 0.2.1 reads such redirects: then it went to a server it doesn't cover.
    expect(statusLine(redirected, true, '0.2.1')).toBe(
      'YouTube moved this download to a server FXM Connect can’t read',
    )
    expect(statusLine(redirected, true)).toBe(ERROR_TEXT.redirected)
    expect(
      statusLine(
        record({ status: 'failed', error: { code: 'unreadable', message: '', at: 1 } }),
        true,
        '0.2.0',
      ),
    ).toBe('This browser didn’t let FXM Connect read this song’s audio')
  })

  it('say why the manager paused a download on its own', () => {
    expect(
      statusLine(
        record({
          status: 'paused',
          bytesDone: 1_000_000,
          error: { code: 'bot-check', message: '', at: 1 },
        }),
        true,
      ),
    ).toBe(`Paused · ${ERROR_TEXT['bot-check']}`)
    expect(
      statusLine(
        record({ status: 'paused', error: { code: 'storage-full', message: '', at: 1 } }),
        true,
      ),
    ).toBe(`Paused · ${ERROR_TEXT['storage-full']}`)
    expect(
      statusLine(
        record({ status: 'failed', error: { code: 'too-large', message: '', at: 1 } }),
        true,
      ),
    ).toBe(ERROR_TEXT['too-large'])
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
