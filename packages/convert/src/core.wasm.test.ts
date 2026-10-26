/**
 * The real ffmpeg core, end to end: every format FXM saves in, from generated sine waves,
 * decoded back by the core and read back by independent tag readers. It needs a built core, so
 * it runs only when FXM_FFMPEG_CORE_DIR names one: in CI's ffmpeg-wasm job, and locally with
 * `make ffmpeg-wasm-test`. `make test` skips it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DOWNLOAD_FORMATS, type DownloadFormat } from '@fxm/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { concat } from './bytes'
import { type CoreProbe, type FfmpegCore, loadFfmpegCore } from './core'
import { exportAudio } from './exporter'
import { demuxMp4Audio } from './mp4/demux'
import { writeM4a } from './mp4/write'
import {
  id3Summary,
  itag18File,
  readFlacBlocks,
  readMp4Tags,
  readOggPackets,
  readOggPages,
  readRiffChunks,
  readVorbisComments,
  sineWav,
} from './testing'
import type { ExportTags, SourceAudio } from './types'

const dir = process.env.FXM_FFMPEG_CORE_DIR

const TAGS: ExportTags = {
  title: 'Sine 440',
  artists: ['FXM test'],
  album: 'Generated',
  trackNumber: 2,
  releaseDate: '2026-10-26',
  isrc: 'XXFXM2600001',
  lyrics: 'La\nLa',
  syncedLyrics: [
    { timeMs: 100, text: 'La' },
    { timeMs: 600, text: 'La' },
  ],
  cover: {
    mimeType: 'image/png',
    data: new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      1, 0, 0, 0, 1, 8, 2,
    ]),
  },
}

const WAV_SOURCE: SourceAudio = { codec: 'pcm', container: 'wav', media: 'audio' }
const EXTENSIONS: Record<string, string> = {
  flac: 'flac',
  ipod: 'm4a',
  wav: 'wav',
  mp3: 'mp3',
  ogg: 'opus',
  webm: 'webm',
}

describe.skipIf(dir === undefined)('the built ffmpeg core', () => {
  let core: FfmpegCore

  beforeAll(async () => {
    const base = `${pathToFileURL(dir ?? '.').href}/`
    core = await loadFfmpegCore(base, {
      fetch: async (url) => new Response((await readFile(new URL(url).pathname)) as BodyInit),
      importScript: (url) => import(/* @vite-ignore */ join(new URL(url).pathname)),
    })
  })

  const probe = (bytes: Uint8Array, extension: string): Promise<CoreProbe> =>
    core.probe(bytes, extension)

  it('is LGPL, by what its libraries report', () => {
    expect(core.version.license).toMatch(/^LGPL version (2\.1|3) or later$/)
    expect(core.version.configuration).toContain('--disable-gpl')
  })

  it('saves a sine wave in every format, with tags the readers find', async () => {
    const input = sineWav({ seconds: 1 })
    for (const format of Object.keys(DOWNLOAD_FORMATS) as DownloadFormat[]) {
      const result = await exportAudio(
        { input, source: WAV_SOURCE, format, tags: TAGS },
        { loadCore: async () => core },
      )
      const bytes = new Uint8Array(await result.blob.arrayBuffer())
      const info = await probe(bytes, result.plan.output.extension)
      expect(result.tagged, format).toBe(true)
      expect(info.durationSeconds, format).toBeGreaterThan(0.95)
      expect(info.durationSeconds, format).toBeLessThan(1.1)
      expect(info.codec, format).toBe(
        {
          original: 'pcm_s16le',
          flac: 'flac',
          alac: 'alac',
          wav: 'pcm_s16le',
          mp3: 'mp3',
          aac: 'aac',
          opus: 'opus',
        }[format],
      )
      switch (result.plan.tags) {
        case 'flac':
          expect(
            readVorbisComments(
              readFlacBlocks(bytes).blocks.find((block) => block.type === 4)?.body ??
                new Uint8Array(),
            ).fields,
          ).toContainEqual(['TITLE', 'Sine 440'])
          break
        case 'mp4':
          expect(readMp4Tags(bytes)).toMatchObject({
            '©nam': 'Sine 440',
            covr: 'type 14, 26 bytes',
          })
          break
        case 'id3v2':
          expect(id3Summary(bytes)).toMatchObject({
            TIT2: 'Sine 440',
            TSRC: 'XXFXM2600001',
            APIC: 'image/png type 3',
          })
          break
        case 'ogg': {
          const packets = readOggPackets(readOggPages(bytes))
          expect(
            readVorbisComments((packets[1] ?? new Uint8Array()).subarray(8)).fields,
          ).toContainEqual(['ARTIST', 'FXM test'])
          break
        }
        case 'riff':
          expect(readRiffChunks(bytes).map((chunk) => chunk.id)).toEqual([
            'fmt ',
            'data',
            'LIST',
            'id3 ',
          ])
          break
        default:
          throw new Error(`unexpected tag writer ${result.plan.tags}`)
      }
    }
  })

  it('keeps 24 bits from a 24-bit source in FLAC, ALAC and WAV', async () => {
    const input = sineWav({ seconds: 0.5, bitDepth: 24 })
    expect((await probe(input, 'wav')).codec).toBe('pcm_s24le')
    for (const format of ['flac', 'alac', 'wav'] as const) {
      const result = await exportAudio(
        { input, source: { ...WAV_SOURCE, bitDepth: 24 }, format, tags: TAGS },
        { loadCore: async () => core },
      )
      const info = await probe(
        new Uint8Array(await result.blob.arrayBuffer()),
        result.plan.output.extension,
      )
      if (format === 'wav') expect(info.codec).toBe('pcm_s24le')
      else expect(info.bitsPerRawSample, format).toBe(24)
    }
  })

  it('remuxes Opus between Ogg and WebM without re-encoding, WebM with its tags', async () => {
    const opus = await core.convert(
      sineWav({ seconds: 1 }),
      { format: 'ogg', codec: 'libopus', bitRate: 128_000 },
      { inputExtension: 'wav', outputExtension: 'opus' },
    )
    const webm = await exportAudio(
      {
        input: opus,
        source: { codec: 'opus', container: 'ogg', media: 'audio' },
        format: 'original',
        tags: TAGS,
      },
      { loadCore: async () => core },
    )
    expect(webm.plan.core).toBeUndefined()
    // Opus from WebM: the core remuxes the original with Matroska tags.
    const asWebm = await core.convert(
      opus,
      { format: 'webm', codec: 'copy', metadata: { title: 'Sine 440' } },
      { inputExtension: 'opus', outputExtension: 'webm' },
    )
    const original = await exportAudio(
      {
        input: asWebm,
        source: { codec: 'opus', container: 'webm', media: 'audio' },
        format: 'original',
        tags: TAGS,
      },
      { loadCore: async () => core },
    )
    const originalBytes = new Uint8Array(await original.blob.arrayBuffer())
    expect((await probe(originalBytes, 'webm')).codec).toBe('opus')
    expect(new TextDecoder('latin1').decode(originalBytes)).toContain('Sine 440')
    const back = await exportAudio(
      {
        input: originalBytes,
        source: { codec: 'opus', container: 'webm', media: 'audio' },
        format: 'opus',
        tags: TAGS,
      },
      { loadCore: async () => core },
    )
    const info = await probe(new Uint8Array(await back.blob.arrayBuffer()), 'opus')
    expect(info).toMatchObject({ format: 'ogg', codec: 'opus' })
    expect(info.durationSeconds).toBeGreaterThan(0.95)
  })

  it('extracts the real AAC of a video and converts it, never the video', async () => {
    const aac = await core.convert(
      sineWav({ seconds: 1 }),
      { format: 'ipod', codec: 'aac', bitRate: 128_000 },
      { inputExtension: 'wav', outputExtension: 'm4a' },
    )
    const track = demuxMp4Audio(aac)
    const video = itag18File({ audio: [...track.samples] })
    // Without a cover, which FFmpeg would list as a picture stream of the MP3.
    const { cover: _cover, ...tags } = TAGS
    const result = await exportAudio(
      {
        input: video,
        source: { codec: 'aac', container: 'mp4', media: 'muxed-video' },
        format: 'mp3',
        tags,
      },
      { loadCore: async () => core },
    )
    const info = await probe(new Uint8Array(await result.blob.arrayBuffer()), 'mp3')
    expect(info.codec).toBe('mp3')
    expect(info.streams).toBe(1)
    expect(info.durationSeconds).toBeGreaterThan(0.9)
    // And the extracted M4A itself plays as AAC.
    const m4a = concat(writeM4a(demuxMp4Audio(video)))
    expect((await probe(m4a, 'm4a')).codec).toBe('aac')
  })

  it('reports damaged input as such', async () => {
    await expect(
      core.convert(
        new TextEncoder().encode('not audio'),
        { format: 'flac', codec: 'flac' },
        { inputExtension: 'mp3', outputExtension: 'flac' },
      ),
    ).rejects.toMatchObject({ code: 'corrupt-input' })
  })

  it('names its outputs as the plans expect', () => {
    expect(Object.keys(EXTENSIONS).sort()).toEqual(['flac', 'ipod', 'mp3', 'ogg', 'wav', 'webm'])
  })
})
