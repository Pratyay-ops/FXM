import { type NetworkCapabilities, QUALITY_TIERS, type QualityTier } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  type AudioReach,
  connectionHelp,
  connectionOptions,
  downloadFormatHelp,
  shownConnection,
  tierDescription,
} from './quality-options'
import type { ConnectionStatus } from './use-connection'

const FULL: NetworkCapabilities = {
  youtube: 'full',
  mediaBytes: true,
  spotify: 'anonymous',
  fileSystem: false,
}
const LITE: NetworkCapabilities = { ...FULL, youtube: 'simple', mediaBytes: false }
const FREE_ONLY: NetworkCapabilities = { ...LITE, youtube: 'none' }

const reach = (capabilities: NetworkCapabilities, codecs: AudioReach['codecs'] = []) => ({
  capabilities,
  codecs,
})

describe('tierDescription', () => {
  it.each<[QualityTier, RegExp]>([
    ['lossless', /^Lossless: FLAC where the source has it.*YouTube songs play at High\.$/],
    ['high', /^High: the best YouTube audio, Opus or AAC at about 130–160 kbps\.$/],
    ['normal', /^Normal: about half the data of High, such as Opus at about 70 kbps\. /],
    ['low', /^Low: the least data, Opus or AAC at about 50 kbps\. /],
  ])('describes %s in YouTube’s formats where YouTube plays', (tier, expected) => {
    expect(tierDescription(tier, reach(FULL))).toMatch(expected)
    expect(tierDescription(tier, reach(LITE, ['opus', 'aac']))).toMatch(expected)
  })

  it('never calls YouTube audio lossless', () => {
    for (const capabilities of [FULL, LITE, FREE_ONLY]) {
      for (const codecs of [[], ['opus'], ['aac'], ['opus', 'aac']] as const) {
        for (const tier of QUALITY_TIERS) {
          expect(tierDescription(tier, reach(capabilities, codecs))).not.toMatch(
            /YouTube (audio|songs?) (is|are|play) lossless/i,
          )
        }
      }
    }
  })

  it('names only the codecs this browser plays', () => {
    expect(tierDescription('high', reach(FULL, ['opus']))).toBe(
      'High: the best YouTube audio, Opus at about 130–160 kbps.',
    )
    expect(tierDescription('low', reach(FULL, ['opus']))).toMatch(/^Low: the least data, Opus at/)
    expect(tierDescription('high', reach(FULL, ['aac']))).toBe(
      'High: the best YouTube audio this browser plays, AAC at about 130 kbps.',
    )
    expect(tierDescription('low', reach(FULL, ['aac']))).toMatch(/^Low: the least data, AAC at/)
  })

  it('says that Normal plays YouTube songs at Low where the browser can’t play Opus', () => {
    expect(tierDescription('normal', reach(LITE, ['aac']))).toBe(
      "Normal: this browser can't play Opus, and YouTube has no AAC stream at Normal, so YouTube songs play at Low, AAC at about 50 kbps.",
    )
    expect(tierDescription('normal', reach(LITE, ['opus']))).toMatch(/Opus at about 70 kbps/)
  })

  it('describes the tiers in MP3 bitrates, without YouTube, where YouTube can’t be reached', () => {
    const free = (tier: QualityTier) => tierDescription(tier, reach(FREE_ONLY, ['opus', 'aac']))
    expect(free('lossless')).toMatch(/^Lossless: FLAC where the source has it/)
    expect(free('high')).toBe('High: the best lossy quality, such as MP3 at 256 kbps or more.')
    expect(free('normal')).toMatch(/^Normal: less data, such as MP3 at 128–255 kbps\. /)
    expect(free('low')).toMatch(/^Low: the least data, such as MP3 below 128 kbps\. /)
    for (const tier of QUALITY_TIERS) expect(free(tier)).not.toMatch(/YouTube|Opus|AAC/)
  })
})

