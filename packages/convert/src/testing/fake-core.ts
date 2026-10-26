/**
 * A stand-in for FXM's ffmpeg core: it records each job and answers with a generated file of the
 * container the job asks for, so the export pipeline runs end to end in tests without the
 * WebAssembly build.
 *
 * @module
 */

import type { Converter } from '../client'
import type { CoreProbe, CoreVersion, FfmpegCore } from '../core'
import { exportAudio } from '../exporter'
import type { CoreJob } from '../plan'
import type { ExportJob } from '../protocol'
import type { ConvertError } from '../types'
import { flacFile, m4aFile, mp3File, oggOpusFile, sineWav } from './audio'

/** One job the fake core ran. */
export interface FakeCoreCall {
  readonly job: CoreJob
  readonly input: Uint8Array
  readonly inputExtension: string
  readonly outputExtension: string
}

/** The first bytes of a WebM file, then the job's tags as JSON, for tests to read back. */
export const FAKE_WEBM_MAGIC = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])

/** A fake {@link FfmpegCore}. */
export class FakeFfmpegCore implements FfmpegCore {
  readonly version: CoreVersion = {
    ffmpeg: 'fake',
    license: 'LGPL version 2.1 or later',
    configuration: '--disable-gpl --disable-nonfree',
  }
  readonly calls: FakeCoreCall[] = []
  /** Makes the next conversion fail with this error. */
  failNext: ConvertError | undefined

  async convert(
    input: Blob | Uint8Array,
    job: CoreJob,
    options: {
      inputExtension: string
      outputExtension: string
      onProgress?: (done: number) => void
    },
  ): Promise<Uint8Array> {
    const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input
    this.calls.push({
      job,
      input: bytes,
      inputExtension: options.inputExtension,
      outputExtension: options.outputExtension,
    })
    const failure = this.failNext
    if (failure !== undefined) {
      this.failNext = undefined
      throw failure
    }
    options.onProgress?.(0.5)
    options.onProgress?.(1)
    switch (job.format) {
      case 'flac':
        return flacFile({ vendor: 'Lavf' })
      case 'ipod':
        return m4aFile({ mediaTime: 1024 })
      case 'wav':
        return sineWav({ seconds: 0.1 })
      case 'mp3':
        return mp3File({ frames: 8 })
      case 'ogg':
        return oggOpusFile({ vendor: 'Lavf' })
      case 'webm': {
        const tags = new TextEncoder().encode(JSON.stringify(job.metadata ?? {}))
        const out = new Uint8Array(FAKE_WEBM_MAGIC.length + tags.length)
        out.set(FAKE_WEBM_MAGIC)
        out.set(tags, FAKE_WEBM_MAGIC.length)
        return out
      }
    }
  }

  async probe(): Promise<CoreProbe> {
    return {
      format: 'wav',
      codec: 'pcm_s16le',
      sampleRate: 44100,
      channels: 2,
      bitsPerRawSample: 16,
      bitRate: 1_411_200,
      durationSeconds: 0.5,
      sampleFormat: 's16',
      streams: 1,
    }
  }
}

/**
 * A {@link Converter} that runs the export in-process on `core` (a fake by default) instead of
 * in a worker: the whole pipeline but the WebAssembly, for app tests. `core` may also be a
 * loader, e.g. one that rejects with `core-unavailable`, as where the core can't load.
 */
export function createInProcessConverter(
  core: FfmpegCore | (() => Promise<FfmpegCore>) = new FakeFfmpegCore(),
): Converter & {
  readonly jobs: ExportJob[]
} {
  const jobs: ExportJob[] = []
  const loadCore = typeof core === 'function' ? core : async () => core
  return {
    jobs,
    async exportAudio(job, options = {}) {
      jobs.push(job)
      options.signal?.throwIfAborted()
      const result = await exportAudio(job, { loadCore }, options.onProgress)
      return { blob: result.blob, tagged: result.tagged }
    },
    dispose() {},
  }
}
