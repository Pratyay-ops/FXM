/**
 * The choices and the words of the audio quality settings. Labels come from `@fxm/core`'s
 * quality module where it has them (download formats, conversion labels, MP3 bitrates), and the
 * text never calls YouTube audio lossless: it is Opus or AAC, whatever it is converted to.
 *
 * @module
 */

import {
  type ConnectionPreference,
  DOWNLOAD_FORMATS,
  type DownloadFormat,
  describeConversion,
  MP3_BITRATES,
  type Mp3Bitrate,
  QUALITY_TIERS,
  type QualityTier,
  type StreamingProfile,
  type StreamingSettings,
} from '@fxm/core'
import type { SegmentedOption } from '../../components/ui/segmented-control'
import type { SelectOption } from './setting-select'
import type { ConnectionStatus } from './use-connection'

/** How the app names each quality tier, as the stream badge does. */
export const TIER_LABELS: Readonly<Record<QualityTier, string>> = {
  lossless: 'Lossless',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}

/** The tiers to stream at, best first. */
export const TIER_OPTIONS: readonly SelectOption<QualityTier>[] = QUALITY_TIERS.map((tier) => ({
  value: tier,
  label: TIER_LABELS[tier],
}))

const NEXT_UP = 'A song with nothing this low plays at the next quality up.'

/**
 * What streaming at each tier means. The bitrates are those of YouTube's audio formats (Opus
 * 251 and AAC 140 are High, Opus 250 is Normal, Opus 249 and AAC 139 are Low; see `tierOf`).
 */
export const TIER_DESCRIPTIONS: Readonly<Record<QualityTier, string>> = {
  lossless:
    'Lossless: FLAC where the source has it, as some Internet Archive and Jamendo tracks do, at several times the data of High. YouTube audio is never lossless, so YouTube songs play at High.',
  high: 'High: the best YouTube audio, Opus or AAC at about 130–160 kbps.',
  normal: `Normal: about half the data of High, such as Opus at about 70 kbps. ${NEXT_UP}`,
  low: `Low: the least data, Opus or AAC at about 50 kbps. ${NEXT_UP}`,
}

/** The help of a setting the data saver overrides while it is on. */
export const DATA_SAVER_OVERRIDES = 'Data saver is on, so FXM streams at Low on every connection.'

/** How the connection setting names each choice. */
export const CONNECTION_LABELS: Readonly<Record<ConnectionPreference, string>> = {
  auto: 'Automatic',
  wifi: 'Wi-Fi',
  cellular: 'Mobile data',
}

/**
 * The connection choices to offer: Automatic only where the browser reports its connection.
 * Elsewhere the user says whether they are on Wi-Fi or on mobile data.
 */
export function connectionOptions(status: ConnectionStatus): SelectOption<ConnectionPreference>[] {
  const values: ConnectionPreference[] = status.supported
    ? ['auto', 'wifi', 'cellular']
    : ['wifi', 'cellular']
  return values.map((value) => ({ value, label: CONNECTION_LABELS[value] }))
}

/**
 * The choice the connection setting shows. Automatic, which isn't offered where the browser
 * can't tell, works as Wi-Fi there, so it shows as Wi-Fi.
 */
export function shownConnection(
  setting: ConnectionPreference,
  status: ConnectionStatus,
): ConnectionPreference {
  return setting === 'auto' && !status.supported ? 'wifi' : setting
}

/** What the connection setting does now, with the quality it leads to. */
export function connectionHelp(
  settings: Readonly<StreamingSettings>,
  status: ConnectionStatus,
  profile: Readonly<StreamingProfile>,
): string {
  if (settings.dataSaver) return DATA_SAVER_OVERRIDES
  const quality = `the ${profile.connection === 'wifi' ? 'Wi-Fi' : 'mobile data'} quality (${TIER_LABELS[profile.ceiling]})`
  if (!status.supported) {
    return settings.connection === 'cellular'
      ? `FXM uses ${quality} until you choose Wi-Fi again: this browser doesn't say which connection it's on.`
      : `This browser doesn't say whether it's on Wi-Fi or mobile data, so FXM uses ${quality}. Choose Mobile data when you're on a phone's connection.`
  }
  switch (settings.connection) {
    case 'wifi':
      return `FXM always uses ${quality}, whatever the connection.`
    case 'cellular':
      return `FXM always uses ${quality}, for example on a phone's hotspot, which the browser sees as Wi-Fi.`
    default:
      if (status.detected === 'wifi') return `Automatic: you're on Wi-Fi, so FXM uses ${quality}.`
      if (status.detected === 'cellular') {
        return `Automatic: you're on mobile data, so FXM uses ${quality}.`
      }
      return `Automatic: the browser doesn't say which connection this is, so FXM uses ${quality}.`
  }
}

/** The data saver's choices. */
export const DATA_SAVER_OPTIONS: readonly SegmentedOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

/** What the data saver does. */
export const DATA_SAVER_HELP =
  'Streams at Low on every connection, and never streams a video file for its sound when an audio-only stream exists. With FXM Connect, the desktop app or the Android app, FXM also checks only the stream it is about to play, not every format.'

/** The download formats, in the order the download menu lists them. */
export const DOWNLOAD_FORMAT_OPTIONS: readonly SelectOption<DownloadFormat>[] = (
  Object.keys(DOWNLOAD_FORMATS) as DownloadFormat[]
).map((format) => ({ value: format, label: DOWNLOAD_FORMATS[format].label }))

/**
 * What a download in `format` will be, in the conversion labels downloads show
 * (`describeConversion`): for a YouTube song in Opus, and for a lossless source.
 */
export function downloadFormatHelp(format: DownloadFormat): string[] {
  if (format === 'original') {
    return [
      'Saves each file as its source has it, with no conversion and no quality loss: Opus or AAC for YouTube songs, FLAC where a source is lossless.',
    ]
  }
  const lines = [
    `A YouTube song in Opus: ${describeConversion('opus', format).label}.`,
    `A lossless source in FLAC: ${describeConversion('flac', format).label}.`,
  ]
  if (DOWNLOAD_FORMATS[format].lossless) {
    lines.push(
      'YouTube audio is never lossless: converting it gives a bigger file, not a better one.',
    )
  }
  return lines
}

/** An MP3 bitrate as the select holds it. */
export type Mp3BitrateValue = `${Mp3Bitrate}`

/** The MP3 bitrates downloads offer, lowest first. */
export const MP3_BITRATE_OPTIONS: readonly SelectOption<Mp3BitrateValue>[] = MP3_BITRATES.map(
  (kbps) => ({ value: `${kbps}`, label: `${kbps} kbps` }),
)

/** What the MP3 bitrate changes. */
export const MP3_BITRATE_HELP =
  "Higher keeps more of the source, in bigger files. No bitrate adds quality the source doesn't have."
