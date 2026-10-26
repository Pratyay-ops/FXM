/**
 * The shared YouTube request budget: one per device for every InnerTube call, whatever it is
 * for, so that background work such as a playlist import can never get the user's own IP
 * address flagged and break playback.
 *
 * YouTube rate-limits guest sessions at roughly 1,000 webpage and player requests an hour (a
 * yt-dlp figure from 2025), and answers with `LOGIN_REQUIRED` once an IP address is flagged. The
 * budget therefore allows at most 600 calls in any rolling hour, serves them by priority, spaces
 * bulk work out, and pauses bulk work at the first bot check while playback continues.
 *
 * @module
 */

import { FxmError, isFxmError } from '@fxm/core'
import { type Clock, systemClock } from './clock'
import { type KeyValueStorage, memoryStorage, readJson, writeJson } from './storage'

/** Every {@link RequestPriority}, highest first. */
export const REQUEST_PRIORITIES = ['current-track', 'prefetch', 'interactive', 'bulk'] as const

/**
 * What an InnerTube call is for, highest priority first:
 *
 * - `current-track`: resolving the track that is playing or about to play
 * - `prefetch`: resolving the next tracks in the queue
 * - `interactive`: search, suggestions and pages the user opened
 * - `bulk`: background work nobody waits for: imports, re-matching, the matching recorder
 *
 * Each priority may use the hour's budget only while it leaves its reserve for the ones above
 * it (see {@link RequestBudgetOptions.reserves}). Bulk calls also wait their turn, at least
 * {@link BUDGET_DEFAULTS.bulkSpacingMs} apart, and stop during a bot-check pause.
 */
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number]

/** Every {@link BudgetLimit}. */
export const BUDGET_LIMITS = ['paused', 'spacing', 'reserve'] as const

/**
 * Why the budget refused a call:
 *
 * - `paused`: bulk work is paused after a bot check
 * - `reserve`: the hour's budget for this priority is used up; the rest is kept for the ones
 *   above it
 * - `spacing`: other bulk calls go first, and this one's turn would come later than its caller
 *   allows (see {@link AcquireOptions.maxWaitMs})
 */
export type BudgetLimit = (typeof BUDGET_LIMITS)[number]

/**
 * A call the budget refused: a `RateLimited` `FxmError` with the limit it hit and, in
 * `retryAfterMs`, how long until a slot is expected. Job runners that see one wait with
 * {@link RequestBudget.whenAvailable} and try again; their progress is not lost.
 */
export class BudgetError extends FxmError {
  /** Which limit the call hit. */
  readonly reason: BudgetLimit

  /**
   * @param reason Which limit the call hit.
   * @param message Human-readable details, for logs.
   * @param retryAfterMs How long until a slot is expected, in milliseconds.
   */
  constructor(reason: BudgetLimit, message: string, retryAfterMs: number) {
    super('RateLimited', message, { retryAfterMs })
    this.reason = reason
  }
}

/**
 * Whether `value` is a {@link BudgetError}, optionally for a given limit. Like `isFxmError`, it
 * also recognizes errors from a second copy of this module.
 */
export function isBudgetError(value: unknown, reason?: BudgetLimit): value is BudgetError {
  if (!isFxmError(value, 'RateLimited')) return false
  const found = (value as { reason?: unknown }).reason
  return (
    typeof found === 'string' &&
    (BUDGET_LIMITS as readonly string[]).includes(found) &&
    (reason === undefined || found === reason)
  )
}

/** Every {@link BotCheckCause}. */
export const BOT_CHECK_CAUSES = ['login-required', 'rate-limited'] as const

/**
 * Why YouTube seems to have flagged the user's IP address: a `LOGIN_REQUIRED` playability status
 * ("Sign in to confirm you're not a bot"), or HTTP 429.
 */
