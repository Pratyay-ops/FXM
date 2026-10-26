/**
 * A strict request queue: tasks start one at a time, at least `intervalMs` apart from start to
 * start, higher priorities first and in the order they were queued within a priority.
 * MusicBrainz allows each IP address one request per second on average and answers 503 to all of
 * them while the rate is above that, so every MusicBrainz request in the app goes through one
 * shared queue (`musicBrainzQueue`), where the track the user is waiting for never queues behind
 * an import.
 *
 * @module
 */

/**
 * What a task is for, highest priority first, in the words of the platform's request budget
 * (stage 1.2), so a caller can pass its priority through:
 *
 * - `current-track`: the track that is playing or about to play
 * - `prefetch`: the next tracks in the queue
 * - `interactive`: search, pages and anything else the user opened
 * - `bulk`: background work nobody waits for, such as imports
 */
export type RequestPriority = 'current-track' | 'prefetch' | 'interactive' | 'bulk'

/** Every {@link RequestPriority}, highest first. */
const PRIORITIES: readonly RequestPriority[] = ['current-track', 'prefetch', 'interactive', 'bulk']

/** How {@link RequestQueue.run} queues a task. */
export interface RunOptions {
  /**
   * Removes the task from the queue while it waits, and its promise then rejects with the
   * signal's reason; once started, cancelling is up to the task itself.
   */
  signal?: AbortSignal
  /** Which tasks start first. `interactive` by default. */
  priority?: RequestPriority
  /**
   * The longest the task may wait for a pause to end (see {@link RequestQueue.pause}), in
   * milliseconds, counted from when it was queued. A task that would wait longer rejects with a
   * {@link QueuePausedError} at once, when it is queued or when a later pause makes it so; the
   * pause still holds for every other task. No limit by default.
   */
  maxWaitMs?: number
}

/** Why a task left the queue unstarted: a pause would have kept it waiting too long. */
export class QueuePausedError extends Error {
  override readonly name = 'QueuePausedError'

  /** @param retryAfterMs How long the pause still lasts, in milliseconds. */
  constructor(readonly retryAfterMs: number) {
    super(`The queue is paused for another ${retryAfterMs} ms`)
  }
}

/** One queued task. */
interface Job {
  /** Starts the task and settles the caller's promise with its outcome. */
  start(): void
  /** Removes the job, unstarted, and rejects the caller's promise with `error`. */
  fail(error: unknown): void
  /** The caller's signal, which removes the job while it waits. */
  signal: AbortSignal | undefined
  /** Removes the job and rejects with the signal's reason. */
  onAbort(): void
  /** Its priority's place in {@link PRIORITIES}: lower starts first. */
  rank: number
  /** The latest a pause may end for it, in epoch milliseconds. */
  deadline: number
}

/** Runs tasks one after another, at least {@link RequestQueue.intervalMs} apart. */
export class RequestQueue {
  /** The waiting jobs, in the order they will start. */
  private readonly jobs: Job[] = []
  /** The earliest start of the next task by the spacing, in epoch milliseconds. */
  private nextAt = 0
  /** When the current pause ends, in epoch milliseconds. */
  private pausedUntil = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  /** @param intervalMs The shortest time between the starts of two tasks. */
  constructor(readonly intervalMs: number) {}

  /**
   * Runs `task` when its turn comes and settles with its outcome. A task that fails does not
   * hold up the next one. See {@link RunOptions} for priorities, cancelling and waiting limits.
   */
  run<T>(task: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    const { signal, priority = 'interactive', maxWaitMs = Number.POSITIVE_INFINITY } = options
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      const now = Date.now()
      if (this.pausedUntil - now > maxWaitMs) {
        reject(new QueuePausedError(this.pausedUntil - now))
        return
      }
      const remove = () => {
        const index = this.jobs.indexOf(job)
        if (index < 0) return false
        this.jobs.splice(index, 1)
        signal?.removeEventListener('abort', job.onAbort)
        return true
      }
      const job: Job = {
        start: () => {
          new Promise<T>((settle) => settle(task())).then(resolve, reject)
        },
        fail: (error) => {
          if (remove()) reject(error)
        },
        signal,
        onAbort: () => {
          if (remove()) reject(signal?.reason)
        },
        rank: Math.max(0, PRIORITIES.indexOf(priority)),
        deadline: now + maxWaitMs,
      }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      // After every job of the same or a higher priority: first come, first served within one.
      const after = this.jobs.findIndex((other) => other.rank > job.rank)
      this.jobs.splice(after < 0 ? this.jobs.length : after, 0, job)
      this.pump()
    })
  }

  /**
   * Holds back every waiting and future task until at least `ms` from now, e.g. when the
   * service answered 503 and asked FXM to slow down. Waiting tasks whose `maxWaitMs` the pause
   * would exceed reject at once with a {@link QueuePausedError}.
   */
  pause(ms: number): void {
    const now = Date.now()
    const until = now + Math.max(0, ms)
    if (until <= this.pausedUntil) return
    this.pausedUntil = until
    for (const job of [...this.jobs]) {
      if (job.deadline < until) job.fail(new QueuePausedError(until - now))
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pump()
  }

  /** How many tasks are waiting for their turn. */
  get waiting(): number {
    return this.jobs.length
  }

  /** Starts the next task if its turn has come, else sets a timer for it. */
  private pump(): void {
    if (this.timer !== undefined) return
    const job = this.jobs[0]
    if (job === undefined) return
    const wait = Math.max(this.nextAt, this.pausedUntil) - Date.now()
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.pump()
      }, wait)
      return
    }
    this.jobs.shift()
    job.signal?.removeEventListener('abort', job.onAbort)
    this.nextAt = Date.now() + this.intervalMs
    job.start()
    this.pump()
  }
}