describe('downloadFormatHelp', () => {
  it('explains YouTube conversions where the platform reads YouTube’s bytes', () => {
    expect(downloadFormatHelp('original', FULL)).toEqual([
      'Saves each file as its source has it, with no conversion and no quality loss: Opus or AAC for YouTube songs, FLAC where a source is lossless.',
    ])
    expect(downloadFormatHelp('alac', FULL)).toEqual([
      'A YouTube song in Opus: ALAC (converted from Opus, same quality as the source).',
      'A lossless source in FLAC: ALAC (converted from FLAC, lossless).',
      'YouTube audio is never lossless: converting it gives a bigger file, not a better one.',
    ])
    expect(downloadFormatHelp('aac', FULL)).toEqual([
      'A YouTube song in Opus: AAC (converted from Opus, some quality loss).',
      'A lossless source in FLAC: AAC (converted from FLAC, some quality loss).',
    ])
  })

  it('covers only the free sources where YouTube’s bytes can’t be read, and says where they can', () => {
    for (const capabilities of [LITE, FREE_ONLY]) {
      expect(downloadFormatHelp('original', capabilities)).toEqual([
        'Saves each file as its source has it, with no conversion and no quality loss: FLAC, MP3 or Ogg Vorbis from Internet Archive.',
        'YouTube songs can be downloaded with FXM Connect or the desktop app.',
      ])
      expect(downloadFormatHelp('flac', capabilities)).toEqual([
        'An MP3 from Internet Archive: FLAC (converted from MP3, same quality as the source).',
        'A lossless source in FLAC: FLAC (no conversion).',
        'Lossy audio never becomes lossless: converting it gives a bigger file, not a better one.',
        'YouTube songs can be downloaded with FXM Connect or the desktop app.',
      ])
      expect(downloadFormatHelp('mp3', capabilities)[0]).toBe(
        'An MP3 from Internet Archive: MP3 (no conversion).',
      )
    }
  })

  it('follows mediaBytes, not YouTube access alone', () => {
    const fullWithoutBytes: NetworkCapabilities = { ...FULL, mediaBytes: false }
    expect(downloadFormatHelp('original', fullWithoutBytes)).toEqual(
      downloadFormatHelp('original', LITE),
    )
  })
})

describe('the quality to use', () => {
  const detecting = (detected: ConnectionStatus['detected']): ConnectionStatus => ({
    supported: true,
    detected,
  })
  const blind: ConnectionStatus = { supported: false, detected: 'unknown' }

  it('offers Automatic only where the browser reports its connection', () => {
    expect(connectionOptions(detecting('wifi')).map(({ label }) => label)).toEqual([
      'Automatic',
      'Wi-Fi quality',
      'Mobile data quality',
    ])
    expect(connectionOptions(blind).map(({ label }) => label)).toEqual([
      'Wi-Fi quality',
      'Mobile data quality',
    ])
    expect(shownConnection('auto', blind)).toBe('wifi')
    expect(shownConnection('auto', detecting('unknown'))).toBe('auto')
    expect(shownConnection('cellular', blind)).toBe('cellular')
  })

  it.each<[ConnectionStatus, Parameters<typeof connectionHelp>[0], string]>([
    [detecting('wifi'), 'auto', "Automatic: you're on Wi-Fi, so FXM uses the Wi-Fi quality."],
    [
      detecting('cellular'),
      'auto',
      "Automatic: you're on mobile data, so FXM uses the mobile data quality.",
    ],
    [
      detecting('unknown'),
      'auto',
      "Automatic: the browser doesn't say which connection this is, so FXM uses the Wi-Fi quality.",
    ],
    [
      detecting('cellular'),
      'wifi',
      'FXM uses the Wi-Fi quality on every connection, mobile data included.',
    ],
    [
      detecting('wifi'),
      'cellular',
      "FXM always uses the mobile data quality, for example on a phone's hotspot, which the browser sees as Wi-Fi.",
    ],
    [
      blind,
      'auto',
      "This browser can't tell Wi-Fi from mobile data, so FXM uses the Wi-Fi quality. Switch to Mobile data quality when you're not on Wi-Fi, and back when you are.",
    ],
    [
      blind,
      'wifi',
      "This browser can't tell Wi-Fi from mobile data, so FXM uses the Wi-Fi quality. Switch to Mobile data quality when you're not on Wi-Fi, and back when you are.",
    ],
    [
      blind,
      'cellular',
      "This browser can't tell Wi-Fi from mobile data, so FXM uses the mobile data quality until you switch back to Wi-Fi quality.",
    ],
  ])('explains it (%o, %s), naming no tier', (status, connection, expected) => {
    expect(connectionHelp(connection, status)).toBe(expected)
    expect(expected).not.toMatch(/Lossless|High|Normal|Low/)
  })
})
