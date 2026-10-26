/**
 * A lane that runs tasks one at a time, in the order they were queued. Local files run every
 * scan through one, and prune unused covers in it when nothing else waits, so no two scans hand
 * out the same new ID and a prune never deletes a cover a running scan just stored. One scan at
 * a time also keeps the page responsive when several folders are scanned at the start of a
 * visit.
 *
 * @module
 */

/** Runs tasks one at a time, first queued first. */
export class SerialLane {
  #running = false
  readonly #waiting: (() => void)[] = []
  readonly #idle: (() => void)[] = []

  /** Called whenever the last task is over and none waits; it may queue more. */
  onIdle: (() => void) | undefined

  /** Whether a task runs or waits. */
  get busy(): boolean {
    return this.#running
  }

  /**
   * Runs `task` once every task queued before it is over, and resolves to what it returns.
   * When `signal` aborts while the task waits, it never runs and this resolves to `undefined`.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    if (!(await this.#turn(signal))) return undefined
    try {
      return await task()
    } finally {
      this.#release()
    }
  }

  /** Resolves once no task runs or waits. */
  whenIdle(): Promise<void> {
    if (!this.#running) return Promise.resolve()
    return new Promise((resolve) => {
      this.#idle.push(resolve)
    })
  }

  #turn(signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    if (!this.#running) {
      this.#running = true
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const start = () => {
        signal?.removeEventListener('abort', cancel)
        resolve(true)
      }
      const cancel = () => {
        const index = this.#waiting.indexOf(start)
        if (index >= 0) this.#waiting.splice(index, 1)
        resolve(false)
      }
      this.#waiting.push(start)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  #release(): void {
    // The next task takes the lane over: it stays busy.
    const next = this.#waiting.shift()
    if (next !== undefined) {
      next()
      return
    }
    this.#running = false
    this.onIdle?.()
    if (!this.#running) for (const resolve of this.#idle.splice(0)) resolve()
  }
}
