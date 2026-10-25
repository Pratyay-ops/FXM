import { formatId } from '@fxm/core'
import { testCandidate, testStream, testTrack } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import {
  type DownloadRecord,
  downloadId,
  fileFormatOf,
  isDownloadFileFormat,
  isDownloadRecord,
  isPendingDownload,
  newDownloadRecord,
  sameFileFormat,
  withoutError,
  withoutProgress,
} from './types'

const track = testTrack('a')

function record(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    ...newDownloadRecord(track, 1_000),
    status: 'completed',
    completedAt: 2_000,
    bytesDone: 4_000,
    bytesTotal: 4_000,
    file: 'file-1',
    candidate: testCandidate('a'),
    format: fileFormatOf(testStream('a')),
    validator: 'last-modified:Sun, 25 Oct 2026 10:00:00 GMT',
    ...overrides,
  }
}

describe('downloadId', () => {
  it('is the same for both YouTube prefixes of a video', () => {
    expect(downloadId({ id: formatId('ytm', 'track', 'x') })).toBe(
      downloadId({ id: formatId('yt', 'track', 'x') }),
    )
    expect(downloadId({ id: formatId('archive', 'track', 'item/a.flac') })).toBe(
      'archive:track:item/a.flac',
    )
  })
})

describe('records', () => {
  it('start queued with nothing stored', () => {
    expect(newDownloadRecord(track, 5)).toEqual({
      id: downloadId(track),
      track,
      status: 'queued',
      createdAt: 5,
      updatedAt: 5,
      bytesDone: 0,
      attempts: 0,
    })
  })

  it('forget an error, or everything about the stored bytes', () => {
    const failed = record({ status: 'failed', error: { code: 'network', message: 'x', at: 3 } })
    expect(withoutError(failed)).not.toHaveProperty('error')
    const plain = record()
    expect(withoutError(plain)).toBe(plain)
    const fresh = withoutProgress(failed)
    expect(fresh).toMatchObject({ bytesDone: 0, file: 'file-1', status: 'failed' })
    for (const field of ['bytesTotal', 'format', 'validator', 'candidate', 'completedAt']) {
      expect(fresh).not.toHaveProperty(field)
    }
  })

  it('tell pending downloads from the others', () => {
    expect(
      ['queued', 'downloading', 'paused', 'failed'].map((status) =>
        isPendingDownload({ status: status as DownloadRecord['status'] }),
      ),
    ).toEqual([true, true, true, true])
    expect(isPendingDownload({ status: 'completed' })).toBe(false)
    expect(isPendingDownload({ status: 'removing' })).toBe(false)
  })
})

describe('formats', () => {
  it('describe what a stream holds', () => {
    expect(fileFormatOf(testStream('a', { sampleRateHz: 48_000, bitDepth: 16 }))).toEqual({
      codec: 'opus',
      container: 'webm',
      media: 'audio',
      tier: 'high',
      bitrateKbps: 160,
      sampleRateHz: 48_000,
      bitDepth: 16,
    })
    const { bitrateKbps: _unknown, ...stream } = testStream('a')
    expect(fileFormatOf(stream)).not.toHaveProperty('bitrateKbps')
  })

  it('compare by codec, container, media and a known bitrate', () => {
    const opus = fileFormatOf(testStream('a'))
    expect(sameFileFormat(opus, { ...opus })).toBe(true)
    expect(sameFileFormat(opus, { ...opus, bitrateKbps: 150 })).toBe(false)
    const { bitrateKbps: _unknown, ...noBitrate } = opus
    expect(sameFileFormat(opus, noBitrate)).toBe(true)
    expect(sameFileFormat(opus, { ...opus, codec: 'aac' })).toBe(false)
    expect(sameFileFormat(opus, { ...opus, container: 'ogg' })).toBe(false)
    expect(sameFileFormat(opus, { ...opus, media: 'muxed-video' })).toBe(false)
  })

  it('are checked when read back', () => {
    expect(isDownloadFileFormat(fileFormatOf(testStream('a')))).toBe(true)
    expect(
      isDownloadFileFormat({ codec: 'opus', container: 'zip', media: 'audio', tier: 'high' }),
    ).toBe(false)
    expect(
      isDownloadFileFormat({ codec: 'opus', container: 'webm', media: 'video', tier: 'high' }),
    ).toBe(false)
    expect(isDownloadFileFormat(null)).toBe(false)
  })
})

describe('isDownloadRecord', () => {
  it('accepts well-formed records', () => {
    expect(isDownloadRecord(record())).toBe(true)
    expect(isDownloadRecord(newDownloadRecord(track, 0))).toBe(true)
    expect(
      isDownloadRecord(
        record({ status: 'failed', error: { code: 'storage-full', message: '', at: 1 } }),
      ),
    ).toBe(true)
  })

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['an ID that is not the track key', { ...record(), id: 'other' }],
    ['an unknown status', { ...record(), status: 'done' }],
    ['negative bytes', { ...record(), bytesDone: -1 }],
    ['fractional bytes', { ...record(), bytesTotal: 1.5 }],
    ['an empty file name', { ...record(), file: '' }],
    ['a broken track', { ...record(), track: { ...track, id: 'nope' } }],
    ['a broken candidate', { ...record(), candidate: { source: 'ytm', ref: '' } }],
    ['a broken format', { ...record(), format: { codec: 'mp9' } }],
    ['a broken error', { ...record(), error: { code: 'oops', message: '', at: 0 } }],
    ['a time that is not a number', { ...record(), createdAt: '2026' }],
  ])('rejects %s', (_label, value) => {
    expect(isDownloadRecord(value)).toBe(false)
  })
})
