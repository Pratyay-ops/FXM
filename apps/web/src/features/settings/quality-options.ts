/**
 * The choices and the words of the audio quality settings. Labels come from `@fxm/core`'s
 * quality module where it has them (download formats, conversion labels, MP3 bitrates, tier
 * thresholds). The text follows what the platform reaches (`NetworkCapabilities`: YouTube or
 * not, and whether its bytes can be read) and the YouTube codecs this browser plays, and it
 * never calls YouTube audio lossless: it is Opus or AAC, whatever it is converted to.
 *
 * @module
 */

import {
  type ConnectionPreference,
  DOWNLOAD_FORMATS,
  type DownloadFormat,
  describeConversion,
  LOSSY_TIER_THRESHOLDS,
  MP3_BITRATES,
  type Mp3Bitrate,
  type NetworkCapabilities,
  type Platform,
  QUALITY_TIERS,
  type QualityTier,
} from '@fxm/core'
import { freeSources } from '../../lib/free-sources'
import { RELEASED } from '../connect/config'
import { connectOrApps } from '../connect/explain'
import type { SaveDestination } from '../downloads/save/device'
import type { SelectOption } from './setting-select'
import type { ConnectionStatus } from './use-connection'
import type { YouTubeCodec } from './youtube-codecs'

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

/**
 * What the words assume until the app passes the platform's capabilities: the Full tier (FXM
 * Connect, the desktop app, the Android app), which reads YouTube's bytes.
 */
export const ASSUMED_CAPABILITIES: NetworkCapabilities = Object.freeze({
  youtube: 'full',
  mediaBytes: true,
  spotify: 'anonymous',
  fileSystem: false,
})

/** What the words depend on: what the platform reaches, and what this browser plays. */
export interface AudioReach {
  /** What the platform reaches: YouTube or not, and whether its bytes can be read. */
  readonly capabilities: NetworkCapabilities
  /** The YouTube codecs this browser plays (`youTubeCodecs`); empty when it doesn't say. */
  readonly codecs: readonly YouTubeCodec[]
}

const NEXT_UP = 'A song with nothing this low plays at the next quality up.'
const MP3 = LOSSY_TIER_THRESHOLDS.mp3

/** The lossless tier, with the free sources this build offers (lib/free-sources.ts). */
function lossless(): string {
  const free = freeSources()
  return `Lossless: FLAC where the source has it, as ${free.and} often ${free.several ? 'do' : 'does'}, at several times the data of High.`
}

/** Without YouTube (Free only): in the MP3 bitrates where `tierOf` draws the lines. */
const FREE_ONLY_TIERS: Readonly<Record<QualityTier, string>> = {
  get lossless() {
    return lossless()
  },
  high: `High: the best lossy quality, such as MP3 at ${MP3.high} kbps or more.`,
  normal: `Normal: less data, such as MP3 at ${MP3.normal}–${MP3.high - 1} kbps. ${NEXT_UP}`,
  low: `Low: the least data, such as MP3 below ${MP3.normal} kbps. ${NEXT_UP}`,
}

/**
 * What streaming at `tier` means here. With YouTube, in the bitrates of YouTube's audio formats
 * (Opus 251 and AAC 140 are High, Opus 250 is Normal, Opus 249 and AAC 139 are Low; see
 * `tierOf`) and only in the codecs this browser plays: YouTube has no AAC stream at Normal, so
 * where the browser can't play Opus, `pickStream` plays AAC 139 at Low under that ceiling.
 * Without YouTube (Free only), in MP3 bitrates.
 */
export function tierDescription(tier: QualityTier, reach: AudioReach): string {
  if (reach.capabilities.youtube === 'none') return FREE_ONLY_TIERS[tier]
  const only = reach.codecs.length === 1 ? reach.codecs[0] : undefined
  const codecs = only === 'opus' ? 'Opus' : only === 'aac' ? 'AAC' : 'Opus or AAC'
  switch (tier) {
    case 'lossless':
      return `${lossless()} YouTube audio is never lossless, so YouTube songs play at High.`
    case 'high':
      return only === 'aac'
        ? 'High: the best YouTube audio this browser plays, AAC at about 130 kbps.'
        : `High: the best YouTube audio, ${codecs} at about 130–160 kbps.`
    case 'normal':
      return only === 'aac'
        ? "Normal: this browser can't play Opus, and YouTube has no AAC stream at Normal, so YouTube songs play at Low, AAC at about 50 kbps."
        : `Normal: about half the data of High, such as Opus at about 70 kbps. ${NEXT_UP}`
    case 'low':
      return `Low: the least data, ${codecs} at about 50 kbps. ${NEXT_UP}`
  }
}

