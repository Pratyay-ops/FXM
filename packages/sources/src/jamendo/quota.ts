/**
 * What Jamendo said about each `client_id` FXM used, so that FXM stops sending requests that
 * cannot succeed: nothing (it works), that its rate limit is used up (code 6, or HTTP 429), that
 * it does not know the ID (code 5), or that it suspended the app (code 11).
 *
 * Jamendo's free, non-commercial tier allows up to 35,000 API requests a month per `client_id`
 * (developer.jamendo.com, read 2026-10-25), and the public ID that FXM ships is shared by every
 * user. After a refusal, FXM blocks that ID for a while instead of spending more requests: 15
 * minutes, then four times as long after each further refusal for the same reason (1 h, 4 h,
 * 16 h), at most a day. Once the wait is over, one request tells whether the ID works again (the
 * API sends it, and fails the others at once until it answers). An answer to a request that was
 * sent before the block was recorded never changes it, so a burst of concurrent refusals counts
 * as one.
 *
 * Meanwhile the app shows "Jamendo's quota is used up: add your own client_id". A user's own ID
 * has its own record. Entering an ID in Settings clears its record, and so does
 * {@link JamendoQuota.forget}, e.g. from a "Try again" button.
 *
 * @module
 */

/** The longest FXM waits before trying a refused `client_id` again: a day. */
const MAX_COOLDOWN_MS = 86_400_000

/** The first wait after a refusal: 15 minutes. */
const FIRST_COOLDOWN_MS = 900_000

/**
 * Why FXM does not call Jamendo with a `client_id`, in the words `JamendoAccess.status` uses:
 *
 * - `quota-exceeded`: code 6 or HTTP 429, the app's or the IP's rate limit is used up
 * - `invalid-client-id`: code 5, Jamendo does not know the ID
 * - `suspended`: code 11, Jamendo suspended the application
 */
export type JamendoBlockReason = 'quota-exceeded' | 'invalid-client-id' | 'suspended'

/** Every {@link JamendoBlockReason}. */
const REASONS: readonly string[] = ['quota-exceeded', 'invalid-client-id', 'suspended']

/** A block on a `client_id`: why, since when, and until when. */
export interface JamendoBlock {
  /** What Jamendo answered. */
  reason: JamendoBlockReason
  /** When Jamendo first refused for this reason, in epoch milliseconds. */
  since: number
  /** When FXM tries again, in epoch milliseconds. */
  retryAt: number
  /** How many refusals for this reason in a row, one per wait. */
  strikes: number
}

/** Every block, by `client_id`: what an app saves and passes back on its next start. */
export type JamendoQuotaSnapshot = Record<string, JamendoBlock>

/** What a request's answer means for its `client_id`: it worked, or why Jamendo refused it. */
export type JamendoOutcome = 'ok' | JamendoBlockReason

/** Settings of a {@link JamendoQuota}. */
export interface JamendoQuotaOptions {
  /** Blocks saved from an earlier run, e.g. from the settings store. */
  saved?: JamendoQuotaSnapshot
  /** The clock, in epoch milliseconds. `Date.now` by default. */
  now?: () => number
}

/** A finite number, or `undefined`. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * A saved block as FXM may use it, or `undefined` when it is not one FXM wrote. A block saved
 * while the device's clock was wrong, or a damaged store, could otherwise block an ID for
 * months, so the wait is cut to at most a day from `now`, `since` to at most the end of the wait,
 * and anything but a whole number of strikes from 1 counts as 1.
 */
function restoreBlock(value: unknown, now: number): JamendoBlock | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const fields = value as Record<string, unknown>
  const reason = fields.reason
  const since = finite(fields.since)
  const retryAt = finite(fields.retryAt)
  if (typeof reason !== 'string' || !REASONS.includes(reason)) return undefined
  if (since === undefined || retryAt === undefined) return undefined
  const until = Math.min(retryAt, now + MAX_COOLDOWN_MS)
  const strikes = Number.isSafeInteger(fields.strikes) && Number(fields.strikes) >= 1
  return {
    reason: reason as JamendoBlockReason,
    since: Math.min(since, until),
    retryAt: until,
    strikes: strikes ? Number(fields.strikes) : 1,
  }
}

/** The blocks of every `client_id` FXM used, with listeners for the settings screen. */
export class JamendoQuota {
  private readonly blocks = new Map<string, JamendoBlock>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number

  constructor(options: JamendoQuotaOptions = {}) {
    this.now = options.now ?? Date.now
    const now = this.now()
    for (const [clientId, saved] of Object.entries(options.saved ?? {})) {
      const block = restoreBlock(saved, now)
      if (block !== undefined) this.blocks.set(clientId, block)
    }
  }

  /**
   * The block on `clientId` while its wait lasts, or `undefined` when FXM may call Jamendo with
   * it. Once the wait is over the block stays recorded until a request answers, so that the
   * first one can tell whether the ID works again.
   */
  blocked(clientId: string): JamendoBlock | undefined {
    const block = this.blocks.get(clientId)
    return block !== undefined && this.now() < block.retryAt ? { ...block } : undefined
  }

  /** The recorded block on `clientId`, whether or not its wait is over. */
  recorded(clientId: string): JamendoBlock | undefined {
    const block = this.blocks.get(clientId)
    return block === undefined ? undefined : { ...block }
  }

  /**
   * Records what Jamendo answered to a request made with `clientId`. While a block's wait lasts,
   * a success or a refusal for the same reason comes from a request sent before the block was
   * recorded, so it changes nothing; a refusal for another reason replaces the block. After the
   * wait, a success lifts the block and a refusal for the same reason waits four times as long.
   */
  record(clientId: string, outcome: JamendoOutcome): void {
    const before = this.blocks.get(clientId)
    const now = this.now()
    if (before !== undefined && now < before.retryAt) {
      if (outcome === 'ok' || outcome === before.reason) return
    }
    if (outcome === 'ok') {
      if (before === undefined) return
      this.blocks.delete(clientId)
    } else {
      const again = before?.reason === outcome
      const strikes = again ? before.strikes + 1 : 1
      this.blocks.set(clientId, {
        reason: outcome,
        since: again ? before.since : now,
        retryAt: now + Math.min(FIRST_COOLDOWN_MS * 4 ** (strikes - 1), MAX_COOLDOWN_MS),
        strikes,
      })
    }
    this.notify()
  }

  /**
   * Forgets the block on `clientId`, so that the next request tests the ID again: for a "Try
   * again" button in Settings. Entering an ID in Settings (`setUserClientId`) does this too.
   */
  forget(clientId: string): void {
    if (this.blocks.delete(clientId)) this.notify()
  }

  /** Every recorded block, to save and pass back as `saved` on the next start. */
  snapshot(): JamendoQuotaSnapshot {
    return Object.fromEntries([...this.blocks].map(([clientId, block]) => [clientId, { ...block }]))
  }

  /**
   * Calls `listener` whenever a block is recorded, changed, lifted or forgotten. Returns the
   * unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
