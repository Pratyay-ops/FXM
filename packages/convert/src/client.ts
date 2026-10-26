/**
 * The page's side of the conversion worker: a queue of export jobs, sent to the worker one at a
 * time. Cancelling the running job terminates the worker (the core can't be interrupted mid-
 * conversion), and the next job starts a fresh one; a worker that fails or crashes fails only
 * the job it was running.
 *
 * @module
 */

import type { ConverterReply, ConverterRequest, ExportJob } from './protocol'
import { ConvertError } from './types'

/** The parts of a `Worker` the converter uses. */
export interface ConverterWorker {
  postMessage(message: ConverterRequest): void
  addEventListener(type: 'message', listener: (event: MessageEvent<ConverterReply>) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void
  terminate(): void
}

/** Options for {@link createConverter}. */
export interface ConverterOptions {
  /** Starts a conversion worker (`new Worker(new URL(…), { type: 'module' })`). */
  createWorker: () => ConverterWorker
  /**
   * Where the ffmpeg core's files are: a URL ending in `/`, by default the app's `ffmpeg/`
   * folder.
   */
  coreBase: string
}

/** What an export job gives back. */
export interface ExportOutcome {
  readonly blob: Blob
  /** Whether the tags made it into the file. */
  readonly tagged: boolean
}

/** Options for one job. */
export interface ExportJobOptions {
  /** The fraction done, 0 to 1. */
  onProgress?: (done: number) => void
  /** Cancels the job: queued, it never starts; running, the worker is stopped. */
  signal?: AbortSignal
}

/** Saves downloads in other formats, in a worker. */
export interface Converter {
  /** Runs `job` after the jobs before it. */
  exportAudio(job: ExportJob, options?: ExportJobOptions): Promise<ExportOutcome>
  /** Stops the worker and fails every job not done yet. */
  dispose(): void
}

interface Pending {
  readonly id: number
  readonly job: ExportJob
  readonly options: ExportJobOptions
  readonly resolve: (outcome: ExportOutcome) => void
  readonly reject: (error: Error) => void
}

function cancelled(): ConvertError {
  return new ConvertError('cancelled', 'The conversion was cancelled')
}

/** A {@link Converter} on workers that `options.createWorker` starts. */
export function createConverter(options: ConverterOptions): Converter {
  const waiting: Pending[] = []
  let running: Pending | undefined
  let worker: ConverterWorker | undefined
  let nextId = 0

  const stopWorker = () => {
    const current = worker
    worker = undefined
    try {
      current?.terminate()
    } catch {
      // Gone already.
    }
  }

  const settle = (job: Pending, outcome: { value: ExportOutcome } | { error: Error }) => {
    if (running !== job) return
    running = undefined
    job.options.signal?.removeEventListener('abort', onAbort)
    if ('value' in outcome) job.resolve(outcome.value)
    else job.reject(outcome.error)
    pump()
  }

  const onReply = (event: MessageEvent<ConverterReply>) => {
    const reply = event.data
    const job = running
    if (job === undefined || reply.id !== job.id) return
    if (reply.type === 'progress') job.options.onProgress?.(reply.done)
    else if (reply.type === 'done')
      settle(job, { value: { blob: reply.blob, tagged: reply.tagged } })
    else settle(job, { error: new ConvertError(reply.code, reply.message) })
  }

  const onFailure = () => {
    stopWorker()
    if (running)
      settle(running, { error: new ConvertError('failed', 'The conversion worker failed') })
  }

  const ensureWorker = () => {
    if (worker) return worker
    const started = options.createWorker()
    // Events of a worker that was stopped or replaced must not touch the next one's job.
    const current =
      <T>(listener: (event: T) => void) =>
      (event: T) => {
        if (worker === started) listener(event)
      }
    started.addEventListener('message', current(onReply))
    started.addEventListener('error', current(onFailure))
    started.addEventListener('messageerror', current(onFailure))
    worker = started
    return started
  }

  function onAbort() {
    if (running?.options.signal?.aborted) {
      // The core can't be interrupted: stop the worker, and the next job starts another.
      stopWorker()
      settle(running, { error: cancelled() })
    }
  }

  function pump() {
    if (running) return
    const next = waiting.shift()
    if (!next) return
    if (next.options.signal?.aborted) {
      next.reject(cancelled())
      pump()
      return
    }
    running = next
    next.options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      ensureWorker().postMessage({
        id: next.id,
        type: 'export',
        coreBase: options.coreBase,
        job: next.job,
      })
    } catch (error) {
      stopWorker()
      settle(next, {
        error: new ConvertError('failed', `The conversion worker can't start: ${String(error)}`),
      })
    }
  }

  return {
    exportAudio(job, jobOptions = {}) {
      return new Promise<ExportOutcome>((resolve, reject) => {
        nextId += 1
        const pending: Pending = { id: nextId, job, options: jobOptions, resolve, reject }
        if (jobOptions.signal?.aborted) {
          reject(cancelled())
          return
        }
        waiting.push(pending)
        jobOptions.signal?.addEventListener(
          'abort',
          () => {
            const at = waiting.indexOf(pending)
            if (at !== -1) {
              waiting.splice(at, 1)
              reject(cancelled())
            }
          },
          { once: true },
        )
        pump()
      })
    },
    dispose() {
      stopWorker()
      const failed = new ConvertError('cancelled', 'The converter was closed')
      if (running) {
        const job = running
        running = undefined
        job.reject(failed)
      }
      for (const job of waiting.splice(0)) job.reject(failed)
    },
  }
}
