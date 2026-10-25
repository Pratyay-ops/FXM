import { type Codec, type Container, isLosslessCodec } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  audioFormatOf,
  codecOf,
  containerOf,
  extensionOf,
  formatName,
  isAudioFileName,
  isLossless,
  type ParsedFormat,
  qualityLabel,
} from './format'

describe('which files FXM reads', () => {
  it.each([
    ['Song.mp3', true],
    ['SONG.FLAC', true],
    ['a.m4a', true],
    ['a.mp4', true],
    ['a.wav', true],
    ['a.ogg', true],
    ['a.oga', true],
    ['a.opus', true],
    ['a.webm', true],
    ['a.weba', true],
    ['.hidden.mp3', false],
    ['._Song.mp3', false],
    ['cover.jpg', false],
    ['notes.txt', false],
    ['a.aiff', false],
    ['a.ape', false],
    ['a.wma', false],
    ['mp3', false],
  ])('%s: %s', (name, expected) => {
    expect(isAudioFileName(name)).toBe(expected)
  })

  it('reads extensions without the dot, in lower case', () => {
    expect(extensionOf('A.Song.FLAC')).toBe('flac')
    expect(extensionOf('noextension')).toBe('')
    expect(extensionOf('.flac')).toBe('')
  })
})

describe('codecOf', () => {
  it.each([
    ['FLAC', 'flac'],
    ['ALAC', 'alac'],
    ['PCM', 'pcm'],
    ['IEEE_FLOAT', 'pcm'],
    ['Opus', 'opus'],
    ['OPUS', 'opus'],
    ['Vorbis I', 'vorbis'],
    ['VORBIS', 'vorbis'],
    ['MPEG 1 Layer 3', 'mp3'],
    ['MPEG 2 Layer 3', 'mp3'],
    ['MPEG 2.5 Layer 3', 'mp3'],
    ['MPEG-1 layer 3', 'mp3'],
    ['MPEG/L3', 'mp3'],
    ['MPEGLAYER3', 'mp3'],
    ['MPEG-4/AAC', 'aac'],
    ['AAC', 'aac'],
    ['AAC/MPEG4/LC', 'aac'],
  ] as const)('maps %s to %s', (name, codec) => {
    expect(codecOf(name)).toBe(codec)
  })

  it.each([
    'MPEG 1 Layer 2',
    'AC-3',
    "Monkey's Audio",
    'DSD',
    'ADPCM',
    'Speex 1.2',
    'MPEG-4/AAC+ALAC',
    '',
    undefined,
  ])('knows no codec for %j', (name) => {
    expect(codecOf(name)).toBeUndefined()
  })
})

describe('containerOf', () => {
  it.each([
    ['MPEG', 'mp3', 'mp3'],
    ['FLAC', 'flac', 'flac'],
    ['WAVE', 'wav', 'wav'],
    ['Ogg', 'opus', 'ogg'],
    ['EBML/webm', 'webm', 'webm'],
    ['M4A/isom/mp42', 'm4a', 'm4a'],
    ['M4A/mp42/isom', 'mp4', 'mp4'],
    ['isom/iso2/mp41', 'm4a', 'm4a'],
  ] as const)('maps %s (.%s) to %s', (name, extension, container) => {
    expect(containerOf(name, extension)).toBe(container)
  })

  it.each(['EBML/matroska', 'ADTS/MPEG-4', 'AIFF', 'WavPack', '', undefined])(
    'knows no container for %j',
    (name) => {
      expect(containerOf(name, 'mp3')).toBeUndefined()
    },
  )
})

