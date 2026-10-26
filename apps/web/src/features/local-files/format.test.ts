import { type Codec, type Container, isLosslessCodec } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  audioFormatOf,
  codecOf,
  containerOf,
  convertedFromName,
  extensionOf,
  formatName,
  isAudioFileName,
  isLossless,
  isWaveExtensible,
  type ParsedFormat,
  qualityLabel,
  waveSubFormat,
} from './format'
import { wavFormatChunk } from './testing/audio-files'

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

  it('never labels a file converted from lossy audio lossless: it gets its source’s tier', () => {
    const fromOpus = { codec: 'opus', bitrateKbps: 160 } as const
    const converted = (parsed: ParsedFormat, extension: string) => {
      const result = audioFormatOf(parsed, extension, fromOpus)
      if (!('format' in result)) throw new Error(result.unsupported)
      return result.format
    }
    const flac = converted(
      { container: 'FLAC', codec: 'FLAC', bitrate: 900_000, sampleRate: 48_000, bitsPerSample: 16 },
      'flac',
    )
    expect(flac).toEqual({
      codec: 'flac',
      container: 'flac',
      tier: 'high',
      convertedFrom: fromOpus,
      bitrateKbps: 900,
      sampleRateHz: 48_000,
      bitDepth: 16,
    })
    expect(isLossless(flac)).toBe(false)
    for (const [parsed, extension] of [
      [{ container: 'M4A/isom', codec: 'ALAC', bitsPerSample: 16 }, 'm4a'],
      [{ container: 'WAVE', codec: 'PCM', bitsPerSample: 16 }, 'wav'],
    ] as const) {
      expect(converted(parsed, extension).tier).toBe('high')
      expect(isLossless(converted(parsed, extension))).toBe(false)
    }
    // A low-bitrate source drags the file down with it; a lossy file keeps its own lower tier.
    const low = audioFormatOf({ container: 'FLAC', codec: 'FLAC' }, 'flac', {
      codec: 'aac',
      bitrateKbps: 48,
    })
    expect('format' in low && low.format.tier).toBe('low')
    expect(
      converted({ container: 'MPEG', codec: 'MPEG 1 Layer 3', bitrate: 128_000 }, 'mp3').tier,
    ).toBe('normal')
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

describe('extensible WAVs', () => {
  it('recognizes the tag reader’s name for the extensible header', () => {
    expect(isWaveExtensible({ container: 'WAVE', codec: 'non-PCM (65534)' })).toBe(true)
    expect(isWaveExtensible({ container: 'WAVE', codec: 'PCM' })).toBe(false)
    expect(isWaveExtensible({ container: 'Ogg', codec: 'non-PCM (65534)' })).toBe(false)
  })

  it('reads PCM and float from the SubFormat GUID, with the valid bits', () => {
    expect(waveSubFormat(wavFormatChunk({ extensible: true, bitsPerSample: 24 }))).toEqual({
      codec: 'PCM',
      validBits: 24,
    })
    expect(
      waveSubFormat(wavFormatChunk({ extensible: true, bitsPerSample: 32, validBits: 20 })),
    ).toEqual({ codec: 'PCM', validBits: 20 })
    expect(
      waveSubFormat(wavFormatChunk({ extensible: true, float: true, bitsPerSample: 32 })),
    ).toEqual({ codec: 'IEEE_FLOAT', validBits: 32 })
  })

  it('knows no other SubFormat, and no header that isn’t extensible', () => {
    const mp3 = wavFormatChunk({ extensible: true })
    mp3.set([0x55, 0x00], 24)
    expect(waveSubFormat(mp3)).toBeUndefined()
    // Ambisonics: format tag 1, but another GUID family.
    const ambisonic = wavFormatChunk({ extensible: true })
    ambisonic.set([0x21, 0x07], 28)
    expect(waveSubFormat(ambisonic)).toBeUndefined()
    expect(waveSubFormat(wavFormatChunk({ bitsPerSample: 24 }))).toBeUndefined()
    expect(waveSubFormat(new Uint8Array(12))).toBeUndefined()
  })

  it('labels a 24-bit, 96 kHz WAV lossless with its resolution', () => {
    const result = audioFormatOf(
      { container: 'WAVE', codec: 'PCM', bitsPerSample: 24, sampleRate: 96_000 },
      'wav',
    )
    if (!('format' in result)) throw new Error(result.unsupported)
    expect(result.format.tier).toBe('lossless')
    expect(qualityLabel(result.format)).toBe('WAV · 24-bit · 96 kHz')
    // Left unread, the extensible header is no format FXM plays.
    expect(audioFormatOf({ container: 'WAVE', codec: 'non-PCM (65534)' }, 'wav')).toHaveProperty(
      'unsupported',
    )
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

  it('says where a converted file came from instead of its resolution or bitrate', () => {
    const flac = {
      codec: 'flac',
      container: 'flac',
      tier: 'high',
      sampleRateHz: 48_000,
      bitDepth: 16,
      convertedFrom: { codec: 'opus', bitrateKbps: 160 },
    } as const
    expect(qualityLabel(flac)).toBe('FLAC · converted from Opus')
    expect(convertedFromName(flac)).toBe('Opus')
    expect(
      qualityLabel({
        codec: 'pcm',
        container: 'wav',
        tier: 'normal',
        convertedFrom: { codec: 'aac' },
      }),
    ).toBe('WAV · converted from AAC')
    expect(convertedFromName({})).toBeUndefined()
  })
})
