/**
 * The conversion worker's side (`@fxm/convert/worker`): it receives jobs, loads the ffmpeg core
 * the first time a job needs it, runs the export and answers. A worker script is two lines:
 *
 * ```ts
 * import { serveConversions } from '@fxm/convert/worker'
 * serveConversions(self)
 * ```
 *
 * Jobs run one at a time, because the core is one WebAssembly instance with one file system.
 * A core that failed to load is tried again on the next job, and one that stopped mid-way (out
 * of memory, a crash) is replaced, since its memory can't be trusted any more.
 *
 * @module
 */

import { type CoreLoaderOptions, type FfmpegCore, loadFfmpegCore } from './core'
import { exportAudio } from './exporter'
import type { ConverterReply, ConverterRequest } from './protocol'
import { ConvertError, isConvertError } from './types'

/** The parts of a worker's global scope the worker uses. */
export interface ConversionWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<ConverterRequest>) => void): void
  postMessage(message: ConverterReply): void
}

/** Options for {@link serveConversions}. */
export interface ServeOptions {
  /** Loads the core from a base URL. Default: {@link loadFfmpegCore}. */
  loadCore?: (base: string, options?: CoreLoaderOptions) => Promise<FfmpegCore>
}

/**
 * `error` as a {@link ConvertError} for the page. Damaged or unsupported input already is one
 * (from the MP4 reader and the plan); a RangeError from a failed allocation means the browser ran
 * out of memory (a long video, a long mix); anything else is a failure.
 */
export function toConvertError(error: unknown): ConvertError {
  if (error instanceof ConvertError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RangeError && /allocation|memory/i.test(message)) {
    return new ConvertError('out-of-memory', message, { cause: error })
  }
  return new ConvertError('failed', message, { cause: error })
}

/**
 * Whether a core's error means it stopped mid-way: out of memory, or a trap, which the core
 * reports with its cause (core.ts). A plain FFmpeg error leaves the core usable.
 */
function stoppedMidway(error: unknown): boolean {
  return isConvertError(error) && (error.code === 'out-of-memory' || error.cause !== undefined)
}

/** Answers conversion jobs on `scope`, one at a time. */
export function serveConversions(scope: ConversionWorkerScope, options: ServeOptions = {}): void {
  const load = options.loadCore ?? loadFfmpegCore
  let core: { base: string; promise: Promise<FfmpegCore> } | undefined
  const getCore = (base: string) => {
    if (core?.base !== base) {
      const promise = load(base)
      core = { base, promise }
      // A core that failed to load is tried again next time.
      promise.catch(() => {
        if (core?.promise === promise) core = undefined
      })
    }
    return core.promise
  }

  /**
   * The core for `base`, which forgets itself when a conversion stops it mid-way, even when the
   * export goes on without it (an original saved untagged), so the next job gets a fresh one.
   */
  const coreFor = async (base: string): Promise<FfmpegCore> => {
    const promise = getCore(base)
    const loaded = await promise
    const forgetIfStopped = (error: unknown): never => {
      if (stoppedMidway(error) && core?.promise === promise) core = undefined
      throw error
    }
    return {
      version: loaded.version,
      convert: (input, job, convertOptions) =>
        loaded.convert(input, job, convertOptions).catch(forgetIfStopped),
      probe: (input, extension) => loaded.probe(input, extension).catch(forgetIfStopped),
    }
  }
  let queue: Promise<void> = Promise.resolve()

  const run = async ({ id, coreBase, job }: ConverterRequest) => {
    try {
      const result = await exportAudio(job, { loadCore: () => coreFor(coreBase) }, (done) =>
        scope.postMessage({ id, type: 'progress', done }),
      )
      scope.postMessage({ id, type: 'done', blob: result.blob, tagged: result.tagged })
    } catch (error) {
      const failure = toConvertError(error)
      // Out of memory anywhere: a fresh core next time gives the browser the old one's memory.
      if (failure.code === 'out-of-memory') core = undefined
      scope.postMessage({ id, type: 'error', code: failure.code, message: failure.message })
    }
  }

  scope.addEventListener('message', (event) => {
    const request = event.data
    if (request?.type !== 'export') return
    queue = queue.then(() => run(request))
  })
}
