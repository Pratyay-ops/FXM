import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CODEC_LABELS,
  type Codec,
  compareTiers,
  containerExtension,
  DEFAULT_MP3_KBPS,
  DEFAULT_QUALITY_PREFS,
  DOWNLOAD_FORMATS,
  type DownloadFormat,
  describeConversion,
  isCodec,
  isDownloadFormat,
  isLosslessCodec,
  isMp3Bitrate,
  isQualityTier,
  LOSSY_TIER_THRESHOLDS,
  MP3_BITRATES,
  QUALITY_TIERS,
  type QualityPrefs,
  type QualityTier,
  type ReadonlyQualityPrefs,
  sanitizeQualityPrefs,
  tierOf,
} from './quality'

describe('isLosslessCodec', () => {
  it.each([
    ['flac', true],
    ['alac', true],
    ['pcm', true],
    ['opus', false],
    ['aac', false],
    ['mp3', false],
    ['vorbis', false],
  ] as const)('%s is lossless: %s', (codec, expected) => {
    expect(isLosslessCodec(codec)).toBe(expected)
  })
})

describe('tierOf', () => {
  it.each([
    // codec, bitrate, tier: each threshold, and just below it
    ['opus', 160, 'high'],
    ['opus', 120, 'high'],
    ['opus', 119, 'normal'],
    ['opus', 64, 'normal'],
    ['opus', 63, 'low'],
    ['opus', 32, 'low'],
    ['aac', 320, 'high'],
    ['aac', 120, 'high'],
    ['aac', 119.9, 'normal'],
    ['aac', 96, 'normal'],
    ['aac', 95, 'low'],
    ['aac', 48, 'low'],
    ['mp3', 320, 'high'],
    ['mp3', 256, 'high'],
    ['mp3', 255, 'normal'],
    ['mp3', 128, 'normal'],
    ['mp3', 127, 'low'],
    ['vorbis', 320, 'high'],
    ['vorbis', 160, 'high'],
    ['vorbis', 159, 'normal'],
    ['vorbis', 96, 'normal'],
    ['vorbis', 95, 'low'],
  ] as const)('%s at %s kbps is %s', (codec, bitrateKbps, tier) => {
    expect(tierOf({ codec, bitrateKbps })).toBe(tier)
  })

  it.each([
    ['Opus itag 251 at 130 kbps', 'opus', 130],
    ['Opus itag 251 at 160 kbps', 'opus', 160],
    ['AAC itag 140 at 128 kbps', 'aac', 128],
  ] as const)("counts YouTube's best free stream (%s) as high", (_label, codec, bitrateKbps) => {
    expect(tierOf({ codec, bitrateKbps })).toBe('high')
  })

  it.each(['flac', 'alac', 'pcm'] as const)('%s is lossless at any bitrate', (codec) => {
    expect(tierOf({ codec })).toBe('lossless')
    expect(tierOf({ codec, bitrateKbps: 1 })).toBe('lossless')
  })

  it.each([undefined, 0, -128, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats a bitrate of %s as unknown, which is normal',
    (bitrateKbps) => {
      for (const codec of ['opus', 'aac', 'mp3', 'vorbis'] as const) {
        const quality = bitrateKbps === undefined ? { codec } : { codec, bitrateKbps }
        expect(tierOf(quality)).toBe('normal')
      }
    },
  )

  it.each(['ac3', 'toString', '__proto__', 'constructor', 'hasOwnProperty'])(
    'treats the unknown codec %j from bad data like an unknown bitrate',
    (codec) => {
      expect(tierOf({ codec: codec as Codec, bitrateKbps: 640 })).toBe('normal')
      expect(tierOf({ codec: codec as Codec, bitrateKbps: 8 })).toBe('normal')
    },
  )

  it('documents the thresholds it uses', () => {
    expect(LOSSY_TIER_THRESHOLDS).toEqual({
      opus: { high: 120, normal: 64 },
      aac: { high: 120, normal: 96 },
      mp3: { high: 256, normal: 128 },
      vorbis: { high: 160, normal: 96 },
    })
    expect(Object.isFrozen(LOSSY_TIER_THRESHOLDS.opus)).toBe(true)
  })
})

describe('compareTiers', () => {
  it('sorts best first', () => {
    const tiers: QualityTier[] = ['low', 'lossless', 'normal', 'high', 'normal']
    expect(tiers.sort(compareTiers)).toEqual(['lossless', 'high', 'normal', 'normal', 'low'])
    expect(QUALITY_TIERS).toEqual(['lossless', 'high', 'normal', 'low'])
  })

  it('returns 0 for equal tiers and a sign for different ones', () => {
    expect(compareTiers('high', 'high')).toBe(0)
    expect(compareTiers('lossless', 'low')).toBeLessThan(0)
    expect(compareTiers('low', 'normal')).toBeGreaterThan(0)
  })

  it('sorts an unknown tier from bad data last', () => {
    const tiers = ['bogus', 'low', 'toString', 'lossless'] as QualityTier[]
    expect(tiers.sort(compareTiers).slice(0, 2)).toEqual(['lossless', 'low'])
    expect(compareTiers('bogus' as QualityTier, 'low')).toBeGreaterThan(0)
  })
})

describe('containerExtension', () => {
  it.each([
    ['webm', 'opus', 'webm'],
    ['mp4', 'aac', 'm4a'],
    ['m4a', 'alac', 'm4a'],
    ['mp3', 'mp3', 'mp3'],
    ['ogg', 'opus', 'opus'],
    ['ogg', 'vorbis', 'ogg'],
    ['flac', 'flac', 'flac'],
    ['wav', 'pcm', 'wav'],
  ] as const)('%s holding %s is .%s', (container, codec, extension) => {
    expect(containerExtension(container, codec)).toBe(extension)
  })

  it('works without a codec', () => {
    expect(containerExtension('ogg')).toBe('ogg')
    expect(containerExtension('mp4')).toBe('m4a')
  })
})

describe('DOWNLOAD_FORMATS', () => {
  it.each([
    ['flac', 'flac', 'flac', 'flac', true],
    ['alac', 'm4a', 'm4a', 'alac', true],
    ['wav', 'wav', 'wav', 'pcm', true],
    ['mp3', 'mp3', 'mp3', 'mp3', false],
    ['aac', 'm4a', 'm4a', 'aac', false],
    ['opus', 'opus', 'ogg', 'opus', false],
  ] as const)(
    '%s is .%s in %s with %s, lossless: %s',
    (format, extension, container, codec, lossless) => {
      expect(DOWNLOAD_FORMATS[format]).toMatchObject({ extension, container, codec, lossless })
    },
  )

  it('leaves everything about the original to the source', () => {
    expect(DOWNLOAD_FORMATS.original).toEqual({
      label: 'Original',
      extension: null,
      container: null,
      codec: null,
      lossless: null,
    })
  })

  it('lists the formats in menu order, frozen', () => {
    expect(Object.keys(DOWNLOAD_FORMATS)).toEqual([
      'original',
      'flac',
      'alac',
      'wav',
      'mp3',
      'aac',
      'opus',
    ])
    expect(Object.isFrozen(DOWNLOAD_FORMATS)).toBe(true)
    expect(Object.isFrozen(DOWNLOAD_FORMATS.flac)).toBe(true)
  })

  it('gives every codec a label', () => {
    expect(Object.keys(CODEC_LABELS).sort()).toEqual(
      ['aac', 'alac', 'flac', 'mp3', 'opus', 'pcm', 'vorbis'].sort(),
    )
  })
})

describe('describeConversion', () => {
  it.each([
    ['opus', 'original', false, false, 'Original (Opus)'],
    ['flac', 'original', true, false, 'Original (FLAC)'],
    ['opus', 'flac', false, true, 'FLAC (converted from Opus, same quality as the source)'],
    ['aac', 'alac', false, true, 'ALAC (converted from AAC, same quality as the source)'],
    ['mp3', 'wav', false, true, 'WAV (converted from MP3, same quality as the source)'],
    ['flac', 'alac', true, true, 'ALAC (converted from FLAC, lossless)'],
    ['alac', 'flac', true, true, 'FLAC (converted from ALAC, lossless)'],
    ['flac', 'wav', true, true, 'WAV (converted from FLAC, lossless)'],
    ['flac', 'mp3', false, true, 'MP3 (converted from FLAC, some quality loss)'],
    ['opus', 'mp3', false, true, 'MP3 (converted from Opus, some quality loss)'],
    ['vorbis', 'aac', false, true, 'AAC (converted from Vorbis, some quality loss)'],
    ['opus', 'opus', false, false, 'Opus (no conversion)'],
    ['aac', 'aac', false, false, 'AAC (no conversion)'],
    ['flac', 'flac', true, false, 'FLAC (no conversion)'],
    ['pcm', 'wav', true, false, 'WAV (no conversion)'],
  ] as const)(
    '%s as %s: lossless %s, transcoded %s, "%s"',
    (source, target, lossless, transcoded, label) => {
      expect(describeConversion(source, target)).toEqual({ lossless, transcoded, label })
    },
  )

  it('never calls a file from a lossy source lossless', () => {
    const lossy: Codec[] = ['opus', 'aac', 'mp3', 'vorbis']
    const formats = Object.keys(DOWNLOAD_FORMATS) as DownloadFormat[]
    for (const codec of lossy) {
      for (const format of formats) expect(describeConversion(codec, format).lossless).toBe(false)
    }
  })

  it.each(['wma', 'toString', '__proto__', 'constructor', '', 42, undefined])(
    'refuses the unknown target %j with a RangeError',
    (target) => {
      expect(() => describeConversion('opus', target as DownloadFormat)).toThrow(RangeError)
    },
  )

  it.each(['ac3', 'toString', '__proto__', 'hasOwnProperty', null])(
    'refuses the unknown source codec %j with a RangeError',
    (codec) => {
      expect(() => describeConversion(codec as Codec, 'original')).toThrow(RangeError)
      expect(() => describeConversion(codec as Codec, 'flac')).toThrow(RangeError)
    },
  )
})

describe('value guards', () => {
  const inherited = ['toString', '__proto__', 'constructor', 'hasOwnProperty']

  it.each([
    ['isCodec', isCodec, ['opus', 'aac', 'mp3', 'vorbis', 'flac', 'alac', 'pcm'], ['ac3', 'OPUS']],
    ['isQualityTier', isQualityTier, ['lossless', 'high', 'normal', 'low'], ['best', 'High']],
    [
      'isDownloadFormat',
      isDownloadFormat,
      ['original', 'flac', 'alac', 'wav', 'mp3', 'aac', 'opus'],
      ['wma', 'FLAC', 'pcm'],
    ],
  ] as const)('%s accepts exactly the known values', (_name, guard, known, unknown) => {
    for (const value of known) expect(guard(value)).toBe(true)
    for (const value of [...unknown, ...inherited, '', 1, null, undefined, {}]) {
      expect(guard(value)).toBe(false)
    }
  })

  it('isMp3Bitrate accepts exactly the offered bitrates', () => {
    for (const kbps of MP3_BITRATES) expect(isMp3Bitrate(kbps)).toBe(true)
    for (const value of [96, 300, 320.5, '320', null, undefined, 'toString']) {
      expect(isMp3Bitrate(value)).toBe(false)
    }
  })
})

describe('quality preferences', () => {
  it('defaults to high on Wi-Fi, normal on mobile data and original downloads', () => {
    expect(DEFAULT_QUALITY_PREFS).toEqual({
      streaming: { wifi: 'high', cellular: 'normal' },
      download: { format: 'original' },
    })
  })

  it('freezes the defaults so nobody changes them by accident', () => {
    expect(Object.isFrozen(DEFAULT_QUALITY_PREFS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_QUALITY_PREFS.streaming)).toBe(true)
    expect(Object.isFrozen(DEFAULT_QUALITY_PREFS.download)).toBe(true)
  })

  it('types the defaults as read-only at every depth, yet usable as QualityPrefs', () => {
    expect(() => {
      // @ts-expect-error the defaults are read-only
      DEFAULT_QUALITY_PREFS.streaming.wifi = 'low'
    }).toThrow(TypeError)
    const shallow = { ...DEFAULT_QUALITY_PREFS }
    expect(() => {
      // @ts-expect-error a shallow copy still shares the frozen nested objects
      shallow.download.format = 'flac'
    }).toThrow(TypeError)
    expectTypeOf(DEFAULT_QUALITY_PREFS).toExtend<QualityPrefs>()
    expectTypeOf(DEFAULT_QUALITY_PREFS).toEqualTypeOf<ReadonlyQualityPrefs>()
  })

  it('offers the usual MP3 bitrates and defaults to 320', () => {
    expect(MP3_BITRATES).toEqual([128, 192, 256, 320])
    expect(DEFAULT_MP3_KBPS).toBe(320)
  })
})

describe('sanitizeQualityPrefs', () => {
  const defaults = {
    streaming: { wifi: 'high', cellular: 'normal' },
    download: { format: 'original' },
  }

  it.each([undefined, null, 42, 'high', [], {}, { streaming: 'high', download: [] }])(
    'falls back to the defaults for %j',
    (value) => {
      expect(sanitizeQualityPrefs(value)).toEqual(defaults)
    },
  )

  it('keeps valid settings', () => {
    const stored: QualityPrefs = {
      streaming: { wifi: 'lossless', cellular: 'low' },
      download: { format: 'mp3', mp3Kbps: 192 },
    }
    expect(sanitizeQualityPrefs(stored)).toEqual(stored)
    expect(sanitizeQualityPrefs(stored)).not.toBe(stored)
  })

  it('replaces each invalid field on its own', () => {
    expect(
      sanitizeQualityPrefs({
        streaming: { wifi: 'ultra', cellular: 'low' },
        download: { format: 'wma', mp3Kbps: 320 },
      }),
    ).toEqual({
      streaming: { wifi: 'high', cellular: 'low' },
      download: { format: 'original', mp3Kbps: 320 },
    })
    expect(
      sanitizeQualityPrefs({ streaming: { wifi: 'low' }, download: { format: 'toString' } }),
    ).toEqual({ streaming: { wifi: 'low', cellular: 'normal' }, download: { format: 'original' } })
  })

  it('leaves out an invalid MP3 bitrate so the default applies, and drops unknown fields', () => {
    const prefs = sanitizeQualityPrefs({
      streaming: { wifi: 'high', cellular: 'normal', dataSaver: true },
      download: { format: 'mp3', mp3Kbps: '320' },
      theme: 'dark',
    })
    expect(prefs).toEqual({
      streaming: { wifi: 'high', cellular: 'normal' },
      download: { format: 'mp3' },
    })
    expect('mp3Kbps' in prefs.download).toBe(false)
  })

  it('returns a fresh, mutable object', () => {
    const prefs = sanitizeQualityPrefs(undefined)
    prefs.streaming.wifi = 'lossless'
    prefs.download.mp3Kbps = 128
    expect(prefs.streaming.wifi).toBe('lossless')
    expect(DEFAULT_QUALITY_PREFS.streaming.wifi).toBe('high')
    expect(sanitizeQualityPrefs(undefined)).not.toBe(sanitizeQualityPrefs(undefined))
  })
})
