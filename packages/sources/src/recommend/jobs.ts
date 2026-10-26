/**
 * Running the collector's jobs, one per source and part: at once, each settled into an outcome,
 * delivered as it comes, cancelled with the caller's signal and cut off at the caller's deadline.
 * Also a time limit for single calls inside a job (station classification).
 *
 * @module
 */

import { isFxmError, type ProviderContext } from '@fxm/core'
import type { RecommendationPart, RecommendationSource, SkipReason, SourceOutcome } from './types'

/** A job that did not run, and why. */
export class Skip {
  constructor(readonly reason: SkipReason) {}
}

/** One source's job. */
export interface Job<T> {
  /** The source. */
  source: RecommendationSource
  /** The part. */
  part: RecommendationPart
  /** The work, with a context whose signal the deadline and the caller's signal abort. */
  work(ctx: ProviderContext): Promise<T[] | Skip>
  /**
   * Recognises the source's own explicit refusals that are skips, e.g. Spotify's
   * `unsupported-seed`. Anything else it throws is a failure.
   */
  skipFor?(error: unknown): SkipReason | undefined
}

/** What one job yields. */
export interface JobResult<T> {
  /** What the source did. */
  outcome: SourceOutcome
  /** What it found; empty unless the outcome is `ok`. */
  items: T[]
}

/** Options for {@link runJobs}. */
export interface RunOptions<T> {
  /** When to stop waiting, in milliseconds; none when absent. */
  deadlineMs?: number | undefined
  /** Called with each job's result as it settles. */
  onResult?: ((result: JobResult<T>) => void) | undefined
}

/** `value` as a deadline: a finite number of milliseconds from 0, or none. */
export function deadlineOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined
}

/** `promise`, or a rejection with `signal`'s reason as soon as it aborts, whichever comes first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) {
      // Its outcome no longer matters, but a rejection must not go unhandled.
      promise.catch(() => undefined)
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * An `AbortController` that also aborts, with the same reason, when `outer` does. Call `dispose`
 * when done, so that `outer` keeps no listener.
 */
export function linkedController(outer: AbortSignal | undefined): {
  controller: AbortController
  dispose: () => void
} {
  const controller = new AbortController()
  const forward = () => controller.abort(outer?.reason)
  if (outer?.aborted) forward()
  else outer?.addEventListener('abort', forward, { once: true })
  return { controller, dispose: () => outer?.removeEventListener('abort', forward) }
}

/** The reason a job, or a call, is aborted with when it is no longer wanted. */
function noLongerWanted(): DOMException {
  return new DOMException('The result is no longer wanted', 'AbortError')
}

/**
 * Runs one job and settles it into a result. `undefined` when it failed because its signal was
 * aborted: the caller's cancellation or the deadline, which {@link runJobs} reports itself.
 */
async function settle<T>(job: Job<T>, ctx: ProviderContext): Promise<JobResult<T> | undefined> {
  const { source, part } = job
  try {
    const result = await job.work(ctx)
    if (result instanceof Skip) {
      return { items: [], outcome: { source, part, status: 'skipped', reason: result.reason } }
    }
    return { items: result, outcome: { source, part, status: 'ok', count: result.length } }
  } catch (error) {
    if (ctx.signal?.aborted) return undefined
    const reason = job.skipFor?.(error)
    if (reason !== undefined) {
      return { items: [], outcome: { source, part, status: 'skipped', reason } }
    }
    const code = isFxmError(error) ? error.code : 'Unknown'
    const message = error instanceof Error ? error.message : String(error)
    return { items: [], outcome: { source, part, status: 'failed', code, message, error } }
  }
}

/**
 * Runs `jobs` at once and returns their results in the jobs' order. Each result goes to
 * `onResult` as soon as its job settles. When `deadlineMs` passes first, the jobs still running
 * are cancelled (their context's signal aborts) and reported as `timed-out`. When `ctx.signal`
 * aborts, it rejects with the signal's reason at once, whether or not the jobs heed it. An
 * `onResult` that throws makes it reject with that error.
 */
export async function runJobs<T>(
  jobs: readonly Job<T>[],
  ctx: ProviderContext,
  { deadlineMs, onResult }: RunOptions<T> = {},
): Promise<JobResult<T>[]> {
  const outer = ctx.signal
  outer?.throwIfAborted()
  const { controller, dispose } = linkedController(outer)
  const jobCtx: ProviderContext = { ...ctx, signal: controller.signal }
  const results: Array<JobResult<T> | undefined> = jobs.map(() => undefined)
  let open = true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const all = Promise.all(
      jobs.map(async (job, index) => {
        const result = await settle(job, jobCtx)
        if (!open || result === undefined) return
        results[index] = result
        onResult?.(result)
      }),
    )
    const cutOff =
      deadlineMs === undefined
        ? undefined
        : new Promise<void>((resolve) => {
            timer = setTimeout(resolve, deadlineMs)
          })
    await untilAborted(cutOff === undefined ? all : Promise.race([all, cutOff]), outer)
  } finally {
    open = false
    clearTimeout(timer)
    dispose()
    // Whatever is still running is no longer wanted: stop its requests.
    if (results.includes(undefined) && !controller.signal.aborted) {
      controller.abort(noLongerWanted())
    }
  }
  return jobs.map((job, index) => {
    const result = results[index]
    if (result !== undefined) return result
    const late: JobResult<T> = {
      items: [],
      outcome: {
        source: job.source,
        part: job.part,
        status: 'timed-out',
        afterMs: deadlineMs ?? 0,
      },
    }
    onResult?.(late)
    return late
  })
}

/** What {@link beforeDeadline} resolves with when the time ran out. */
export const TIMED_OUT: unique symbol = Symbol('timed out')

/**
 * Runs `work` with a signal of its own, and resolves with {@link TIMED_OUT} when it has not
 * finished by `until` (epoch milliseconds), after aborting that signal so that its request stops.
 * Rejects with `outer`'s reason as soon as it aborts.
 */
export async function beforeDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  until: number,
  outer: AbortSignal | undefined,
): Promise<T | typeof TIMED_OUT> {
  outer?.throwIfAborted()
  const { controller, dispose } = linkedController(outer)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeUp = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, until - Date.now()))
  })
  try {
    const result = await untilAborted(Promise.race([work(controller.signal), timeUp]), outer)
    if (result === TIMED_OUT) controller.abort(noLongerWanted())
    return result
  } finally {
    clearTimeout(timer)
    dispose()
  }
}
