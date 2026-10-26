import {
  ConvertError,
  type Converter,
  type FfmpegCore,
  fetchCover as fetchTrackCover,
  type SaveTarget,
} from '@fxm/convert'
import {
  createInProcessConverter,
  FAKE_WEBM_MAGIC,
  FakeFfmpegCore,
  id3Summary,
  itag18File,
  readMp4Tags,
  topLevelBoxes,
} from '@fxm/convert/testing'
import { formatId } from '@fxm/core'
import { type DownloadRecord, newDownloadRecord } from '@fxm/downloads'
import { createRequestBudget, createWebTransport } from '@fxm/platform'
import { describe, expect, it, vi } from 'vitest'
import { track } from '../../../test/library-fixtures'
import {
  fileDescription,
  isSavable,
  SAVE_ERROR_TEXT,
  type SavableDownload,
  SaveError,
  saveDownload,
  saveErrorText,
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

/** A core loader as where the core can't load: not deployed, offline, or refused. */
const coreUnavailable = async (): Promise<FfmpegCore> => {
  throw new ConvertError('core-unavailable', "The ffmpeg core isn't available here: HTTP 404")
}

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

  it('saves the audio of a video download as the M4A it extracts, never the video', async () => {
    const converter = createInProcessConverter(coreUnavailable)
    setConverter(converter)
    const record = completed({
      track: track(2, {
        id: formatId('ytm', 'track', 'video0002'),
        artwork: [{ url: 'https://lh3.googleusercontent.com/x=w544-h544', width: 544 }],
      }),
      format: { codec: 'aac', container: 'mp4', media: 'muxed-video', tier: 'normal' },
    })
    expect(savePlan(record, 'original', undefined)).toMatchObject({
      fileName: 'Artist 2 - Song 2.m4a',
      plan: { label: 'Original (AAC from 360p video)', extractAudio: true },
    })
    const target = fakeTarget('Artist 2 - Song 2.m4a')
    const result = await saveDownload(record, {
      format: 'original',
      target,
      read: async (_file, type) => new Blob([itag18File() as BlobPart], { type }),
      fetch: fetchCover,
    })
    expect(result).toMatchObject({ fileName: 'Artist 2 - Song 2.m4a', tagged: true })
    const saved = new Uint8Array(await (target.written[0] as Blob).arrayBuffer())
    expect(target.written[0]?.type).toBe('audio/mp4')
    expect(topLevelBoxes(saved)).toEqual(['ftyp', 'moov', 'mdat'])
    expect(readMp4Tags(saved)).toMatchObject({ '©nam': 'Song 2', covr: 'type 13, 8 bytes' })
    // One audio track: the video's sample entry is nowhere in the file.
    expect(new TextDecoder('latin1').decode(saved)).not.toContain('avc1')
  })

  it('saves an original WebM untagged where the core can’t load, never not at all', async () => {
    setConverter(createInProcessConverter(coreUnavailable))
    const target = fakeTarget('x.webm')
    const result = await saveDownload(completed(), {
      format: 'original',
      target,
      read,
      fetch: fetchCover,
    })
    expect(result).toMatchObject({ tagged: false, plan: { format: 'original' } })
    expect(new Uint8Array(await (target.written[0] as Blob).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    )
    expect(target.discarded).toBe(0)
  })

  it('suggests saving the original only when another format was chosen', async () => {
    setConverter(createInProcessConverter(coreUnavailable))
    await expect(
      saveDownload(completed(), { format: 'opus', target: fakeTarget(), read, fetch: fetchCover }),
    ).rejects.toMatchObject({
      code: 'core-unavailable',
      message: SAVE_ERROR_TEXT['core-unavailable'],
    })
    expect(SAVE_ERROR_TEXT['core-unavailable']).toMatch(/Save the original instead/)
    for (const code of ['core-unavailable', 'out-of-memory', 'failed'] as const) {
      expect(saveErrorText(code, 'original'), code).not.toMatch(/original/i)
      expect(saveErrorText(code, 'flac'), code).toBe(SAVE_ERROR_TEXT[code])
    }
    expect(saveErrorText('corrupt-input', 'original')).toBe(SAVE_ERROR_TEXT['corrupt-input'])
  })

  it('tells storage that can’t be read apart from a missing file', async () => {
    setConverter(createInProcessConverter())
    const target = fakeTarget()
    await expect(
      saveDownload(completed(), {
        format: 'mp3',
        target,
        read: async () => {
          throw new DOMException('The Origin Private File System is unavailable', 'SecurityError')
        },
        fetch: fetchCover,
      }),
    ).rejects.toEqual(new SaveError('read-failed'))
    expect(target.discarded).toBe(1)
  })

  it('refuses a download FXM can’t save, giving the target up', async () => {
    setConverter(createInProcessConverter())
    const target = fakeTarget()
    const record = completed({
      format: { codec: 'opus', container: 'webm', media: 'muxed-video', tier: 'normal' },
    })
    expect(isSavable(record)).toBe(true)
    await expect(
      saveDownload(record, { format: 'mp3', target, read, fetch: fetchCover }),
    ).rejects.toMatchObject({ code: 'unsupported-input' })
    expect(target.discarded).toBe(1)
  })

  it('fetches YouTube Music’s and Spotify’s covers through the platform’s transport', async () => {
    // The download environment's context fetch is the platform's, whose host table is FXM's
    // network allow-list: a cover host missing from it would leave every such file coverless.
    const pageFetch = vi.fn(async () => new Response(JPEG as BodyInit))
    const transport = createWebTransport({
      fetch: pageFetch as unknown as typeof fetch,
      budget: createRequestBudget(),
    })
    for (const url of [
      'https://lh3.googleusercontent.com/abcdef=w544-h544-l90-rj',
      'https://yt3.googleusercontent.com/abcdef=s544-c-k-c0x00ffffff-no-rj',
      'https://yt3.ggpht.com/abcdef=s544',
      'https://i.ytimg.com/vi/abcdef/hqdefault.jpg',
      'https://i.scdn.co/image/ab67616d0000b273abcdef',
    ]) {
      const cover = await fetchTrackCover([{ url, width: 544, height: 544 }], {
        fetch: transport.withPriority('bulk'),
      })
      expect(cover, url).toMatchObject({ mimeType: 'image/jpeg' })
    }
    expect(pageFetch).toHaveBeenCalledTimes(5)
  })
})
