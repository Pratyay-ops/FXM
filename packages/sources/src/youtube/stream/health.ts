/**
 * Per-rung health and the last working rung, kept per platform (and, on the web, per tier: Lite
 * and FXM Connect reach YouTube differently).
 *
 * A rung that failed for a reason of its own (a bot check, capped URLs, no usable formats, a
 * response about another video, an answer FXM can't read, or a URL that failed to play) cools
 * down: for 5 minutes after one failure, doubling with each failure in a row up to an hour. The
 * ladder tries cooling rungs only after the others, so while VISIONOS is flagged, songs start on
 * the rung that worked last instead of spending a call on VISIONOS each time, and VISIONOS is
 * tried again when its cool-down ends. A video's own state (age-restricted, made for kids, live,
 * removed) says nothing about a rung and doesn't count.
 *
 * The state can be persisted through a {@link RungHealthStore}, so the memory survives a
 * restart.
 *
 * @module
 */

/** Why a rung failed. */
export type RungFailure =
  /** YouTube asked for proof of a real user (`LOGIN_REQUIRED`, a bot check page). */
  | 'bot-check'
  /** The end-of-file probe found every URL capped. */
  | 'capped'
  /** The response had none of the rung's formats with a direct URL. */
  | 'no-formats'
  /** The response was about another video. */
  | 'mismatch'
  /** YouTube's answer could not be read, or refused the request's shape. */
  | 'error'
  /** A URL of the rung failed to play, which in the Lite tier is the probe. */
  | 'playback'

const FAILURES: readonly RungFailure[] = [
  'bot-check',
  'capped',
  'no-formats',
  'mismatch',
  'error',
  'playback',
]

/** One rung's health on one platform. */
export interface RungHealth {
  /** The rung's ID. */
  readonly rung: string
  /** How often it yielded a playable URL. */
  readonly successes: number
  /** How often it failed for a reason of its own. */
  readonly failures: number
  /** Failures since its last success. */
  readonly consecutiveFailures: number
  /** When it last worked, in epoch milliseconds. */
  readonly lastSuccessAt?: number
  /** When it last failed, in epoch milliseconds. */
  readonly lastFailureAt?: number
  /** Why it last failed. */
  readonly lastFailure?: RungFailure
  /** While it cools down after failing: when the cool-down ends, in epoch milliseconds. */
  readonly coolingUntil?: number
}

/** The ladder's health on one platform. */
export interface LadderHealth {
  /** The platform and tier, e.g. `web/full`, `web/simple`, `desktop/full`. */
  readonly scope: string
  /** The rung that last yielded a playable URL here. */
  readonly lastWorking?: string
  /** When it did, in epoch milliseconds. */
  readonly lastWorkingAt?: number
  /** Every rung the config lists, in ladder order. */
  readonly rungs: readonly RungHealth[]
}

/** Where the health state can be kept between sessions, e.g. `localStorage` or app storage. */
export interface RungHealthStore {
  /** The state saved earlier, if any. It is checked before use. */
  load(): unknown | Promise<unknown>
  /** Keeps the state, a small JSON value. */
  save(state: unknown): void | Promise<void>
}

/** Options for {@link RungHealthBook}. */
export interface RungHealthOptions {
  /** Where to persist the state; in memory only by default. */
  store?: RungHealthStore
  /** The clock, for tests. */
  now?: () => number
  /** How long one failure cools a rung down; 5 minutes by default. */
  cooldownMs?: number
  /** The longest cool-down; 1 hour by default. */
  maxCooldownMs?: number
}

/** One rung's counters, as stored. */
interface Entry {
  s: number
  f: number
  c: number
  ls?: number
  lf?: number
  k?: RungFailure
}

/** One scope's state, as stored. */
interface Scope {
  w?: string
  wa?: number
  r: Record<string, Entry>
}

/** The stored form. */
interface Stored {
  v: 1
  scopes: Record<string, Scope>
}

const MAX_SCOPES = 16
const MAX_RUNGS = 32
const SCOPE_NAME = /^[a-z]{1,16}\/[a-z]{1,16}$/u
const RUNG_NAME = /^[a-z][a-z0-9-]{1,31}$/u

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function readEntry(value: unknown): Entry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { s, f, c, ls, lf, k } = value as Partial<Record<keyof Entry, unknown>>
  if (!isCount(s) || !isCount(f) || !isCount(c)) return undefined
  if (ls !== undefined && !isTime(ls)) return undefined
  if (lf !== undefined && !isTime(lf)) return undefined
  if (k !== undefined && !(FAILURES as readonly unknown[]).includes(k)) return undefined
  return {
    s,
    f,
    c,
    ...(ls === undefined ? {} : { ls }),
    ...(lf === undefined ? {} : { lf }),
    ...(k === undefined ? {} : { k: k as RungFailure }),
  }
}

