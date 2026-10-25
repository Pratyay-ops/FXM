/**
 * Per-rung health and the last working rung, kept per platform (and, on the web, per tier: Lite
 * and FXM Connect reach YouTube differently).
 *
 * A rung that failed for a reason of its own (a bot check, capped URLs, no usable formats, a
 * response about another video, an answer FXM can't read, or a URL that failed its first
 * request in the player) cools down: for 5 minutes after one failure, doubling with each failure
 * in a row up to an hour. The ladder tries cooling rungs only after the others, so while VISIONOS
 * is flagged, songs start on the rung that worked last instead of spending a call on VISIONOS
 * each time, and VISIONOS is tried again when its cool-down ends. A video's own state
 * (age-restricted, made for kids, live, removed) says nothing about a rung and doesn't count.
 *
 * A rung counts as working only when one of its URLs is known to play: a URL that passed the
 * end-of-file probe, or, where nothing can be probed (Lite), one the player reports playing.
 * Resolving URLs nobody checked resets nothing, so a rung whose URLs keep failing in the player
 * backs off towards an hour.
 *
 * The state can be persisted through a {@link RungHealthStore}, so the memory survives a
 * restart. What is read back is checked entry by entry: a malformed entry is dropped, and so is
 * a time ahead of the clock, which would otherwise cool a rung down for that long.
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
  /** A URL of the rung failed in the player in a way that says the rung is at fault. */
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
  /** How often one of its URLs was known to play: it passed the probe, or the player said so. */
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
  /** The rung that last worked here (see {@link RungHealth.successes}). */
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
  /**
   * The IDs of the rungs the config lists now. The book forgets every other rung when it loads
   * and saves, so rungs a config dropped or renamed don't pile up. Every rung is kept without it.
   */
  rungs?: () => readonly string[]
  /** The clock, for tests. */
  now?: () => number
  /** How long one failure cools a rung down; 5 minutes by default. */
  cooldownMs?: number
  /** The longest cool-down; 1 hour by default. */
  maxCooldownMs?: number
}

/** One rung's counters, in their stored form. */
interface Entry {
  s: number
  f: number
  c: number
  ls?: number
  lf?: number
  k?: RungFailure
}

/** One scope's state. */
interface ScopeState {
  w?: string
  wa?: number
  readonly r: Map<string, Entry>
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

/** A stored entry, or `undefined` when it is malformed. Times ahead of `now` are dropped. */
function readEntry(value: unknown, now: number): Entry | undefined {
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
    ...(ls === undefined || ls > now ? {} : { ls }),
    ...(lf === undefined || lf > now ? {} : { lf }),
    ...(k === undefined ? {} : { k: k as RungFailure }),
  }
}

/**
 * The stored state, entry by entry: a malformed scope or rung entry is dropped, as is a time
 * ahead of `now`, and a state it can't read at all is an empty one.
 */
function readStored(value: unknown, now: number): Map<string, ScopeState> {
  const scopes = new Map<string, ScopeState>()
  if (typeof value !== 'object' || value === null) return scopes
  const { v, scopes: stored } = value as { v?: unknown; scopes?: unknown }
  if (v !== 1 || typeof stored !== 'object' || stored === null) return scopes
  for (const [name, scope] of Object.entries(stored)) {
    if (scopes.size >= MAX_SCOPES) break
    if (!SCOPE_NAME.test(name) || typeof scope !== 'object' || scope === null) continue
    const { w, wa, r } = scope as { w?: unknown; wa?: unknown; r?: unknown }
    if (typeof r !== 'object' || r === null) continue
    const rungs = new Map<string, Entry>()
    for (const [rung, entry] of Object.entries(r)) {
      if (rungs.size >= MAX_RUNGS) break
      const parsed = RUNG_NAME.test(rung) ? readEntry(entry, now) : undefined
      if (parsed !== undefined) rungs.set(rung, parsed)
    }
    const state: ScopeState = { r: rungs }
    if (typeof w === 'string' && RUNG_NAME.test(w)) {
      state.w = w
      if (isTime(wa) && wa <= now) state.wa = wa
    }
    scopes.set(name, state)
  }
  return scopes
}

/** A stored entry, followed by what was recorded (from nothing) after it. */
function merged(stored: Entry, recorded: Entry): Entry {
  const ls = recorded.ls ?? stored.ls
  const lf = recorded.lf ?? stored.lf
  const k = recorded.k ?? stored.k
  return {
    s: stored.s + recorded.s,
    f: stored.f + recorded.f,
    // A success since then restarted the run of failures; otherwise it goes on.
    c: recorded.ls === undefined ? stored.c + recorded.c : recorded.c,
    ...(ls === undefined ? {} : { ls }),
    ...(lf === undefined ? {} : { lf }),
    ...(k === undefined ? {} : { k }),
  }
}

/** The health of every rung on every platform this device has used. */
export class RungHealthBook {
  #scopes = new Map<string, ScopeState>()
  #loaded: Promise<void> | undefined
  #saving: Promise<void> = Promise.resolve()
  #dirty = false
  readonly #store: RungHealthStore | undefined
  readonly #rungs: (() => readonly string[]) | undefined
  readonly #now: () => number
  readonly #cooldownMs: number
  readonly #maxCooldownMs: number