export type BotCheckCause = (typeof BOT_CHECK_CAUSES)[number]

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** The defaults of {@link RequestBudgetOptions}. */
export const BUDGET_DEFAULTS = {
  /** At most 600 InnerTube calls in any rolling hour: half of yt-dlp's guest figure. */
  hourlyLimit: 600,
  /**
   * Calls of the hour each priority leaves for the ones above it. Bulk work stops while 100 or
   * fewer remain, interactive calls while 30 or fewer do and prefetching while 10 or fewer do;
   * the current track may use the last one.
   */
  reserves: { 'current-track': 0, prefetch: 10, interactive: 30, bulk: 100 },
  /** Bulk calls start at least 5 s apart. */
  bulkSpacingMs: 5_000,
  /** The first bot check pauses bulk work for 30 min; each further one doubles the pause. */
  pauseMs: 30 * MINUTE_MS,
  /** Pauses never last longer than 4 h. */
  maxPauseMs: 4 * HOUR_MS,
  /** Where the state lives in the storage. */
  storageKey: 'fxm.requestBudget',
} as const satisfies Required<Omit<RequestBudgetOptions, 'storage' | 'clock' | 'reserves'>> & {
  reserves: Record<RequestPriority, number>
}

/** Options for {@link createRequestBudget}. */
export interface RequestBudgetOptions {
  /** Most calls in any rolling hour, across every priority. */
  hourlyLimit?: number
  /** Calls of the hour each priority must leave for higher ones, per priority. */
  reserves?: Partial<Record<RequestPriority, number>>
  /** Shortest time between the starts of two bulk calls, in milliseconds. */
  bulkSpacingMs?: number
  /** How long the first bot check pauses bulk work, in milliseconds. */
  pauseMs?: number
  /** Longest bulk pause, in milliseconds. */
  maxPauseMs?: number
  /**
   * Where the hour's calls and the pause are kept, so that they survive a reload and every
   * budget on the device shares them (`localStorage` in a browser). In memory by default.
   */
  storage?: KeyValueStorage
  /** The key the state is stored under. */
  storageKey?: string
  /** The clock, for tests. */
  clock?: Clock
}

/** Options for {@link RequestBudget.acquire}. */
export interface AcquireOptions {
  /** Stops waiting for a bulk slot; `acquire` then rejects with the signal's reason. */
  signal?: AbortSignal
  /**
   * Bulk calls only: the longest the call may wait for its turn, in milliseconds. When its turn
   * cannot come in time (always the case during a bot-check pause) the call rejects at once
   * with a {@link BudgetError}, and so does a call whose turn moves out of reach while it waits.
   * Default: no limit. The transports pass a short one, so that a bulk call never waits for long
   * inside a provider's `fetch`, where a request timeout would cut it off.
   */
  maxWaitMs?: number
}

/** Options for {@link RequestBudget.whenAvailable}. */
export interface WaitOptions {
  /** Stops waiting; `whenAvailable` then rejects with the signal's reason. */
  signal?: AbortSignal
}

/** The limits a budget was created with (see {@link RequestBudgetOptions}). */
export interface BudgetSettings {
  /** Most calls in any rolling hour. */
  readonly hourlyLimit: number
  /** Calls of the hour each priority leaves for the ones above it. */
  readonly reserves: Readonly<Record<RequestPriority, number>>
  /** Shortest time between the starts of two bulk calls, in milliseconds. */
  readonly bulkSpacingMs: number
  /** How long the first bot check pauses bulk work, in milliseconds. */
  readonly pauseMs: number
  /** Longest bulk pause, in milliseconds. */
  readonly maxPauseMs: number
}

/** The budget's state, for diagnostics and progress displays. */
export interface BudgetSnapshot {
  /** Most calls in any rolling hour. */
  readonly hourlyLimit: number
  /** Calls made in the last hour. */
  readonly used: number
  /** Calls left in the rolling hour, across every priority. */
  readonly remaining: number
  /** While bulk work is paused after a bot check: when the pause ends, in epoch milliseconds. */
  readonly bulkPausedUntil?: number
  /**
   * How many bot checks in a row the current or last pause followed: `0` when calm, `1` for
   * the first 30-minute pause, `2` for 60 minutes, and so on up to the 4-hour pause.
   */
  readonly pauseLevel: number
  /** The last bot check reported, if any. */
  readonly lastBotCheck?: { readonly at: number; readonly cause: BotCheckCause }
  /** Bulk calls waiting for a slot in this budget. */
  readonly waitingBulk: number
}

