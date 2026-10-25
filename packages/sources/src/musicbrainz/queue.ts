/**
 * A strict request queue: tasks start one at a time, in the order they were queued, at least
 * `intervalMs` apart from start to start. MusicBrainz allows each IP address one request per
 * second on average and answers 503 to all of them while the rate is above that, so every
 * MusicBrainz request in the app goes through one shared queue (`musicBrainzQueue`).
 *
 * @module
 */

/** One queued task. */
interface Job {
  /** Starts the task and settles the caller's promise with its outcome. */
  start(): void
  /** The caller's signal, which removes the job while it waits. */
  signal: AbortSignal | undefined
  /** Removes the job and rejects with the signal's reason. */
  onAbort(): void
}

/** Runs tasks one after another, at least {@link RequestQueue.intervalMs} apart. */
export class RequestQueue {
  private readonly jobs: Job[] = []
  /** The earliest start of the next task, in epoch milliseconds. */
  private nextAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  /** @param intervalMs The shortest time between the starts of two tasks. */
  constructor(readonly intervalMs: number) {}

  /**
   * Runs `task` when its turn comes and settles with its outcome. A task that fails does not
   * hold up the next one. While it waits, `signal` removes it from the queue, and the promise
   * rejects with the signal's reason; once started, cancelling is up to the task itself.
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      const job: Job = {
        start: () => {
          new Promise<T>((settle) => settle(task())).then(resolve, reject)
        },
        signal,
        onAbort: () => {
          const index = this.jobs.indexOf(job)
          if (index < 0) return
          this.jobs.splice(index, 1)
          reject(signal?.reason)
        },
      }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      this.jobs.push(job)
      this.pump()
    })
  }

  /**
   * Holds back every waiting and future task until at least `ms` from now, e.g. when the
   * service answered 503 and asked FXM to slow down.
   */
  pause(ms: number): void {
    const until = Date.now() + Math.max(0, ms)
    if (until <= this.nextAt) return
    this.nextAt = until
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
    const wait = this.nextAt - Date.now()
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