  constructor(options: RungHealthOptions = {}) {
    this.#store = options.store
    this.#rungs = options.rungs
    this.#now = options.now ?? Date.now
    this.#cooldownMs = options.cooldownMs ?? 5 * 60_000
    this.#maxCooldownMs = Math.max(this.#cooldownMs, options.maxCooldownMs ?? 60 * 60_000)
  }

  /** Loads the stored state once; a store that fails leaves the state in memory only. */
  ready(): Promise<void> {
    this.#loaded ??= (async () => {
      try {
        const stored = readStored(await this.#store?.load(), this.#now())
        // What was recorded before the load finished happened after what was stored.
        for (const [name, scope] of this.#scopes) {
          const before = stored.get(name)
          if (before === undefined) {
            stored.set(name, scope)
            continue
          }
          for (const [rung, entry] of scope.r) {
            const old = before.r.get(rung)
            before.r.set(rung, old === undefined ? entry : merged(old, entry))
          }
          if (scope.w !== undefined) {
            before.w = scope.w
            if (scope.wa === undefined) delete before.wa
            else before.wa = scope.wa
          }
        }
        this.#scopes = stored
        this.#prune()
      } catch {
        // Keep the in-memory state.
      }
    })()
    return this.#loaded
  }

  /** Resolves once every save started so far has finished: for tests, and before quitting. */
  settled(): Promise<void> {
    return this.#saving
  }

  /** When `rung`'s cool-down on `scope` ends, if it is cooling down now. */
  coolingUntil(scope: string, rung: string): number | undefined {
    const entry = this.#scopes.get(scope)?.r.get(rung)
    if (entry === undefined || entry.c === 0 || entry.lf === undefined) return undefined
    const now = this.#now()
    // A failure ahead of the clock was recorded while the clock was wrong: ignore it rather
    // than cool the rung down until then.
    if (entry.lf > now) return undefined
    const length = Math.min(this.#cooldownMs * 2 ** (entry.c - 1), this.#maxCooldownMs)
    const until = entry.lf + length
    return until > now ? until : undefined
  }

  /** Records that a URL of `rung` is known to play on `scope`. */
  succeed(scope: string, rung: string): void {
    const state = this.#scope(scope, rung)
    if (state === undefined) return
    const now = this.#now()
    const entry = state.r.get(rung) ?? { s: 0, f: 0, c: 0 }
    state.r.set(rung, { ...entry, s: entry.s + 1, c: 0, ls: now })
    state.w = rung
    state.wa = now
    this.#save()
  }

  /** Records that `rung` failed on `scope` for a reason of its own. */
  fail(scope: string, rung: string, why: RungFailure): void {
    const state = this.#scope(scope, rung)
    if (state === undefined) return
    const entry = state.r.get(rung) ?? { s: 0, f: 0, c: 0 }
    state.r.set(rung, { ...entry, f: entry.f + 1, c: entry.c + 1, lf: this.#now(), k: why })
    this.#save()
  }

  /** The health of `rungs` on `scope`, in that order. */
  snapshot(scope: string, rungs: readonly string[]): LadderHealth {
    const state = this.#scopes.get(scope)
    return {
      scope,
      ...(state?.w === undefined ? {} : { lastWorking: state.w }),
      ...(state?.wa === undefined ? {} : { lastWorkingAt: state.wa }),
      rungs: rungs.map((rung) => {
        const entry = state?.r.get(rung) ?? { s: 0, f: 0, c: 0 }
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

  /** The state of `name`, created when needed; `undefined` for a malformed name. */
  #scope(name: string, rung: string): ScopeState | undefined {
    if (!SCOPE_NAME.test(name) || !RUNG_NAME.test(rung)) return undefined
    let scope = this.#scopes.get(name)
    if (scope === undefined) {
      scope = { r: new Map() }
      this.#scopes.set(name, scope)
    }
    return scope
  }

  /** Forgets rungs the config no longer lists. */
  #prune(): void {
    if (this.#rungs === undefined) return
    const listed = new Set(this.#rungs())
    for (const scope of this.#scopes.values()) {
      for (const rung of scope.r.keys()) if (!listed.has(rung)) scope.r.delete(rung)
      if (scope.w !== undefined && !listed.has(scope.w)) {
        delete scope.w
        delete scope.wa
      }
    }
  }

  /** The state in its stored form, a small JSON value. */
  #stored(): unknown {
    const scopes: Record<string, unknown> = {}
    for (const [name, scope] of this.#scopes) {
      scopes[name] = {
        ...(scope.w === undefined ? {} : { w: scope.w }),
        ...(scope.wa === undefined ? {} : { wa: scope.wa }),
        r: Object.fromEntries(scope.r),
      }
    }
    return { v: 1, scopes }
  }

  /**
   * Saves the state once the stored one has loaded, so that a record made before then never
   * overwrites what was saved; saves run one at a time, each with the state as it is then.
   */
  #save(): void {
    const store = this.#store
    if (store === undefined) return
    this.#dirty = true
    this.#saving = this.#saving.then(async () => {
      if (!this.#dirty) return
      this.#dirty = false
      await this.ready()
      this.#prune()
      try {
        await store.save(structuredClone(this.#stored()))
      } catch {
        // The state stays in memory.
      }
    })
  }
}
