/**
 * The one place the stream resolver meets the shared request budget of `@fxm/platform` (stage
 * 1.2): a slot for every InnerTube call it makes, and a report for every bot check it sees.
 *
 * {@link StreamBudget} is the part of 1.2's `RequestBudget` the resolver uses, with the same
 * names and values, so that budget can be passed as it is. 1.2's transports already draw a slot
 * for every InnerTube call and report `LOGIN_REQUIRED` and HTTP 429 themselves, so with a
 * `ctx.fetch` from one of them, leave the budget out (or pass one whose `acquire` does nothing)
 * so that no call is counted twice.
 *
 * @module
 */

/**
 * What an InnerTube call is for, highest priority first, as in `@fxm/platform`:
 * `current-track` (the track that plays or is about to), `prefetch` (the next tracks),
 * `interactive` and `bulk`.
 */
export type StreamRequestPriority = 'current-track' | 'prefetch' | 'interactive' | 'bulk'

/** Why YouTube seems to have flagged the IP address, as in `@fxm/platform`. */
export type BotCheckCause = 'login-required' | 'rate-limited'

/** The request budget, as far as the stream resolver needs it. */
export interface StreamBudget {
  /**
   * Takes a slot for one InnerTube call, before it is sent. Rejects (e.g. with a `RateLimited`
   * `FxmError`) when the call may not go now; the resolver then stops and passes that on.
   */
  acquire(priority: StreamRequestPriority, options?: { signal?: AbortSignal }): Promise<void>
  /**
   * Reports a bot check: a `LOGIN_REQUIRED` bot check in a `/player` response (not an age
   * gate), or an HTTP 429.
   */
  reportBotCheck(cause: BotCheckCause): void
}

/**
 * A budget that counts nothing: the default, for a `ctx.fetch` that draws on the budget itself
 * (1.2's transports) and for tests that do not look at the budget.
 */
export const UNMETERED_STREAM_BUDGET: StreamBudget = Object.freeze({
  acquire: () => Promise.resolve(),
  reportBotCheck: () => {},
})
