/**
 * When automatic sync runs. Pure scheduling with injectable timers; the agent (`agent.tsx`)
 * feeds it the browser's events.
 *
 * - **Start, return and reconnection:** a sync when the app starts, when the user comes back to
 *   it (at most once a minute) and when the device is back online.
 * - **Edits** (playlists, likes, follows, settings) sync a few seconds after the last one, and
 *   at the latest half a minute after the first, so other devices see them soon.
 * - **Background changes** (plays, the track cache, pins) wait longer, ten quiet minutes and
 *   at most an hour: GitHub sends the whole gist back after each push, and a song played every
 *   few minutes would otherwise mean a push every few minutes.
 * - **Failures** are retried after a backoff: 30 seconds, doubling up to 30 minutes, or as long
 *   as GitHub asks, whether or not anything else asks for a sync meanwhile. A failure only the
 *   user can fix (a revoked token, a deleted gist) stops automatic sync.
 *
 * Runs never overlap: a trigger during a run runs once more afterwards.
 *
 * @module
 */

/** What started a sync. */
export type SyncTrigger = 'start' | 'focus' | 'online' | 'interval' | 'change' | 'manual'

/** How a run went, as the scheduler needs to know. */
export type RunResult =
  | { ok: true }
  | {
      ok: false
      /** Only the user can fix it: stop until the scheduler is recreated. */
      fatal: boolean
      /** How long GitHub asked to wait. */
      retryAfterMs?: number
    }

/** Which library changes trigger a sync how soon. */
export type ChangeKind = 'edit' | 'background'

export interface SchedulerOptions {
  run(trigger: SyncTrigger): Promise<RunResult>
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Quiet time after an edit before syncing. */
  editDelayMs?: number
  /** Longest an edit waits while edits keep coming. */
  editMaxWaitMs?: number
  /** Quiet time after a background change. */
  backgroundDelayMs?: number
  /** Longest a background change waits. */
  backgroundMaxWaitMs?: number
  /** Least time between syncs that coming back to the app or the periodic timer start. */
  throttleMs?: number
}

/** The scheduler's controls. */
export interface SyncScheduler {
  /** Asks for a sync: `start` and `manual` always run, the others at most once per throttle. */
  trigger(trigger: SyncTrigger): void
  /** The library changed. */
  changed(kind: ChangeKind): void
  /** The device is back online: forget the backoff and sync. */
  online(): void
  /** Stops for good, cancelling what is planned (a running sync finishes). */
  stop(): void
}

/** The wait after the `failures`-th failure in a row: 30 s, doubling, at most 30 minutes. */
export function backoffMs(failures: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1))
}

export function createSyncScheduler(options: SchedulerOptions): SyncScheduler {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const editDelay = options.editDelayMs ?? 5_000
  const editMaxWait = options.editMaxWaitMs ?? 30_000
  const backgroundDelay = options.backgroundDelayMs ?? 10 * 60_000
  const backgroundMaxWait = options.backgroundMaxWaitMs ?? 60 * 60_000
  const throttle = options.throttleMs ?? 60_000

  let stopped = false
  let halted = false
  let running = false
  let again: SyncTrigger | undefined
  let lastRunAt = Number.NEGATIVE_INFINITY
  let failures = 0
  let blockedUntil = 0
  // The next run.
  let timer: unknown
  let dueAt = Number.POSITIVE_INFINITY
  let dueTrigger: SyncTrigger = 'start'
  // Pending changes, debounced.
  let changeTimer: unknown
  let changeDueAt = Number.POSITIVE_INFINITY
  let firstChangeAt: number | undefined
  let changeKind: ChangeKind = 'background'

  function plan(trigger: SyncTrigger): void {
    if (stopped || halted) return
    const at = Math.max(now(), blockedUntil)
    if (timer !== undefined && dueAt <= at) return
    if (timer !== undefined) clearTimer(timer)
    dueAt = at
    dueTrigger = trigger
    timer = setTimer(() => {
      timer = undefined
      dueAt = Number.POSITIVE_INFINITY
      void fire(dueTrigger)
    }, at - now())
  }

  async function fire(trigger: SyncTrigger): Promise<void> {
    if (stopped || halted) return
    if (running) {
      again = trigger
      return
    }
    running = true
    let result: RunResult
    try {
      result = await options.run(trigger)
    } catch {
      result = { ok: false, fatal: false }
    }
    running = false
    lastRunAt = now()
    if (result.ok) {
      failures = 0
      blockedUntil = 0
    } else if (result.fatal) {
      halted = true
      cancel()
      return
    } else {
      failures++
      blockedUntil = now() + Math.max(result.retryAfterMs ?? 0, backoffMs(failures))
      // Try again once the wait is over (`plan` waits for it), unless a trigger that came
      // during the run asks for a sync anyway.
      again ??= trigger
    }
    if (again !== undefined) {
      const next = again
      again = undefined
      plan(next)
    }
  }

  function cancel(): void {
    if (timer !== undefined) clearTimer(timer)
    if (changeTimer !== undefined) clearTimer(changeTimer)
    timer = undefined
    changeTimer = undefined
    dueAt = Number.POSITIVE_INFINITY
    changeDueAt = Number.POSITIVE_INFINITY
    firstChangeAt = undefined
  }

  return {
    trigger(trigger) {
      const always = trigger === 'start' || trigger === 'manual'
      if (!always && now() - lastRunAt < throttle) return
      plan(trigger)
    },

    changed(kind) {
      if (stopped || halted) return
      const at = now()
      if (firstChangeAt === undefined) {
        firstChangeAt = at
        changeKind = kind
      } else if (kind === 'edit') {
        changeKind = 'edit'
      }
      const delay = changeKind === 'edit' ? editDelay : backgroundDelay
      const maxWait = changeKind === 'edit' ? editMaxWait : backgroundMaxWait
      const due = Math.min(at + delay, firstChangeAt + maxWait)
      if (changeTimer !== undefined && due === changeDueAt) return
      if (changeTimer !== undefined) clearTimer(changeTimer)
      changeDueAt = due
      changeTimer = setTimer(
        () => {
          changeTimer = undefined
          changeDueAt = Number.POSITIVE_INFINITY
          firstChangeAt = undefined
          plan('change')
        },
        Math.max(0, due - at),
      )
    },

    online() {
      failures = 0
      blockedUntil = 0
      plan('online')
    },

    stop() {
      stopped = true
      cancel()
    },
  }
}
