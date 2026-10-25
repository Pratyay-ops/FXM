/**
 * What Jamendo said about each `client_id` FXM used: nothing (it works), that its rate limit is
 * used up, that it does not know the ID, or that it suspended the app.
 *
 * Jamendo's free, non-commercial tier allows up to 35,000 API requests a month per `client_id`
 * (developer.jamendo.com, read 2026-10-25), and the public ID that FXM ships is shared by every
 * user. When Jamendo answers with code 6 ("Rate Limit Exceeded: this requester app or the
 * requester IP have exceeded the permitted rate limit"), FXM stops calling it with that ID for a
 * while instead of spending more requests: 15 minutes, then four times as long after each further
 * refusal, at most a day, and one request after that tells whether it works again. Meanwhile the
 * app shows "Jamendo's quota is used up: add your own client_id", and a user's own ID starts with
 * a clean record.
 *
 * @module
 */

/** The longest FXM waits before trying a rate-limited `client_id` again: a day. */
const MAX_COOLDOWN_MS = 86_400_000

/** The first wait after a rate-limit refusal: 15 minutes. */
const FIRST_COOLDOWN_MS = 900_000

/** Why FXM does not call Jamendo with a `client_id`. */
export type JamendoBlock =
  | {
      /** Jamendo answered code 6: the app's or the IP's rate limit is used up. */
      reason: 'quota-exceeded'
      /** When Jamendo first refused, in epoch milliseconds. */
      since: number
      /** When FXM tries again, in epoch milliseconds. */
      retryAt: number
      /** How many refusals in a row. */
      strikes: number
    }
  | {
      /** Jamendo answered code 5: it does not know this `client_id`. */
      reason: 'invalid-client-id'
    }
  | {
      /** Jamendo answered code 11: it suspended the application. */
      reason: 'suspended'
    }

/** Every block, by `client_id`: what an app saves and passes back on its next start. */
export type JamendoQuotaSnapshot = Record<string, JamendoBlock>

/** What a request's answer means for its `client_id`. */
export type JamendoOutcome = 'ok' | 'rate-limited' | 'invalid' | 'suspended'

/** Settings of a {@link JamendoQuota}. */
export interface JamendoQuotaOptions {
  /** Blocks saved from an earlier run, e.g. from the settings store. */
  saved?: JamendoQuotaSnapshot
  /** The clock, in epoch milliseconds. `Date.now` by default. */
  now?: () => number
}

/** Whether `value` is a block FXM wrote. Anything else in a saved snapshot is dropped. */
function isBlock(value: unknown): value is JamendoBlock {
  if (typeof value !== 'object' || value === null) return false
  const block = value as Record<string, unknown>
  if (block.reason === 'invalid-client-id' || block.reason === 'suspended') return true
  return (
    block.reason === 'quota-exceeded' &&
    [block.since, block.retryAt, block.strikes].every(
      (field) => typeof field === 'number' && Number.isFinite(field),
    )
  )
}

/** The blocks of every `client_id` FXM used, with listeners for the settings screen. */
export class JamendoQuota {
  private readonly blocks = new Map<string, JamendoBlock>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number

  constructor(options: JamendoQuotaOptions = {}) {
    this.now = options.now ?? Date.now
    for (const [clientId, block] of Object.entries(options.saved ?? {})) {
      if (isBlock(block)) this.blocks.set(clientId, { ...block })
    }
  }

  /**
   * The block on `clientId` that still applies, or `undefined` when FXM may call Jamendo with
   * it. A rate-limit block stops applying at its `retryAt`, so that one request can tell whether
   * the limit was lifted; it stays recorded until that request answers.
   */
  blocked(clientId: string): JamendoBlock | undefined {
    const block = this.blocks.get(clientId)
    if (block?.reason === 'quota-exceeded' && this.now() >= block.retryAt) return undefined
    return block
  }

  /** The recorded block on `clientId`, whether or not it still applies. */
  recorded(clientId: string): JamendoBlock | undefined {
    return this.blocks.get(clientId)
  }

  /** Records what Jamendo answered to a request made with `clientId`. */
  record(clientId: string, outcome: JamendoOutcome): void {
    const before = this.blocks.get(clientId)
    if (outcome === 'ok') {
      if (before === undefined) return
      this.blocks.delete(clientId)
    } else if (outcome === 'rate-limited') {
      const now = this.now()
      const strikes = before?.reason === 'quota-exceeded' ? before.strikes + 1 : 1
      const cooldown = Math.min(FIRST_COOLDOWN_MS * 4 ** (strikes - 1), MAX_COOLDOWN_MS)
      const since = before?.reason === 'quota-exceeded' ? before.since : now
      this.blocks.set(clientId, {
        reason: 'quota-exceeded',
        since,
        retryAt: now + cooldown,
        strikes,
      })
    } else {
      this.blocks.set(clientId, {
        reason: outcome === 'invalid' ? 'invalid-client-id' : 'suspended',
      })
    }
    for (const listener of this.listeners) listener()
  }

  /** Every recorded block, to save and pass back as `saved` on the next start. */
  snapshot(): JamendoQuotaSnapshot {
    return Object.fromEntries([...this.blocks].map(([clientId, block]) => [clientId, { ...block }]))
  }

  /** Calls `listener` whenever a block is recorded or lifted. Returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
