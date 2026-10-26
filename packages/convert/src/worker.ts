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
import { ConvertError } from './types'

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
  let queue: Promise<void> = Promise.resolve()

  const run = async ({ id, coreBase, job }: ConverterRequest) => {
    try {
      const result = await exportAudio(job, { loadCore: () => getCore(coreBase) }, (done) =>
        scope.postMessage({ id, type: 'progress', done }),
      )
      scope.postMessage({ id, type: 'done', blob: result.blob, tagged: result.tagged })
    } catch (error) {
      // A RangeError says the file isn't what its format claims (an MP4 that isn't one).
      const failure =
        error instanceof ConvertError
          ? error
          : new ConvertError(
              error instanceof RangeError ? 'corrupt-input' : 'failed',
              error instanceof Error ? error.message : String(error),
            )
      if (failure.code === 'out-of-memory' || failure.cause !== undefined) {
        // The core stopped mid-way: start a fresh one for the next job.
        core = undefined
      }
      scope.postMessage({ id, type: 'error', code: failure.code, message: failure.message })
    }
  }

  scope.addEventListener('message', (event) => {
    const request = event.data
    if (request?.type !== 'export') return
    queue = queue.then(() => run(request))
  })
}