/** The tag beside the streaming row whose quality applies now. */
export const IN_USE = 'In use'

/** The help of a setting the data saver overrides while it is on. */
export const DATA_SAVER_OVERRIDES = 'Not used while Data saver is on.'

/** What the data saver does. */
export const DATA_SAVER_HELP =
  "Streams at Low on every connection and skips video streams when audio alone is available. Downloads aren't affected."

/** The name of the setting that picks which streaming quality applies. */
export const QUALITY_TO_USE = 'Quality to use'

/** How the quality-to-use setting names each choice: the streaming row it picks. */
export const CONNECTION_LABELS: Readonly<Record<ConnectionPreference, string>> = {
  auto: 'Automatic',
  wifi: 'Wi-Fi quality',
  cellular: 'Mobile data quality',
}

/**
 * The quality-to-use choices to offer: Automatic only where the browser reports its connection.
 * Elsewhere the user picks the Wi-Fi or the mobile data quality.
 */
export function connectionOptions(status: ConnectionStatus): SelectOption<ConnectionPreference>[] {
  const values: ConnectionPreference[] = status.supported
    ? ['auto', 'wifi', 'cellular']
    : ['wifi', 'cellular']
  return values.map((value) => ({ value, label: CONNECTION_LABELS[value] }))
}

/**
 * The choice the quality-to-use setting shows. Automatic, which isn't offered where the browser
 * can't tell, works as the Wi-Fi quality there, so it shows as that.
 */
export function shownConnection(
  setting: ConnectionPreference,
  status: ConnectionStatus,
): ConnectionPreference {
  return setting === 'auto' && !status.supported ? 'wifi' : setting
}

/**
 * What the quality-to-use setting does now. It names no tier, so changing a streaming row never
 * changes it (the "In use" tag shows which row applies), and the data saver's override is shown
 * in its place, apart.
 */
export function connectionHelp(connection: ConnectionPreference, status: ConnectionStatus): string {
  if (!status.supported) {
    return connection === 'cellular'
      ? "This browser can't tell Wi-Fi from mobile data, so FXM uses the mobile data quality until you switch back to Wi-Fi quality."
      : "This browser can't tell Wi-Fi from mobile data, so FXM uses the Wi-Fi quality. Switch to Mobile data quality when you're not on Wi-Fi, and back when you are."
  }
  switch (connection) {
    case 'wifi':
      return 'FXM uses the Wi-Fi quality on every connection, mobile data included.'
    case 'cellular':
      return "FXM always uses the mobile data quality, for example on a phone's hotspot, which the browser sees as Wi-Fi."
    default:
      if (status.detected === 'wifi')
        return "Automatic: you're on Wi-Fi, so FXM uses the Wi-Fi quality."
      if (status.detected === 'cellular') {
        return "Automatic: you're on mobile data, so FXM uses the mobile data quality."
      }
      return "Automatic: the browser doesn't say which connection this is, so FXM uses the Wi-Fi quality."
  }
}

/**
 * Why the mobile data quality may not apply on mobile data: shown where the browser can't tell
 * the connection, until the user picks the mobile data quality.
 */
export const MOBILE_DATA_HINT =
  "This browser can't tell when you're on mobile data, so this applies only when you choose Mobile data quality below."

/** The download formats, in the order the download menu lists them. */
export const DOWNLOAD_FORMAT_OPTIONS: readonly SelectOption<DownloadFormat>[] = (
  Object.keys(DOWNLOAD_FORMATS) as DownloadFormat[]
).map((format) => ({ value: format, label: DOWNLOAD_FORMATS[format].label }))

/**
 * The download formats this version offers: all of them since conversions ship (stage 4.2,
 * `RELEASED.conversions`). With conversions off, only Original, the others listed as coming
 * soon and not offered.
 */
export function offeredDownloadFormats(
  conversions: boolean = RELEASED.conversions,
): readonly SelectOption<DownloadFormat>[] {
  if (conversions) return DOWNLOAD_FORMAT_OPTIONS
  return DOWNLOAD_FORMAT_OPTIONS.map((option) =>
    option.value === 'original'
      ? option
      : { ...option, label: `${option.label} (coming soon)`, disabled: true },
  )
}

/**
 * The format the Download dialog and a downloaded song's "Save to device…" start at: the
 * setting, with conversions on (stage 4.2), else Original. A download itself always keeps the
 * original file, for offline playback.
 */
export function effectiveDownloadFormat(
  format: DownloadFormat,
  conversions: boolean = RELEASED.conversions,
): DownloadFormat {
  return conversions ? format : 'original'
}

