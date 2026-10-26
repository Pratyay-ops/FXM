/**
 * Loudness for downloads (stage 8.1): a completed download keeps the loudness its stream had
 * (`format.loudness`, e.g. YouTube's `loudnessDb`, which `@fxm/downloads` records). When the
 * stream said nothing, the file's own ReplayGain or R128 tags fill it in, e.g. an Internet Archive
 * FLAC its uploader tagged, so loudness normalization plays the offline copy at the user's level.
 *
 * @module
 */

import type { StreamLoudness } from '@fxm/core'
import type { DownloadRecord, DownloadStorage, DownloadStore } from '@fxm/downloads'
import { mimeTypeOf } from '@fxm/player'
import { loudnessOfTags } from '../local-files/tags'

/** How loud a file is, from its tags (music-metadata, loaded on first use; never the audio). */
export async function readFileLoudness(file: Blob): Promise<StreamLoudness | undefined> {
  const { parseBlob } = await import('music-metadata')
  const metadata = await parseBlob(file, { duration: false, skipCovers: true })
  return loudnessOfTags(metadata)
}

/** What {@link attachFileLoudness} reads and writes. */
export interface FileLoudnessDeps {
  readonly storage: Pick<DownloadStorage, 'read'>
  readonly store: Pick<DownloadStore, 'update'>
  /** Reads a file's loudness. Default: {@link readFileLoudness}. */
  readonly read?: (file: Blob) => Promise<StreamLoudness | undefined>
}

/**
 * Gives completed download `record` its file's loudness, when its stream said none and the file's
 * tags say how loud it is. The record changes only while it is still that completed file without
 * a loudness, so a download deleted or replaced meanwhile stays as it is. Never rejects.
 */
export async function attachFileLoudness(
  record: DownloadRecord,
  deps: FileLoudnessDeps,
): Promise<void> {
  const { file, format } = record
  if (record.status !== 'completed' || file === undefined || format === undefined) return
  if (format.loudness !== undefined) return
  try {
    const blob = await deps.storage.read(file, mimeTypeOf(format) ?? 'application/octet-stream')
    if (blob === undefined) return
    const loudness = await (deps.read ?? readFileLoudness)(blob)
    if (loudness === undefined) return
    await deps.store.update(record.id, (current) => {
      if (
        current?.status !== 'completed' ||
        current.file !== file ||
        current.format === undefined ||
        current.format.loudness !== undefined
      ) {
        return undefined
      }
      return { ...current, format: { ...current.format, loudness } }
    })
  } catch {
    // A file that can't be read or parsed plays at its own level.
  }
}
