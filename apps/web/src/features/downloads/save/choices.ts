/**
 * The formats the Download and Save to device dialogs offer, and what each means, in words that
 * never call YouTube audio lossless.
 *
 * - **A downloaded song** has a known file, so its choices are exact: "FLAC (converted from
 *   Opus, same quality as the source)", from `@fxm/convert`'s `exportChoices`.
 * - **A song not downloaded yet**, or several, have no file yet: which stream a download gets is
 *   decided when it runs. Their choices are the formats themselves, and the help says what each
 *   gives for the songs' sources, in the words of Settings (`describeConversion`): "A YouTube
 *   song in Opus: FLAC (converted from Opus, same quality as the source)".
 *
 * @module
 */

import {
  type ExportChoice,
  type ExportOptions,
  exportChoices,
  isExportable,
  type SourceAudio,
  sourceLabel,
} from '@fxm/convert'
import {
  type Codec,
  DEFAULT_MP3_KBPS,
  DOWNLOAD_FORMATS,
  type DownloadFormat,
  describeConversion,
  isLosslessCodec,
  type Mp3Bitrate,
  type Track,
} from '@fxm/core'
import { freeSources } from '../../../lib/free-sources'
import { browserYouTubeCodecs } from '../../settings/youtube-codecs'
import type { SavableDownload } from './save'

/** One choice of a dialog's format list. */
export interface FormatChoice {
  readonly format: DownloadFormat
  /** What the radio button says: "FLAC (converted from Opus, …)", or "FLAC" before a download. */
  readonly label: string
  /** The saved file's extension, without the dot, when known. */
  readonly extension?: string
  /** Whether saving it may take FXM's ffmpeg core (credited where it does). */
  readonly needsCore: boolean
}

/**
 * The formats a downloaded file can be saved in, or `undefined` when FXM can't save it at all:
 * all of them with conversions on (stage 4.2, `RELEASED.conversions`), else the original alone.
 */
export function exactChoices(
  source: SourceAudio,
  options: ExportOptions,
  conversions: boolean,
): ExportChoice[] | undefined {
  if (!isExportable(source)) return undefined
  try {
    const choices = exportChoices(source, options)
    return conversions ? choices : choices.filter((choice) => choice.format === 'original')
  } catch {
    return undefined
  }
}

/** What the chosen format means for a downloaded song, in a sentence or two. */
export function exactChoiceHelp(record: SavableDownload, choice: ExportChoice): string[] {
  const lines: string[] = []
  const source = record.format
  if (source.media === 'muxed-video') {
    lines.push('This song was downloaded as a 360p video. FXM saves its audio track only.')
  }
  if (choice.format === 'original') {
    lines.push(
      source.container === 'webm'
        ? 'The audio exactly as downloaded, with its title, artists and album. WebM files have no place for a cover.'
        : 'The audio exactly as downloaded, with its tags, cover and lyrics.',
    )
  } else if (DOWNLOAD_FORMATS[choice.format].lossless && !isLosslessCodec(source.codec)) {
    lines.push(
      `${sourceLabel(source)} is never lossless: converting it gives a bigger file, not a better one.`,
    )
  }
  // A remux (WebM's tags, Opus into .opus) keeps the audio as it is: only a re-encode converts.
  if (choice.needsCore && choice.transcoded) {
    lines.push('FXM converts it on this device, which takes a little while.')
  }
  return lines
}

/**
 * The formats to offer before the songs are downloaded: every one with conversions on, else the
 * original alone. Only a converted format's extension is known before the download.
 */
export function plannedChoices(conversions: boolean): FormatChoice[] {
  const formats = (Object.keys(DOWNLOAD_FORMATS) as DownloadFormat[]).filter(
    (format) => conversions || format === 'original',
  )
  return formats.map((format) => {
    const info = DOWNLOAD_FORMATS[format]
    return {
      format,
      label: info.label,
      ...(info.extension === null ? {} : { extension: info.extension }),
      needsCore: format !== 'original',
    }
  })
}

/** Where songs come from, as far as their files go. */
export interface SourceKinds {
  /** Songs whose audio comes from YouTube: YouTube Music, YouTube, Spotify's matches. */
  readonly youtube: boolean
  /** Songs from the free sources, Internet Archive and Jamendo. */
  readonly free: boolean
}

/** Which kinds of source `tracks` come from. */
export function sourceKinds(tracks: readonly Pick<Track, 'source'>[]): SourceKinds {
  const free = tracks.some((track) => track.source === 'archive' || track.source === 'jamendo')
  const youtube = tracks.some((track) => track.source !== 'archive' && track.source !== 'jamendo')
  return { youtube, free }
}

/** Options for {@link plannedChoiceHelp}. */
export interface PlannedHelpOptions {
  /** Several songs ("each file") or one ("the file"). */
  readonly several: boolean
  /** The MP3 bitrate of the settings. */
  readonly mp3Kbps?: Mp3Bitrate | undefined
  /**
   * The codec YouTube songs download in here: AAC where the browser can't play Opus, else Opus.
   * Default: from this browser's `canPlayType`.
   */
  readonly youtubeCodec?: Extract<Codec, 'opus' | 'aac'>
  /** The free sources' names. Default: this build's (`freeSources()`). */
  readonly free?: ReturnType<typeof freeSources>
}

function youTubeCodecHere(): Extract<Codec, 'opus' | 'aac'> {
  const codecs = browserYouTubeCodecs()
  return codecs.length === 1 && codecs[0] === 'aac' ? 'aac' : 'opus'
}

/**
 * What a format gives for songs not downloaded yet, from `kinds` of source, in Settings' words:
 * the honest label of a typical file of each kind (`describeConversion`), and for a lossless
 * format that lossy audio never becomes lossless.
 */
export function plannedChoiceHelp(
  format: DownloadFormat,
  kinds: SourceKinds,
  options: PlannedHelpOptions,
): string[] {
  const free = options.free ?? freeSources()
  const file = options.several ? 'Each file' : 'The file'
  if (format === 'original') {
    if (kinds.youtube && kinds.free) {
      return [
        `${file} as its source has it, with no conversion and no quality loss: Opus or AAC for YouTube songs, FLAC where a source is lossless.`,
      ]
    }
    if (kinds.youtube) {
      return [`${file} as YouTube has it, Opus or AAC, with no conversion and no quality loss.`]
    }
    return [
      `${file} as ${free.or} has it, with no conversion and no quality loss: FLAC where the source is lossless, otherwise MP3 or Ogg.`,
    ]
  }
  const lines: string[] = []
  if (kinds.youtube) {
    const codec = options.youtubeCodec ?? youTubeCodecHere()
    const name = codec === 'aac' ? 'AAC' : 'Opus'
    lines.push(`A YouTube song in ${name}: ${describeConversion(codec, format).label}.`)
  }
  if (kinds.free) {
    lines.push(`A lossless source in FLAC: ${describeConversion('flac', format).label}.`)
    lines.push(`An MP3 from ${free.or}: ${describeConversion('mp3', format).label}.`)
  }
  if (DOWNLOAD_FORMATS[format].lossless) {
    lines.push(
      kinds.youtube
        ? 'YouTube audio is never lossless: converting it gives a bigger file, not a better one.'
        : 'Lossy audio never becomes lossless: converting it gives a bigger file, not a better one.',
    )
  }
  if (format === 'mp3') {
    lines.push(`MP3 files are encoded at ${options.mp3Kbps ?? DEFAULT_MP3_KBPS} kbps.`)
  }
  lines.push(
    'Where a song isn’t in this format already, FXM converts it on this device once it is downloaded, which takes a little while.',
  )
  return lines
}