/** What the download format help adds while only Original is offered (conversions off). */
export const CONVERSIONS_COMING =
  'Converting to FLAC, ALAC, WAV, MP3, AAC or Opus, with tags and cover art, is coming soon.'

/** Where YouTube songs download: FXM Connect, and the apps once they are out (`RELEASED`). */
const youtubeDownloads = () => `YouTube songs can be downloaded with ${connectOrApps()}.`

/**
 * What the download format is for:
 *
 * - `download`: Download saves a file too (Settings → Downloads, on by default), so the format
 *   is where its dialog starts, and "Save to device…"'s;
 * - `save-later`: Download keeps the copy in FXM only, and the format is where a downloaded
 *   song's "Save to device…" starts;
 * - `none`: this app can't save files yet (the desktop and Android apps until they have a saver
 *   of their own).
 */
export type DownloadFormatUse = 'download' | 'save-later' | 'none'

/** The last line of the download format's help: what the format is for ({@link DownloadFormatUse}). */
export function downloadFormatNote(use: DownloadFormatUse): string {
  switch (use) {
    case 'download':
      return 'FXM keeps the original file to play offline. The file Download saves, and “Save to device…”, start at this format; you can pick another each time.'
    case 'save-later':
      return 'Downloads keep the original file, which plays offline as it is. A downloaded song’s “Save to device…” starts at this format.'
    case 'none':
      return 'Downloads keep the original file, which plays offline as it is. This app can’t save files yet, so the format waits until it can.'
  }
}

/**
 * What a download in `format` will be, in the conversion labels downloads show
 * (`describeConversion`), for a lossy and a lossless source. Where the platform can read
 * YouTube's bytes (`mediaBytes`), the lossy one is a YouTube song in Opus. Elsewhere downloads
 * cover the free sources only (Internet Archive, Jamendo), so it is an MP3 from one of them, and
 * the text says where YouTube songs can be downloaded. What the format is for comes apart
 * ({@link downloadFormatNote}), since another setting changes it.
 */
export function downloadFormatHelp(
  format: DownloadFormat,
  capabilities: NetworkCapabilities,
): string[] {
  const youTube = capabilities.mediaBytes
  if (format === 'original') {
    return youTube
      ? [
          'Saves each file as its source has it, with no conversion and no quality loss: Opus or AAC for YouTube songs, FLAC where a source is lossless.',
        ]
      : [
          `Saves each file as its source has it, with no conversion and no quality loss: FLAC, MP3 or Ogg Vorbis from ${freeSources().and}.`,
          youtubeDownloads(),
        ]
  }
  const lines = [
    youTube
      ? `A YouTube song in Opus: ${describeConversion('opus', format).label}.`
      : `An MP3 from ${freeSources().or}: ${describeConversion('mp3', format).label}.`,
    `A lossless source in FLAC: ${describeConversion('flac', format).label}.`,
  ]
  if (DOWNLOAD_FORMATS[format].lossless) {
    lines.push(
      youTube
        ? 'YouTube audio is never lossless: converting it gives a bigger file, not a better one.'
        : 'Lossy audio never becomes lossless: converting it gives a bigger file, not a better one.',
    )
  }
  if (!youTube) lines.push(youtubeDownloads())
  return lines
}

/** The name of the setting that makes Download save a file too. */
export const SAVE_FILE_LABEL = 'Save a file to this device when downloading'

/** The apps that can't save files until they have a saver of their own. */
const APP_NAMES: Readonly<Record<Platform, string>> = {
  web: 'This browser',
  desktop: 'The desktop app',
  android: 'The Android app',
}

/**
 * What "Save a file to this device when downloading" does, `on` or off, where saved files go
 * here (`saveDestination`: the browser's picker, its downloads, the app's own saver, or nowhere
 * yet). Where no file can be saved, it says so: Download keeps the copy in FXM only.
 */
export function saveFileHelp(
  on: boolean,
  destination: SaveDestination,
  platform: Platform,
): string {
  if (destination === 'none') {
    return `${APP_NAMES[platform]} can’t save files yet, so Download keeps each song in FXM, where it plays offline.`
  }
  if (!on) {
    return 'Download keeps the song in FXM only, where it plays offline. To get a file, use “Save to device…” in a downloaded song’s menu.'
  }
  switch (destination) {
    case 'picker':
      return 'Download asks for the format and where to save, then keeps the song in FXM to play offline and saves its file there. An album or a playlist goes into a folder you pick.'
    case 'downloads':
      return 'Download asks for the format, then keeps the song in FXM to play offline and saves its file to your browser’s downloads.'
    case 'app':
      return 'Download asks for the format, then keeps the song in FXM to play offline and saves its file on this device.'
  }
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
