/**
 * The sentences of Settings → Diagnostics that the page and its copied report share: FXM
 * Connect's and Lite's state, the request budget, and why the song self-test failed.
 *
 * @module
 */

import { isFxmError } from '@fxm/core'
import { type BudgetSnapshot, type ConnectStatus, MIN_CONNECT_VERSION } from '@fxm/platform'
import type { LiteStatus } from './connection'
import type { ProbeFailure, ProbeResult } from './playback-probe'

/** FXM Connect's state, in a few words. */
export function connectSummary(status: ConnectStatus | undefined, platform: string): string {
  if (platform !== 'web') return 'Not needed in the app'
  switch (status?.state) {
    case undefined:
      return 'Not checked yet'
    case 'present':
      return `Version ${status.version ?? '?'}, on`
    case 'outdated':
      return `Version ${status.version ?? '?'}, too old: FXM needs ${MIN_CONNECT_VERSION} or later`
    case 'missing':
      return status.lastSeenVersion === undefined
        ? 'Not answering, though it worked here before'
        : `Not answering, though version ${status.lastSeenVersion} worked here before`
    case 'absent':
      return 'Not installed'
  }
}

/** Lite's state, in a few words. */
export function liteSummary(lite: LiteStatus, platform: string): string {
  switch (lite) {
    case 'not-needed':
      return platform === 'web'
        ? 'Not needed: FXM Connect gives full access'
        : 'Not needed in the app'
    case 'unavailable':
      return 'Not available here'
    case 'switched-off':
      return 'Switched off for everyone at the moment'
    case 'checking':
      return 'Checking…'
    case 'passed':
      return 'Check passed'
    case 'failed':
      return "Check didn't pass in this browser"
  }
}

/** The request budget, in a sentence. */
export function budgetSummary(budget: BudgetSnapshot | undefined, now = Date.now()): string {
  if (budget === undefined) return 'Not started yet'
  const used = `${budget.used} of ${budget.hourlyLimit} in the last hour`
  if (budget.bulkPausedUntil === undefined || budget.bulkPausedUntil <= now) return used
  const until = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
    budget.bulkPausedUntil,
  )
  return `${used}. After a bot check, background work such as imports waits until ${until}; playback goes on.`
}

/** A duration such as "3.0 s". */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

const PROBE_FAILURES: Readonly<Record<ProbeFailure, string>> = {
  'media-error': "the browser couldn't play it",
  stalled: 'it stalled',
  timeout: "it didn't start in time",
  blocked: 'the browser blocked playback; allow sound for this site and try again',
  aborted: 'stopped',
}

/** Why a stream didn't play, e.g. "the browser couldn't play it (MEDIA_ERR_DECODE)". */
export function failureText(result: Exclude<ProbeResult, { ok: true }>): string {
  const text = PROBE_FAILURES[result.reason]
  return result.detail === undefined ? text : `${text} (${result.detail})`
}

/** Why the resolution failed, from the resolver's `FxmError`. */
export function resolveErrorText(error: unknown): string {
  if (!isFxmError(error)) return "The song couldn't be resolved."
  switch (error.code) {
    case 'BotCheck':
      return "YouTube asked to confirm you're not a bot, and refused. Try again later."
    case 'RateLimited':
      return 'Too many YouTube requests for now. Try again in a few minutes.'
    case 'Network':
      return "The request didn't get through. Check your connection and try again."
    case 'Unavailable':
    case 'GeoBlocked':
    case 'NotFound':
      return "The test song isn't available here."
    case 'Unsupported':
      return "FXM can't reach YouTube Music for this request here."
    default:
      return "The song couldn't be resolved."
  }
}
