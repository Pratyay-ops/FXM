import { DOWNLOAD_FORMATS, type DownloadFormat } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { exportChoices, exportLabel, isExportable, planExport } from './plan'
import { ConvertError, type SourceAudio } from './types'

const OPUS: SourceAudio = { codec: 'opus', container: 'webm', media: 'audio', bitrateKbps: 150 }
const AAC: SourceAudio = { codec: 'aac', container: 'm4a', media: 'audio', bitrateKbps: 128 }
const ITAG_18: SourceAudio = { codec: 'aac', container: 'mp4', media: 'muxed-video' }
const FLAC: SourceAudio = { codec: 'flac', container: 'flac', media: 'audio', bitDepth: 24 }
const MP3: SourceAudio = { codec: 'mp3', container: 'mp3', media: 'audio', bitrateKbps: 192 }
const VORBIS: SourceAudio = { codec: 'vorbis', container: 'ogg', media: 'audio' }
const WAV: SourceAudio = { codec: 'pcm', container: 'wav', media: 'audio' }

const FORMATS = Object.keys(DOWNLOAD_FORMATS) as DownloadFormat[]

describe('labels', () => {
  it('never call YouTube audio lossless, whatever the format', () => {
    for (const source of [OPUS, AAC, ITAG_18]) {
      for (const format of FORMATS) {
        const plan = planExport(source, format)
        expect(plan.lossless).toBe(false)
        expect(plan.label).not.toMatch(/\blossless\b/i)
      }
    }
  })

  it('say what a conversion is, from describeConversion', () => {
    expect(exportLabel(OPUS, 'original')).toBe('Original (Opus)')
    expect(exportLabel(OPUS, 'flac')).toBe('FLAC (converted from Opus, same quality as the source)')
    expect(exportLabel(OPUS, 'mp3')).toBe('MP3 (converted from Opus, some quality loss)')
    expect(exportLabel(OPUS, 'opus')).toBe('Opus (no conversion)')
    expect(exportLabel(FLAC, 'alac')).toBe('ALAC (converted from FLAC, lossless)')
    expect(planExport(FLAC, 'alac').lossless).toBe(true)
  })

  it('name the audio of a video as such', () => {
    expect(exportLabel(ITAG_18, 'original')).toBe('Original (AAC from 360p video)')
    expect(exportLabel(ITAG_18, 'aac')).toBe('AAC (no conversion, from 360p video)')
    expect(exportLabel(ITAG_18, 'mp3')).toBe(
      'MP3 (converted from AAC from 360p video, some quality loss)',
    )
    expect(exportLabel(ITAG_18, 'flac')).toBe(
      'FLAC (converted from AAC from 360p video, same quality as the source)',
    )
  })
})