/**
 * The shared request budget. Every transport draws one slot from it for each request to a
 * YouTube API host (see the transports' `withPriority`).
 *
 * **Job runners** (imports, re-matching, the matching recorder) await
 * {@link RequestBudget.whenAvailable} with `bulk` before each provider call, outside any request
 * timeout, and then make the call with the transport's `bulk` fetch. The transport lets a bulk
 * call wait only briefly for its turn, so a call made while bulk work is paused rejects at once
 * with a {@link BudgetError} (`paused`) instead of timing out; the runner keeps its progress,
 * waits again and resumes.
 */
export interface RequestBudget {
  /** The limits this budget was created with. */
  readonly settings: BudgetSettings
  /**
   * Takes a slot for one InnerTube call. `current-track`, `prefetch` and `interactive` calls get
   * one at once while the hour's budget above their reserve lasts, and otherwise reject with a
   * {@link BudgetError} (`reserve`) whose `retryAfterMs` says when one frees up. `bulk` calls
   * wait, in order, until a slot is free, the spacing has passed and no bot-check pause is on,
   * or reject with a {@link BudgetError} when that would take longer than `maxWaitMs`. An
   * unknown priority rejects with a `RangeError`.
   */
  acquire(priority: RequestPriority, options?: AcquireOptions): Promise<void>
  /**
   * Resolves once a call at `priority` would get a slot at once, without taking one: for bulk
   * work, once no bot-check pause is on, the hour's bulk budget has room, the spacing has passed
   * and no other bulk call of this budget waits. Rejects with the signal's reason when it aborts.
   */
  whenAvailable(priority: RequestPriority, options?: WaitOptions): Promise<void>
  /**
   * When a call at `priority` could start, in epoch milliseconds: now, or the moment the budget
   * expects a slot, e.g. for a progress display ("Import resumes at 14:30").
   */
  nextSlotAt(priority: RequestPriority): number
  /**
   * Reports a bot check: a `LOGIN_REQUIRED` playability status or HTTP 429. Bulk work pauses for
   * 30 minutes, or twice as long as the last pause when that one ended less than its own length
   * ago, up to 4 hours; a report during a pause extends it to at least that long from now.
   * Playback and interactive calls go on. The transports report what they see themselves, and
   * `FxmPlatform.report` forwards the bot checks providers notice.
   */
  reportBotCheck(cause: BotCheckCause): void
  /** The current state. */
  snapshot(): BudgetSnapshot
  /**
   * Calls `listener` after every change this budget makes: a call taken or a bot check
   * reported. Returns a function that removes the listener.
   */
  subscribe(listener: (snapshot: BudgetSnapshot) => void): () => void
}

/** What the budget keeps, in storage and in memory. Times are epoch milliseconds, 0 for never. */
interface BudgetState {
  /** When each call of the last hour was taken, oldest first. */
  calls: number[]
  lastBulkAt: number
  pausedUntil: number
  pauseLevel: number
  lastBotCheckAt: number
  lastBotCheckCause: BotCheckCause | undefined
}

/** The stored form of {@link BudgetState}. */
interface StoredState {
  v: 1
  calls: number[]
  lastBulkAt: number
  pausedUntil: number
  pauseLevel: number
  lastBotCheckAt: number
  lastBotCheckCause?: BotCheckCause
}

/** Most call times read back from storage; more than a day's worth means the data is bad. */
const MAX_STORED_CALLS = 100_000

interface Waiter {
  resolve(): void
  reject(reason: unknown): void
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  /** The latest time its turn may come, in epoch milliseconds; `Infinity` for no limit. */
  deadline: number
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPriority(value: unknown): value is RequestPriority {
  return (REQUEST_PRIORITIES as readonly unknown[]).includes(value)
}

function isCause(value: unknown): value is BotCheckCause {
  return (BOT_CHECK_CAUSES as readonly unknown[]).includes(value)
}

function emptyState(): BudgetState {
  return {
    calls: [],
    lastBulkAt: 0,
    pausedUntil: 0,
    pauseLevel: 0,
    lastBotCheckAt: 0,
    lastBotCheckCause: undefined,
  }
}

/** Reads stored state, or `undefined` when it is missing or malformed. */
function parseState(value: unknown, maxLevel: number): BudgetState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const stored = value as Partial<Record<keyof StoredState, unknown>>
  const { calls, lastBulkAt, pausedUntil, pauseLevel, lastBotCheckAt, lastBotCheckCause } = stored
  if (
    stored.v !== 1 ||
    !Array.isArray(calls) ||
    calls.length > MAX_STORED_CALLS ||
    !calls.every(isTime) ||
    !isTime(lastBulkAt) ||
    !isTime(pausedUntil) ||
    !isTime(lastBotCheckAt) ||
    !Number.isInteger(pauseLevel) ||
    (pauseLevel as number) < 0 ||
    (pauseLevel as number) > maxLevel ||
    (lastBotCheckCause !== undefined && !isCause(lastBotCheckCause))
  ) {
    return undefined
  }
  return {
    calls: [...(calls as number[])].sort((a, b) => a - b),
    lastBulkAt,
    pausedUntil,
    pauseLevel: pauseLevel as number,
    lastBotCheckAt,
    lastBotCheckCause,
  }
}