describe('audioFormatOf', () => {
  const formatOf = (parsed: ParsedFormat, extension: string) => {
    const result = audioFormatOf(parsed, extension)
    if (!('format' in result)) throw new Error(result.unsupported)
    return result.format
  }

  it('labels FLAC, ALAC and WAV lossless, with their resolution', () => {
    expect(
      formatOf(
        {
          container: 'FLAC',
          codec: 'FLAC',
          bitrate: 2_300_000,
          sampleRate: 96_000,
          bitsPerSample: 24,
        },
        'flac',
      ),
    ).toEqual({
      codec: 'flac',
      container: 'flac',
      tier: 'lossless',
      bitrateKbps: 2300,
      sampleRateHz: 96_000,
      bitDepth: 24,
    })
    expect(formatOf({ container: 'M4A/isom', codec: 'ALAC', bitsPerSample: 16 }, 'm4a').tier).toBe(
      'lossless',
    )
    expect(formatOf({ container: 'WAVE', codec: 'PCM', bitsPerSample: 16 }, 'wav').tier).toBe(
      'lossless',
    )
    expect(formatOf({ container: 'WAVE', codec: 'IEEE_FLOAT' }, 'wav').tier).toBe('lossless')
    expect(formatOf({ container: 'Ogg', codec: 'FLAC' }, 'oga').tier).toBe('lossless')
  })

  it('never labels a lossy codec lossless, whatever its bitrate', () => {
    const lossy: [ParsedFormat, string][] = [
      [{ container: 'MPEG', codec: 'MPEG 1 Layer 3', bitrate: 320_000 }, 'mp3'],
      [{ container: 'M4A/isom', codec: 'MPEG-4/AAC', bitrate: 1_411_000 }, 'm4a'],
      [{ container: 'Ogg', codec: 'Opus', bitrate: 510_000 }, 'opus'],
      [{ container: 'Ogg', codec: 'Vorbis I', bitrate: 500_000 }, 'ogg'],
      [{ container: 'EBML/webm', codec: 'OPUS', bitrate: 160_000 }, 'webm'],
    ]
    for (const [parsed, extension] of lossy) {
      const format = formatOf(parsed, extension)
      expect(format.tier).not.toBe('lossless')
      expect(isLossless(format)).toBe(false)
      expect(format.bitDepth).toBeUndefined()
    }
    expect(formatOf(lossy[0]?.[0] ?? {}, 'mp3').tier).toBe('high')
  })

  it('agrees with core: lossless exactly for FLAC, ALAC and PCM', () => {
    const pairs: [Codec, Container, string, string][] = [
      ['mp3', 'mp3', 'MPEG 1 Layer 3', 'MPEG'],
      ['aac', 'm4a', 'MPEG-4/AAC', 'M4A/isom'],
      ['alac', 'm4a', 'ALAC', 'M4A/isom'],
      ['flac', 'flac', 'FLAC', 'FLAC'],
      ['pcm', 'wav', 'PCM', 'WAVE'],
      ['opus', 'ogg', 'Opus', 'Ogg'],
      ['vorbis', 'ogg', 'Vorbis I', 'Ogg'],
    ]
    for (const [codec, container, codecName, containerName] of pairs) {
      const format = formatOf(
        { codec: codecName, container: containerName, bitrate: 999_000 },
        container,
      )
      expect(format.codec).toBe(codec)
      expect(isLossless(format)).toBe(isLosslessCodec(codec))
    }
  })

  it('refuses videos, unknown codecs and mismatched pairs', () => {
    expect(
      audioFormatOf({ container: 'EBML/webm', codec: 'OPUS', hasVideo: true }, 'webm'),
    ).toEqual({
      unsupported: 'A video file',
    })
    expect(audioFormatOf({ container: 'M4A/isom', codec: 'AC-3' }, 'm4a')).toEqual({
      unsupported: 'Not a format browsers play: AC-3 in M4A/isom',
    })
    expect(audioFormatOf({ container: 'WAVE', codec: 'MPEGLAYER3' }, 'wav')).toHaveProperty(
      'unsupported',
    )
    expect(audioFormatOf({ container: 'MPEG', codec: 'FLAC' }, 'mp3')).toHaveProperty('unsupported')
    expect(audioFormatOf({}, 'mp3')).toEqual({ unsupported: 'An unknown format' })
  })

  it('drops values that are not positive numbers', () => {
    expect(
      formatOf(
        { container: 'MPEG', codec: 'MPEG 1 Layer 3', bitrate: Number.NaN, sampleRate: -1 },
        'mp3',
      ),
    ).toEqual({ codec: 'mp3', container: 'mp3', tier: 'normal' })
  })
})

describe('labels', () => {
  it('names WAV by its container and everything else by its codec', () => {
    expect(formatName({ codec: 'pcm', container: 'wav' })).toBe('WAV')
    expect(formatName({ codec: 'flac', container: 'ogg' })).toBe('FLAC')
    expect(formatName({ codec: 'aac', container: 'm4a' })).toBe('AAC')
  })

  it('shows resolution for lossless and bitrate for lossy files', () => {
    expect(
      qualityLabel({
        codec: 'flac',
        container: 'flac',
        tier: 'lossless',
        sampleRateHz: 96_000,
        bitDepth: 24,
      }),
    ).toBe('FLAC · 24-bit · 96 kHz')
    expect(
      qualityLabel({
        codec: 'pcm',
        container: 'wav',
        tier: 'lossless',
        sampleRateHz: 44_100,
        bitDepth: 16,
      }),
    ).toBe('WAV · 16-bit · 44.1 kHz')
    expect(qualityLabel({ codec: 'mp3', container: 'mp3', tier: 'high', bitrateKbps: 320 })).toBe(
      'MP3 · 320 kbps',
    )
    expect(qualityLabel({ codec: 'aac', container: 'm4a', tier: 'normal' })).toBe('AAC')
  })
})