describe('planExport', () => {
  it('keeps the original as it is, with FXM’s own tag writer where it has one', () => {
    expect(planExport(AAC, 'original')).toMatchObject({
      transcoded: false,
      extractAudio: false,
      tags: 'mp4',
      output: { codec: 'aac', container: 'm4a', extension: 'm4a', mimeType: 'audio/mp4' },
    })
    expect(planExport(AAC, 'original').core).toBeUndefined()
    expect(planExport(MP3, 'original')).toMatchObject({
      tags: 'id3v2',
      output: { extension: 'mp3' },
    })
    expect(planExport(FLAC, 'original')).toMatchObject({
      tags: 'flac',
      output: { extension: 'flac' },
    })
    expect(planExport(VORBIS, 'original')).toMatchObject({
      tags: 'ogg',
      output: { extension: 'ogg' },
    })
    expect(planExport(WAV, 'original')).toMatchObject({
      tags: 'riff',
      output: { extension: 'wav' },
    })
  })

  it('remuxes an original WebM through the core, whose muxer writes its tags', () => {
    expect(planExport(OPUS, 'original')).toMatchObject({
      core: { format: 'webm', codec: 'copy' },
      tags: 'core',
      output: { container: 'webm', extension: 'webm', mimeType: 'audio/webm' },
    })
  })

  it('remuxes Opus from WebM into an .opus file for the Opus format, without re-encoding', () => {
    expect(planExport(OPUS, 'opus')).toMatchObject({
      transcoded: false,
      core: { format: 'ogg', codec: 'copy' },
      tags: 'ogg',
      output: { container: 'ogg', extension: 'opus', mimeType: 'audio/ogg' },
    })
  })

  it('extracts the AAC of a video and keeps it as M4A for Original and AAC', () => {
    for (const format of ['original', 'aac'] as const) {
      const plan = planExport(ITAG_18, format)
      expect(plan).toMatchObject({ extractAudio: true, transcoded: false, tags: 'mp4' })
      expect(plan.core).toBeUndefined()
      expect(plan.output.extension).toBe('m4a')
    }
  })

  it('extracts the AAC of a video before converting it', () => {
    expect(planExport(ITAG_18, 'mp3')).toMatchObject({
      extractAudio: true,
      core: { format: 'mp3', codec: 'libmp3lame', bitRate: 320_000 },
      tags: 'id3v2',
    })
  })

  it('encodes each format with its encoder and bitrate', () => {
    expect(planExport(OPUS, 'flac').core).toEqual({
      format: 'flac',
      codec: 'flac',
      compressionLevel: 5,
    })
    expect(planExport(OPUS, 'alac').core).toEqual({ format: 'ipod', codec: 'alac' })
    expect(planExport(OPUS, 'wav').core).toEqual({ format: 'wav', codec: 'pcm' })
    expect(planExport(OPUS, 'mp3', { mp3Kbps: 192 }).core).toEqual({
      format: 'mp3',
      codec: 'libmp3lame',
      bitRate: 192_000,
    })
    expect(planExport(OPUS, 'aac').core).toEqual({ format: 'ipod', codec: 'aac', bitRate: 256_000 })
    expect(planExport(AAC, 'opus').core).toEqual({
      format: 'ogg',
      codec: 'libopus',
      bitRate: 160_000,
    })
    expect(planExport(OPUS, 'mp3').output.bitrateKbps).toBe(320)
    expect(planExport(OPUS, 'flac').output.bitrateKbps).toBeUndefined()
  })

  it('keeps a same-codec format in its own container without the core', () => {
    expect(planExport(FLAC, 'flac')).toMatchObject({ transcoded: false, tags: 'flac' })
    expect(planExport(FLAC, 'flac').core).toBeUndefined()
    expect(planExport(MP3, 'mp3').core).toBeUndefined()
    expect(planExport(AAC, 'aac').core).toBeUndefined()
    expect(planExport(WAV, 'wav').core).toBeUndefined()
  })

  it('refuses a video whose audio isn’t AAC in MP4, as input it can’t read', () => {
    const video: SourceAudio = { codec: 'opus', container: 'webm', media: 'muxed-video' }
    expect(isExportable(video)).toBe(false)
    expect(isExportable({ codec: 'aac', container: 'mkv' as never, media: 'muxed-video' })).toBe(
      false,
    )
    expect(() => planExport(video, 'original')).toThrow(ConvertError)
    expect(() => planExport(video, 'flac')).toThrow(
      expect.objectContaining({ code: 'unsupported-input' }),
    )
    expect(() => exportChoices(video)).toThrow(ConvertError)
    for (const source of [OPUS, AAC, ITAG_18, FLAC, MP3, VORBIS, WAV]) {
      expect(isExportable(source), source.codec).toBe(true)
    }
  })
})

describe('exportChoices', () => {
  it('lists every format with its label and extension, saying which need the core', () => {
    expect(exportChoices(AAC)).toEqual([
      {
        format: 'original',
        label: 'Original (AAC)',
        extension: 'm4a',
        needsCore: false,
        transcoded: false,
      },
      {
        format: 'flac',
        label: 'FLAC (converted from AAC, same quality as the source)',
        extension: 'flac',
        needsCore: true,
        transcoded: true,
      },
      {
        format: 'alac',
        label: 'ALAC (converted from AAC, same quality as the source)',
        extension: 'm4a',
        needsCore: true,
        transcoded: true,
      },
      {
        format: 'wav',
        label: 'WAV (converted from AAC, same quality as the source)',
        extension: 'wav',
        needsCore: true,
        transcoded: true,
      },
      {
        format: 'mp3',
        label: 'MP3 (converted from AAC, some quality loss)',
        extension: 'mp3',
        needsCore: true,
        transcoded: true,
      },
      {
        format: 'aac',
        label: 'AAC (no conversion)',
        extension: 'm4a',
        needsCore: false,
        transcoded: false,
      },
      {
        format: 'opus',
        label: 'Opus (converted from AAC, some quality loss)',
        extension: 'opus',
        needsCore: true,
        transcoded: true,
      },
    ])
  })

  it('tells a remux by the core from a conversion', () => {
    const choices = exportChoices(OPUS)
    const of = (format: string) => choices.find((choice) => choice.format === format)
    // WebM's tags and the .opus file are the core's work, but the audio stays as it is.
    expect(of('original')).toMatchObject({ needsCore: true, transcoded: false })
    expect(of('opus')).toMatchObject({ needsCore: true, transcoded: false })
    expect(of('flac')).toMatchObject({ needsCore: true, transcoded: true })
  })
})