function checkNumber(name: string, value: number, min: number, integer = false): number {
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    const kind = integer ? 'a whole number' : 'a finite number'
    throw new RangeError(`${name} must be ${kind} of at least ${min}, not ${value}`)
  }
  return value
}

function checkPriority(priority: unknown): asserts priority is RequestPriority {
  if (!isPriority(priority)) {
    throw new RangeError(`Unknown request priority: ${String(priority)}`)
  }
}

/**
 * Creates a request budget. Create one per device and hand it to every transport (as
 * `createPlatform` does): budgets that share a storage also share the hour's calls and the
 * pause, so pass `localStorage` in a browser to cover every tab and reload.
 */
export function createRequestBudget(options: RequestBudgetOptions = {}): RequestBudget {
  const clock = options.clock ?? systemClock
  const storage = options.storage ?? memoryStorage()
  const key = options.storageKey ?? BUDGET_DEFAULTS.storageKey
  const hourlyLimit = checkNumber(
    'hourlyLimit',
    options.hourlyLimit ?? BUDGET_DEFAULTS.hourlyLimit,
    1,
    true,
  )
  const reserves = { ...BUDGET_DEFAULTS.reserves, ...options.reserves }
  for (const priority of REQUEST_PRIORITIES) {
    checkNumber(`reserves.${priority}`, reserves[priority], 0, true)
    if (reserves[priority] >= hourlyLimit) {
      throw new RangeError(`reserves.${priority} must be below hourlyLimit (${hourlyLimit})`)
    }
  }
  const bulkSpacingMs = checkNumber(
    'bulkSpacingMs',
    options.bulkSpacingMs ?? BUDGET_DEFAULTS.bulkSpacingMs,
    0,
  )
  const pauseMs = checkNumber('pauseMs', options.pauseMs ?? BUDGET_DEFAULTS.pauseMs, 1)
  const maxPauseMs = checkNumber(
    'maxPauseMs',
    options.maxPauseMs ?? BUDGET_DEFAULTS.maxPauseMs,
    pauseMs,
  )

  /** How long a pause at `level` lasts. */
  const pauseStepMs = (level: number) =>
    level <= 0 ? 0 : Math.min(pauseMs * 2 ** (level - 1), maxPauseMs)
  let maxLevel = 1
  while (pauseStepMs(maxLevel) < maxPauseMs) maxLevel += 1

  const settings: BudgetSettings = Object.freeze({
    hourlyLimit,
    reserves: Object.freeze({ ...reserves }),
    bulkSpacingMs,
    pauseMs,
    maxPauseMs,
  })
  const queue: Waiter[] = []
  const listeners = new Set<(snapshot: BudgetSnapshot) => void>()
  let timer: unknown
  // The last state this budget saw or wrote; used whenever the storage fails us.
  let memory = emptyState()
  let storageWorks = true

  /**
   * The current state, limited to the last hour. Times in the future, which only a clock set
   * back explains, are moved to now (and written back), so they expire like any other.
   */
  function load(now: number): BudgetState {
    const stored = storageWorks ? parseState(readJson(storage, key), maxLevel) : undefined
    const state = stored ?? structuredClone(memory)
    const future =
      state.calls.some((time) => time > now) ||
      state.lastBulkAt > now ||
      state.pausedUntil > now + maxPauseMs
    state.calls = state.calls.filter((time) => time > now - HOUR_MS).map((t) => Math.min(t, now))
    state.lastBulkAt = Math.min(state.lastBulkAt, now)
    state.pausedUntil = Math.min(state.pausedUntil, now + maxPauseMs)
    if (future) save(state)
    return state
  }

  function save(state: BudgetState): void {
    memory = state
    if (!storageWorks) return
    const stored: StoredState = {
      v: 1,
      calls: state.calls,
      lastBulkAt: state.lastBulkAt,
      pausedUntil: state.pausedUntil,
      pauseLevel: state.pauseLevel,
      lastBotCheckAt: state.lastBotCheckAt,
      ...(state.lastBotCheckCause === undefined
        ? {}
        : { lastBotCheckCause: state.lastBotCheckCause }),
    }
    storageWorks = writeJson(storage, key, stored)
  }

  /** The pause level, back at 0 once bulk work ran as long as the last pause without a report. */
  function effectiveLevel(state: BudgetState, now: number): number {
    if (state.pausedUntil > now || state.pauseLevel === 0) return state.pauseLevel
    return now - state.pausedUntil >= pauseStepMs(state.pauseLevel) ? 0 : state.pauseLevel
  }

  /** How long until a call at a priority with this reserve fits in the hour, 0 for now. */
  function reserveWaitMs(state: BudgetState, now: number, reserve: number): number {
    const excess = state.calls.length - (hourlyLimit - reserve)
    if (excess < 0) return 0
    // Once the call at `excess` (oldest first) leaves the hour, enough calls have.
    const expiry = (state.calls[excess] ?? now) + HOUR_MS
    return Math.max(1, expiry - now)
  }

  function bulkWaitMs(state: BudgetState, now: number): number {
    const spacing = state.lastBulkAt > 0 ? state.lastBulkAt + bulkSpacingMs - now : 0
    return Math.max(state.pausedUntil - now, spacing, reserveWaitMs(state, now, reserves.bulk), 0)
  }

  /** How long until a new call at `priority` could start: after every queued bulk call. */
  function waitFor(priority: RequestPriority, state: BudgetState, now: number): number {
    if (priority !== 'bulk') return reserveWaitMs(state, now, reserves[priority])
    const head = bulkWaitMs(state, now)
    return queue.length === 0 ? head : head + queue.length * bulkSpacingMs
  }

  /** The error for a bulk call whose turn is `waitMs` away, naming the limit that holds it. */
  function limitError(state: BudgetState, now: number, waitMs: number): BudgetError {
    const retryAfterMs = Math.max(1, Math.ceil(waitMs))
    if (state.pausedUntil > now) {
      const until = new Date(state.pausedUntil).toISOString()
      return new BudgetError(
        'paused',
        `Bulk YouTube requests are paused after a bot check until ${until}`,
        retryAfterMs,
      )
    }
    if (reserveWaitMs(state, now, reserves.bulk) > 0) {
      return new BudgetError(
        'reserve',
        `The last ${reserves.bulk} YouTube calls of the hour are kept for playback and search: ${state.calls.length} of ${hourlyLimit} used`,
        retryAfterMs,
      )
    }
    return new BudgetError(
      'spacing',
      `Bulk YouTube requests start at least ${bulkSpacingMs} ms apart, and others are waiting`,
      retryAfterMs,
    )
  }

  function toSnapshot(state: BudgetState, now: number): BudgetSnapshot {
    const used = state.calls.length
    return {
      hourlyLimit,
      used,
      remaining: Math.max(0, hourlyLimit - used),
      ...(state.pausedUntil > now ? { bulkPausedUntil: state.pausedUntil } : {}),
      pauseLevel: effectiveLevel(state, now),
      ...(state.lastBotCheckCause === undefined
        ? {}
        : { lastBotCheck: { at: state.lastBotCheckAt, cause: state.lastBotCheckCause } }),
      waitingBulk: queue.length,
    }
  }

  function notify(state: BudgetState, now: number): void {
    if (listeners.size === 0) return
    const snapshot = toSnapshot(state, now)
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A failing listener must not break the budget.
      }
    }
  }

  function take(state: BudgetState, now: number, bulk: boolean): void {
    state.calls.push(now)
    if (bulk) state.lastBulkAt = now
    save(state)
    notify(state, now)
  }

  /** Takes a waiter out of the queue and stops listening to its signal. */
  function remove(waiter: Waiter): void {
    const index = queue.indexOf(waiter)
    if (index >= 0) queue.splice(index, 1)
    if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener('abort', waiter.onAbort)
  }

  /**
   * Grants bulk slots while the head of the queue may go. Otherwise it turns away the waiters
   * whose turn cannot come by their deadline, the head's turn coming first and each later one a
   * spacing after the one before, and sleeps until the head may go. A deadline that is still
   * met then lies at or after that wake-up, where the queue is checked again.
   */
  function pump(): void {
    if (timer !== undefined) {
      clock.clearTimeout(timer)
      timer = undefined
    }
    while (queue.length > 0) {
      const now = clock.now()
      const state = load(now)
      const waitMs = bulkWaitMs(state, now)
      if (waitMs <= 0) {
        const waiter = queue[0] as Waiter
        remove(waiter)
        take(state, now, true)
        waiter.resolve()
        continue
      }
      let position = 0
      for (const waiter of [...queue]) {
        const turnMs = waitMs + position * bulkSpacingMs
        if (now + turnMs > waiter.deadline) {
          remove(waiter)
          waiter.reject(limitError(state, now, turnMs))
        } else {
          position += 1
        }
      }
      if (queue.length > 0) {
        timer = clock.setTimeout(() => {
          timer = undefined
          pump()
        }, waitMs)
      }
      return
    }
  }

  function waitForBulk(signal: AbortSignal | undefined, maxWaitMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const deadline = clock.now() + maxWaitMs
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined, deadline }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          remove(waiter)
          reject(signal.reason)
          pump()
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      queue.push(waiter)
      pump()
    })
  }

  /** Waits `delayMs` on the budget's clock, or until `signal` aborts. */
  function sleep(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clock.clearTimeout(handle)
        reject(signal?.reason)
      }
      const handle = clock.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, delayMs)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function nextSlotAt(priority: RequestPriority): number {
    checkPriority(priority)
    const now = clock.now()
    return now + waitFor(priority, load(now), now)
  }

  return {
    settings,

    async acquire(priority, acquireOptions = {}) {
      const { signal, maxWaitMs = Number.POSITIVE_INFINITY } = acquireOptions
      signal?.throwIfAborted()
      checkPriority(priority)
      if (typeof maxWaitMs !== 'number' || Number.isNaN(maxWaitMs) || maxWaitMs < 0) {
        throw new RangeError(`maxWaitMs must be a number of at least 0, not ${String(maxWaitMs)}`)
      }
      if (priority === 'bulk') return waitForBulk(signal, maxWaitMs)
      const now = clock.now()
      const state = load(now)
      const retryAfterMs = reserveWaitMs(state, now, reserves[priority])
      if (retryAfterMs > 0) {
        throw new BudgetError(
          'reserve',
          `The YouTube request budget is used up for now: ${state.calls.length} of ${hourlyLimit} calls in the last hour`,
          retryAfterMs,
        )
      }
      take(state, now, false)
    },

    async whenAvailable(priority, waitOptions = {}) {
      const { signal } = waitOptions
      checkPriority(priority)
      signal?.throwIfAborted()
      let waitMs = nextSlotAt(priority) - clock.now()
      while (waitMs > 0) {
        await sleep(waitMs, signal)
        waitMs = nextSlotAt(priority) - clock.now()
      }
    },

    nextSlotAt,

    reportBotCheck(cause) {
      if (!isCause(cause)) return
      const now = clock.now()
      const state = load(now)
      if (state.pausedUntil > now) {
        state.pausedUntil = Math.max(state.pausedUntil, now + pauseStepMs(state.pauseLevel))
      } else {
        state.pauseLevel = Math.min(effectiveLevel(state, now) + 1, maxLevel)
        state.pausedUntil = now + pauseStepMs(state.pauseLevel)
      }
      state.lastBotCheckAt = now
      state.lastBotCheckCause = cause
      save(state)
      notify(state, now)
      pump()
    },

    snapshot() {
      const now = clock.now()
      return toSnapshot(load(now), now)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
