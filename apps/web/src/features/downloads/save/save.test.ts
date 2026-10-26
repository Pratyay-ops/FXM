import { ConvertError, type Converter, type SaveTarget } from '@fxm/convert'
import {
  createInProcessConverter,
  FAKE_WEBM_MAGIC,
  FakeFfmpegCore,
  id3Summary,
} from '@fxm/convert/testing'
import { formatId } from '@fxm/core'
import { type DownloadRecord, newDownloadRecord } from '@fxm/downloads'
import { describe, expect, it, vi } from 'vitest'
import { track } from '../../../test/library-fixtures'
import {
  fileDescription,
  isSavable,
  type SavableDownload,
  SaveError,
  saveDownload,
  savePlan,
  setConverter,
} from './save'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00])

function completed(overrides: Partial<DownloadRecord> = {}): SavableDownload {
  return {
    ...newDownloadRecord(
      track(1, {
        artists: [{ name: 'Artist 1' }, { name: 'Guest' }],
        artwork: [{ url: 'https://i.ytimg.com/vi/x/maxresdefault.jpg', width: 1280, height: 720 }],
        isrc: 'GBARL9300135',
      }),
      1,
    ),
    status: 'completed',
    file: 'file-1',
    bytesDone: 4,
    bytesTotal: 4,
    format: { codec: 'opus', container: 'webm', media: 'audio', tier: 'high', bitrateKbps: 150 },
    ...overrides,
  } as SavableDownload
}

function fakeTarget(fileName = 'Artist 1, Guest - Song 1.mp3') {
  const written: Blob[] = []
  const target: SaveTarget & { written: Blob[]; discarded: number } = {
    fileName,
    written,
    discarded: 0,
    write: async (blob) => {
      written.push(blob)
    },
    discard: async () => {
      target.discarded += 1
    },
  }
  return target
}

const read = async () => new Blob([new Uint8Array([1, 2, 3, 4])])
const fetchCover = vi.fn(async () => new Response(JPEG as BodyInit))

describe('saving a download', () => {
  it('knows which downloads can be saved', () => {
    expect(isSavable(completed())).toBe(true)
    expect(isSavable({ ...completed(), status: 'downloading' } as DownloadRecord)).toBe(false)
    expect(isSavable(null)).toBe(false)
    const { file: _file, ...noFile } = completed()
    expect(isSavable(noFile as DownloadRecord)).toBe(false)
  })

  it('names the file after the artists and title, with the format’s extension', () => {
    expect(savePlan(completed(), 'mp3', 192)).toMatchObject({
      fileName: 'Artist 1, Guest - Song 1.mp3',
      plan: { output: { extension: 'mp3', bitrateKbps: 192 } },
    })
    expect(savePlan(completed(), 'original', undefined).fileName).toBe(
      'Artist 1, Guest - Song 1.webm',
    )
    expect(fileDescription(savePlan(completed(), 'flac', undefined).plan)).toBe('FLAC audio')
    expect(fileDescription(savePlan(completed(), 'original', undefined).plan)).toBe('WEBM audio')
  })

  it('converts, tags with the cover and lyrics, and writes the file to the target', async () => {
    const converter = createInProcessConverter()
    setConverter(converter)
    const target = fakeTarget()
    const progress: number[] = []
    const result = await saveDownload(completed(), {
      format: 'mp3',
      mp3Kbps: 256,
      target,
      read,
      fetch: fetchCover,
      lyrics: async () => ({ synced: false, source: 'lrclib', lines: [{ text: 'Hello' }] }),
      onProgress: (done) => progress.push(done),
    })
    expect(result).toMatchObject({ fileName: target.fileName, tagged: true })
    expect(converter.jobs[0]).toMatchObject({
      format: 'mp3',
      options: { mp3Kbps: 256 },
      source: { codec: 'opus', container: 'webm' },
      tags: {
        title: 'Song 1',
        artists: ['Artist 1', 'Guest'],
        album: 'Album 1',
        isrc: 'GBARL9300135',
        lyrics: 'Hello',
        cover: { mimeType: 'image/jpeg' },
      },
    })
    expect(fetchCover).toHaveBeenCalledWith('https://i.ytimg.com/vi/x/maxresdefault.jpg', {
      credentials: 'omit',
    })
    const saved = new Uint8Array(await (target.written[0] as Blob).arrayBuffer())
    expect(id3Summary(saved)).toMatchObject({ TIT2: 'Song 1', APIC: 'image/jpeg type 3' })
    expect(progress.at(-1)).toBe(1)
  })

  it('saves without the cover and lyrics when they fail', async () => {
    const converter = createInProcessConverter()
    setConverter(converter)
    const target = fakeTarget('x.webm')
    await saveDownload(completed(), {
      format: 'original',
      target,
      read,
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
      lyrics: async () => {
        throw new Error('LRCLIB is down')
      },
    })
    expect(converter.jobs[0]?.tags).toEqual({
      title: 'Song 1',
      artists: ['Artist 1', 'Guest'],
      album: 'Album 1',
      isrc: 'GBARL9300135',
    })
    const saved = new Uint8Array(await (target.written[0] as Blob).arrayBuffer())
    expect(saved.subarray(0, 4)).toEqual(FAKE_WEBM_MAGIC)
  })

  it('says why it failed, and gives the target up', async () => {
    const core = new FakeFfmpegCore()
    core.failNext = new ConvertError('core-unavailable', 'HTTP 404')
    setConverter(createInProcessConverter(core))
    const failing = fakeTarget()
    await expect(
      saveDownload(completed(), { format: 'mp3', target: failing, read, fetch: fetchCover }),
    ).rejects.toMatchObject({
      code: 'core-unavailable',
      message: expect.stringMatching(/Converting doesn't work/),
    })
    expect(failing.discarded).toBe(1)

    const missing = fakeTarget()
    await expect(
      saveDownload(completed(), {
        format: 'mp3',
        target: missing,
        read: async () => undefined,
        fetch: fetchCover,
      }),
    ).rejects.toEqual(new SaveError('file-missing'))

    setConverter(createInProcessConverter())
    const refusing: SaveTarget = {
      fileName: 'x.mp3',
      write: async () => {
        throw new DOMException('denied', 'NotAllowedError')
      },
      discard: async () => {},
    }
    await expect(
      saveDownload(completed(), { format: 'mp3', target: refusing, read, fetch: fetchCover }),
    ).rejects.toMatchObject({ code: 'write-failed' })
  })

  it('reports a cancellation', async () => {
    const controller = new AbortController()
    const converter: Converter = {
      exportAudio: async () => {
        controller.abort()
        throw new ConvertError('cancelled', 'The conversion was cancelled')
      },
      dispose: () => {},
    }
    setConverter(converter)
    await expect(
      saveDownload(completed(), {
        format: 'flac',
        target: fakeTarget(),
        read,
        fetch: fetchCover,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('saves the audio of a video download as the M4A it extracts', async () => {
    setConverter(createInProcessConverter())
    const record = completed({
      track: track(2, { id: formatId('ytm', 'track', 'video0002') }),
      format: { codec: 'aac', container: 'mp4', media: 'muxed-video', tier: 'normal' },
    })
    expect(savePlan(record, 'original', undefined)).toMatchObject({
      fileName: 'Artist 2 - Song 2.m4a',
      plan: { label: 'Original (AAC from 360p video)', extractAudio: true },
    })
  })
})
