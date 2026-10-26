/**
 * The messages between the page and the conversion worker. The page sends one job at a time
 * (client.ts); the worker answers with progress, then the file or an error (worker.ts). Blobs
 * cross by reference, so the stored download isn't copied on the way.
 *
 * @module
 */

import type { DownloadFormat } from '@fxm/core'
import type { ExportOptions } from './plan'
import type { ConvertErrorCode, ExportTags, SourceAudio } from './types'

/** One file to save, as the worker receives it. */
export interface ExportJob {
  /** The stored download: its original bytes. */
  readonly input: Blob
  /** What it holds (the download record's `format`). */
  readonly source: SourceAudio
  readonly format: DownloadFormat
  readonly options?: ExportOptions
  readonly tags: ExportTags
}

/** Page → worker. */
export interface ConverterRequest {
  readonly id: number
  readonly type: 'export'
  /** Where the ffmpeg core's files are: a URL ending in `/`. */
  readonly coreBase: string
  readonly job: ExportJob
}

/** Worker → page. */
export type ConverterReply =
  | { readonly id: number; readonly type: 'progress'; readonly done: number }
  | {
      readonly id: number
      readonly type: 'done'
      readonly blob: Blob
      /** Whether the tags made it into the file. */
      readonly tagged: boolean
    }
  | {
      readonly id: number
      readonly type: 'error'
      readonly code: ConvertErrorCode
      readonly message: string
    }
