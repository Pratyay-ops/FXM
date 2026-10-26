/**
 * Saving a download in a format: the plan's steps in order. The audio of a video (itag 18) is
 * extracted with mp4box.js, the ffmpeg core remuxes or re-encodes when the plan says so, and
 * FXM's writers add the tags, cover and lyrics. Runs in the conversion worker; tests run it in
 * Node with a fake core.
 *
 * @module
 */

import type { DownloadFormat } from '@fxm/core'
import { concat } from './bytes'
import type { FfmpegCore } from './core'
import { demuxMp4Audio } from './mp4/demux'
import { writeM4a } from './mp4/write'
import { type CoreJob, type ExportOptions, type ExportPlan, planExport } from './plan'
import { joinedArtists, plainLyrics, positive } from './tags/fields'
import { writeFlacTags } from './tags/flac'
import { writeMp3Tags } from './tags/id3v2'
import { writeOggTags } from './tags/ogg'
import { writeWavTags } from './tags/riff'
import { type ExportTags, isConvertError, type SourceAudio } from './types'

/** One file to save. */
export interface ExportRequest {
  /** The stored file: the original bytes of the download. */
  readonly input: Blob | Uint8Array
  /** What it holds (a download record's `format`). */
  readonly source: SourceAudio
  readonly format: DownloadFormat
  readonly options?: ExportOptions
  readonly tags: ExportTags
}

/** A saved file. */
export interface ExportResult {
  readonly blob: Blob
  readonly plan: ExportPlan
  /**
   * Whether the tags made it into the file. A file whose own structure FXM can't edit (a WAV
   * with sizes it never fixed, FLAC inside Ogg), or an original WebM when the core can't write
   * its tags, is saved without them rather than not at all.
   */
  readonly tagged: boolean
}

/** What {@link exportAudio} needs from its surroundings. */
export interface ExporterDependencies {
  /** The ffmpeg core, loaded on first use: only plans with a core step call it. */
  loadCore(): Promise<FfmpegCore>
}

/** The extension the core names an input with, which helps it recognise the container. */
export function inputExtension(source: Pick<SourceAudio, 'container' | 'codec'>): string {
  switch (source.container) {
    case 'mp4':
    case 'm4a':
      return 'm4a'
    case 'ogg':
      return source.codec === 'opus' ? 'opus' : 'ogg'
    default:
      return source.container
  }
}

/** The tags the WebM muxer writes, in FFmpeg's generic names (it maps them to Matroska's). */
export function containerTags(tags: ExportTags): Record<string, string> {
  const metadata: Record<string, string> = {}
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && String(value).trim() !== '') metadata[key] = String(value)
  }
  set('title', tags.title)
  set('artist', joinedArtists(tags))
  set('album', tags.album)
  set('track', positive(tags.trackNumber))
  set('date', tags.releaseDate)
  set('ISRC', tags.isrc)
  set('lyrics', plainLyrics(tags))
  return metadata
}

async function bytesOf(input: Blob | Uint8Array): Promise<Uint8Array> {
  return input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input
}

/** `bytes` with `tags`, by the plan's writer; untagged when the file's structure refuses. */
function tagged(
  plan: ExportPlan,
  bytes: Uint8Array,
  tags: ExportTags,
): { parts: Uint8Array[]; tagged: boolean } {
  try {
    switch (plan.tags) {
      case 'id3v2':
        return { parts: [writeMp3Tags(bytes, tags)], tagged: true }
      case 'flac':
        return { parts: [writeFlacTags(bytes, tags)], tagged: true }
      case 'riff':
        return { parts: [writeWavTags(bytes, tags)], tagged: true }
      case 'ogg': {
        const result = writeOggTags(bytes, tags)
        return { parts: [result.bytes], tagged: result.tagged }
      }
      case 'mp4':
        // Rewritten from its samples: YouTube's fragmented M4A and the core's output alike
        // become one plain M4A file with the movie box first.
        return { parts: writeM4a(demuxMp4Audio(bytes), tags), tagged: true }
      case 'core':
        // The muxer wrote them.
        return { parts: [bytes], tagged: true }
    }
  } catch {
    return { parts: [bytes], tagged: false }
  }
}

/**
 * Whether the plan's file may be the stored file itself, untouched, when the core can't run:
 * Original, whose core step (WebM's) only remuxes it to write its tags.
 */
function keepsOriginal(plan: ExportPlan): boolean {
  return plan.format === 'original' && !plan.extractAudio && plan.core?.codec === 'copy'
}

/**
 * Saves `request.input` as `request.format`: the file, its plan and whether it got its tags.
 * `onProgress` gets the fraction done, 0 to 1 (the core's work is nearly all of it).
 *
 * Original never fails for want of the core: when the core can't load or can't remux a WebM
 * with its tags, the stored file is saved as it is, with `tagged: false`.
 *
 * @throws ConvertError when the core can't load or the conversion fails, `corrupt-input` when
 * the input isn't the file its format says (a video that isn't MP4, say), `unsupported-input`
 * for a source FXM can't save. A RangeError means memory ran out.
 */
export async function exportAudio(
  request: ExportRequest,
  dependencies: ExporterDependencies,
  onProgress?: (done: number) => void,
): Promise<ExportResult> {
  const plan = planExport(request.source, request.format, request.options)
  const type = plan.output.mimeType
  let input: Blob | Uint8Array = request.input
  let extension = inputExtension(request.source)

  if (plan.extractAudio) {
    // itag 18: the AAC track alone, never the video.
    const track = demuxMp4Audio(await bytesOf(input))
    if (plan.core === undefined) {
      onProgress?.(1)
      return {
        blob: new Blob(writeM4a(track, request.tags) as BlobPart[], { type }),
        plan,
        tagged: true,
      }
    }
    input = concat(writeM4a(track))
    extension = 'm4a'
  }

  let output: Uint8Array
  if (plan.core === undefined) {
    output = await bytesOf(input)
  } else {
    const job: CoreJob =
      plan.tags === 'core' ? { ...plan.core, metadata: containerTags(request.tags) } : plan.core
    try {
      const core = await dependencies.loadCore()
      output = await core.convert(input, job, {
        inputExtension: extension,
        outputExtension: plan.output.extension,
        ...(onProgress === undefined
          ? {}
          : { onProgress: (done: number) => onProgress(done * 0.95) }),
      })
    } catch (error) {
      if (!keepsOriginal(plan) || isConvertError(error, 'cancelled')) throw error
      // The original as it is: untagged rather than not at all.
      onProgress?.(1)
      return {
        blob: new Blob([request.input as BlobPart], { type }),
        plan,
        tagged: false,
      }
    }
  }
  const result = tagged(plan, output, request.tags)
  onProgress?.(1)
  return { blob: new Blob(result.parts as BlobPart[], { type }), plan, tagged: result.tagged }
}