/** The stored state, or an empty one when it is missing or malformed (fail closed). */
function readStored(value: unknown): Stored {
  const empty: Stored = { v: 1, scopes: {} }
  if (typeof value !== 'object' || value === null) return empty
  const { v, scopes } = value as { v?: unknown; scopes?: unknown }
  if (v !== 1 || typeof scopes !== 'object' || scopes === null) return empty
  const entries = Object.entries(scopes)
  if (entries.length > MAX_SCOPES) return empty
  const result: Stored = { v: 1, scopes: {} }
  for (const [name, scope] of entries) {
    if (!SCOPE_NAME.test(name) || typeof scope !== 'object' || scope === null) return empty
    const { w, wa, r } = scope as { w?: unknown; wa?: unknown; r?: unknown }
    if (w !== undefined && (typeof w !== 'string' || !RUNG_NAME.test(w))) return empty
    if (wa !== undefined && !isTime(wa)) return empty
    if (typeof r !== 'object' || r === null || Object.keys(r).length > MAX_RUNGS) return empty
    const rungs: Record<string, Entry> = {}
    for (const [rung, entry] of Object.entries(r)) {
      const parsed = RUNG_NAME.test(rung) ? readEntry(entry) : undefined
      if (parsed === undefined) return empty
      rungs[rung] = parsed
    }
    result.scopes[name] = {
      ...(w === undefined ? {} : { w }),
      ...(wa === undefined ? {} : { wa }),
      r: rungs,
    }
  }
  return result
}

/** The health of every rung on every platform this device has used. */
export class RungHealthBook {
  #state: Stored = { v: 1, scopes: {} }
  #loaded: Promise<void> | undefined
  readonly #store: RungHealthStore | undefined
  readonly #now: () => number
  readonly #cooldownMs: number
  readonly #maxCooldownMs: number

  constructor(options: RungHealthOptions = {}) {
    this.#store = options.store
    this.#now = options.now ?? Date.now
    this.#cooldownMs = options.cooldownMs ?? 5 * 60_000
    this.#maxCooldownMs = Math.max(this.#cooldownMs, options.maxCooldownMs ?? 60 * 60_000)
  }

  /** Loads the stored state once; a store that fails leaves the state in memory only. */
  ready(): Promise<void> {
    this.#loaded ??= (async () => {
      try {
        const stored = readStored(await this.#store?.load())
        // A rung recorded before the load finished keeps what was recorded.
        for (const [name, scope] of Object.entries(this.#state.scopes)) {
          const before = stored.scopes[name]
          stored.scopes[name] =
            before === undefined ? scope : { ...before, ...scope, r: { ...before.r, ...scope.r } }
        }
        this.#state = stored
      } catch {
        // Keep the in-memory state.
      }
    })()
    return this.#loaded
  }

  /** When `rung`'s cool-down on `scope` ends, if it is cooling down now. */
  coolingUntil(scope: string, rung: string): number | undefined {
    const entry = this.#state.scopes[scope]?.r[rung]
    if (entry === undefined || entry.c === 0 || entry.lf === undefined) return undefined
    const length = Math.min(this.#cooldownMs * 2 ** (entry.c - 1), this.#maxCooldownMs)
    const until = entry.lf + length
    return until > this.#now() ? until : undefined
  }

  /** Records that `rung` yielded a playable URL on `scope`. */
  succeed(scope: string, rung: string): void {
    const now = this.#now()
    const state = this.#scope(scope)
    const entry = this.#entry(state, rung)
    state.r[rung] = { ...entry, s: entry.s + 1, c: 0, ls: now }
    state.w = rung
    state.wa = now
    this.#save()
  }

  /** Records that `rung` failed on `scope` for a reason of its own. */
  fail(scope: string, rung: string, why: RungFailure): void {
    const state = this.#scope(scope)
    const entry = this.#entry(state, rung)
    state.r[rung] = { ...entry, f: entry.f + 1, c: entry.c + 1, lf: this.#now(), k: why }
    this.#save()
  }

  /** The health of `rungs` on `scope`, in that order. */
  snapshot(scope: string, rungs: readonly string[]): LadderHealth {
    const state = this.#state.scopes[scope]
    return {
      scope,
      ...(state?.w === undefined ? {} : { lastWorking: state.w }),
      ...(state?.wa === undefined ? {} : { lastWorkingAt: state.wa }),
      rungs: rungs.map((rung) => {
        const entry = state?.r[rung] ?? { s: 0, f: 0, c: 0 }
        const coolingUntil = this.coolingUntil(scope, rung)
        return {
          rung,
          successes: entry.s,
          failures: entry.f,
          consecutiveFailures: entry.c,
          ...(entry.ls === undefined ? {} : { lastSuccessAt: entry.ls }),
          ...(entry.lf === undefined ? {} : { lastFailureAt: entry.lf }),
          ...(entry.k === undefined ? {} : { lastFailure: entry.k }),
          ...(coolingUntil === undefined ? {} : { coolingUntil }),
        }
      }),
    }
  }

  #scope(name: string): Scope {
    let scope = this.#state.scopes[name]
    if (scope === undefined) {
      scope = { r: {} }
      this.#state.scopes[name] = scope
    }
    return scope
  }

  #entry(scope: Scope, rung: string): Entry {
    return scope.r[rung] ?? { s: 0, f: 0, c: 0 }
  }

  #save(): void {
    const store = this.#store
    if (store === undefined) return
    const copy = structuredClone(this.#state)
    void (async () => {
      try {
        await store.save(copy)
      } catch {
        // The state stays in memory.
      }
    })()
  }
}
