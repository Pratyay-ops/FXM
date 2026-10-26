/**
 * The recorder: fetches the YouTube Music pages every input of the labelled set needs, through
 * the shared request budget as bulk work, and writes them into the groups' files as it goes.
 *
 * For each input it runs the matching planner exactly as `runMatch` does, once per option set of
 * `matchingEval.RECORDING_OPTIONS` and once more with the ISRC-miss cap lifted, and fetches every
 * page any of them asks for that is not recorded yet. Then it fetches the descriptions the label
 * rules still need, for the most important picks first (at most `maxEvidence` per group and run,
 * two by default). Pages are shared: a page two inputs ask for is fetched once.
 *
 * **Resumable.** Each page is written to the group's file as soon as it arrives, and a group is
 * marked done in the checkpoint, with a fingerprint of its inputs, once all of its pages are
 * there. A run that stops (Ctrl-C, a crash, two bot checks) loses nothing: the next run skips
 * the done groups and the recorded pages, and goes on. A done group whose inputs changed since
 * (the inputs phase completed or rebuilt them) is planned again, and only its missing pages are
 * fetched.
 *
 * **Budget.** Before every page it waits for a bulk slot (`whenAvailable('bulk')`), outside the
 * provider's request timeout, and the provider context's `fetch` draws the slot (the platform
 * transport's `bulk` fetch): at least 5 s apart, and only while 100 calls of the hour remain.
 * A bot check pauses bulk work (30 minutes, doubling); the recorder writes the pause to the
 * checkpoint at once, waits it out, and stops after `maxBotChecks` of them, so a flagged IP
 * address is left alone. Groups that fail one after another (YouTube changed, the network is
 * down) stop the run too.
 *
 * @module
 */

import {
  addMatchResponse,
  isFxmError,
  MATCHER_VERSION,
  type MatchPages,
  matchingEval,
  nextMatchRequest,
  type ProviderContext,
} from '@fxm/core'
import { fetchPage, type PageProviders } from './pages'
import type { EvalCheckpoint, EvalStore } from './store'

type EvalGroup = matchingEval.EvalGroup
type EvalRecording = matchingEval.EvalRecording

/** The part of `@fxm/platform`'s `RequestBudget` the recorder uses, with the same names. */
export interface RecorderBudget {
  /** Resolves once a bulk call would get a slot at once (through pauses and a used-up hour). */
  whenAvailable(priority: 'bulk', options?: { signal?: AbortSignal }): Promise<void>
  /** Reports a bot check, which pauses bulk work. */
  reportBotCheck(cause: 'login-required' | 'rate-limited'): void
  /** The budget's state: `bulkPausedUntil` (epoch milliseconds) while bulk work is paused. */
  snapshot(): { bulkPausedUntil?: number }
}

/** Options for {@link recordGroups}. */
export interface RecorderOptions {
  /** The YouTube providers. */
  providers: PageProviders
  /** The provider context: Music mode, and a `fetch` that draws bulk slots from the budget. */
  ctx: ProviderContext
  /** The shared request budget. */
  budget: RecorderBudget
  /** Where the groups and the checkpoint live. */
  store: EvalStore
  /** The checkpoint to update; read from the store when absent. */
  checkpoint?: EvalCheckpoint
  /** Records at most this many groups in this run. */
  limit?: number
  /** Records only these groups. */
  only?: readonly string[]
  /**
   * Plans every group again, done or not, and fetches whatever page is missing: after a change
   * to the planner that `MATCHER_VERSION` does not mark. Offline for complete groups.
   */
  recheck?: boolean
  /** Descriptions fetched per group and run for the label rules, at most. Default 2. */
  maxEvidence?: number
  /** Tries per page before the group is deferred to the next run. Default 3. */
  maxAttempts?: number
  /** Bot checks (or YouTube 429s) after which the run stops. Default 2. */
  maxBotChecks?: number
  /** Groups deferred one after another after which the run stops. Default 3. */
  maxFailuresInRow?: number
  /** How long to wait after a network error, in milliseconds. Default 15 s. */
  retryDelayMs?: number
  /** Waits; `setTimeout` by default. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** The clock; `new Date()` by default. */
  now?: () => Date
  /** Progress, one line at a time. */
  log?: (line: string) => void
  /** Stops the run; the checkpoint keeps what was done. */
  signal?: AbortSignal
}

/** What a run did. */
export interface RecordSummary {
  /** Groups completed in this run. */
  recorded: string[]
  /** Groups that failed in this run and wait for the next one. */
  deferred: string[]
  /** Groups not done after this run. */
  remaining: number
  /** Pages fetched in this run (one InnerTube call each). */
  pages: number
  /** Why the run stopped before the end, if it did. */
  stopped?: string
}

/** A reason to stop the whole run, not just one group. */
class RecorderStop extends Error {
  override readonly name = 'RecorderStop'
}

/** Whether the budget turned the call away (a `BudgetError` from `@fxm/platform`). */
function isBudgetRefusal(error: unknown): boolean {
  const reason = (error as { reason?: unknown } | null)?.reason
  return (
    isFxmError(error, 'RateLimited') &&
    (reason === 'paused' || reason === 'spacing' || reason === 'reserve')
  )
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * What a group's recording is for: its inputs, the recorder's option sets and the matcher
 * version. A done group whose fingerprint changed needs its pages planned again.
 */
export function recordingFingerprint(group: EvalGroup): string {
  const text = JSON.stringify([group.variants, matchingEval.RECORDING_OPTIONS, MATCHER_VERSION])
  const forward = matchingEval.stableHash(text)
  const backward = matchingEval.stableHash([...text].reverse().join(''))
  return `${forward.toString(16).padStart(8, '0')}${backward.toString(16).padStart(8, '0')}`
}

/** Records the pages of the groups in the store that are not done yet. */
export async function recordGroups(options: RecorderOptions): Promise<RecordSummary> {
  const {
    providers,
    ctx,
    budget,
    store,
    limit,
    only,
    recheck = false,
    maxEvidence = 2,
    maxAttempts = 3,
    maxBotChecks = 2,
    maxFailuresInRow = 3,
    retryDelayMs = 15_000,
    sleep = defaultSleep,
    now = () => new Date(),
    log = () => {},
    signal,
  } = options
  const checkpoint = options.checkpoint ?? (await store.readCheckpoint())
  const ids = only ?? (await store.listGroups())
  const summary: RecordSummary = { recorded: [], deferred: [], remaining: 0, pages: 0 }
  let botChecks = 0
  let failuresInRow = 0

  /** Waits for a bulk slot, saying so when a bot-check pause holds it up. */
  async function waitForSlot(): Promise<void> {
    const pausedUntil = budget.snapshot().bulkPausedUntil
    if (pausedUntil !== undefined) {
      log(`bulk work is paused until ${new Date(pausedUntil).toISOString()}; waiting`)
    }
    await budget.whenAvailable('bulk', signal === undefined ? {} : { signal })
    if (pausedUntil !== undefined) log('bulk work resumed')
  }

  /** Fetches one page, waiting for the budget and retrying passing failures. */
  async function fetchOne(key: string, recording: EvalRecording): Promise<void> {
    let attempt = 1
    for (;;) {
      await waitForSlot()
      try {
        await fetchPage(key, providers, ctx, recording)
        summary.pages += 1
        checkpoint.requests.youtube += 1
        return
      } catch (error) {
        if (signal?.aborted) throw error
        if (isBudgetRefusal(error)) continue
        if (isFxmError(error, 'BotCheck') || isFxmError(error, 'RateLimited')) {
          // A 429 was reported by the transport already; a bot-check answer is reported here.
          if (isFxmError(error, 'BotCheck')) budget.reportBotCheck('login-required')
          botChecks += 1
          const pausedUntil = budget.snapshot().bulkPausedUntil
          log(
            `bot check ${botChecks} of ${maxBotChecks} on ${key}: ${messageOf(error)}` +
              (pausedUntil === undefined
                ? ''
                : `; bulk work paused until ${new Date(pausedUntil).toISOString()}`),
          )
          // The pause reaches disk before the wait, so a run killed meanwhile still honours it.
          await store.writeCheckpoint(checkpoint)
          if (botChecks >= maxBotChecks) {
            throw new RecorderStop(`stopped after ${botChecks} bot checks; resume later`)
          }
          continue
        }
        if (isFxmError(error, 'Unsupported')) {
          throw new RecorderStop(`YouTube is unreachable from this context: ${messageOf(error)}`)
        }
        if (isFxmError(error, 'NotFound')) {
          recording.pages[key] = { error: 'NotFound' }
          return
        }
        // Anything else (a network error, an answer the parsers do not understand) defers the
        // group after the last try: a page is filed as failed only when YouTube says it is gone.
        if (attempt >= maxAttempts) throw error
        attempt += 1
        log(`retrying ${key} after ${messageOf(error)}`)
        await sleep(retryDelayMs, signal)
      }
    }
  }

  async function recordGroup(group: EvalGroup): Promise<void> {
    const recording = group.recording ?? matchingEval.emptyRecording()
    group.recording = recording
    const ensure = async (key: string) => {
      if (matchingEval.isRecorded(recording, key)) return
      await fetchOne(key, recording)
      const day = now().toISOString().slice(0, 10)
      const days = [...new Set([...recording.recordedAt, day])].sort()
      recording.recordedAt = days.length > 2 ? [days[0] ?? day, days.at(-1) ?? day] : days
      await store.writeGroup(group)
      await store.writeCheckpoint(checkpoint)
    }
    for (const variant of group.variants) {
      const uncapped = matchingEval.withoutIsrcCap(variant.source)
      for (const source of uncapped === undefined ? [variant.source] : [variant.source, uncapped]) {
        for (const matchOptions of matchingEval.RECORDING_OPTIONS) {
          let pages: MatchPages = {}
          for (let count = 0; count < 12; count++) {
            const request = nextMatchRequest(source, pages, matchOptions)
            if (request === null) break
            for (const key of matchingEval.pageKeys(request)) await ensure(key)
            pages = addMatchResponse(
              pages,
              request,
              matchingEval.answerFromRecording(request, recording),
            )
          }
        }
      }
    }
    // Descriptions that may settle an ambiguous label, for the most important picks first (the
    // main input's pick with the default options leads; see `labelTargets`).
    let evidence = 0
    for (const videoId of matchingEval.labelTargets(group)) {
      if (evidence >= maxEvidence) break
      const key = `description/${videoId}`
      if (matchingEval.isRecorded(recording, key)) continue
      const draft = matchingEval.draftLabel(group, videoId)
      if (draft?.ambiguous !== true) continue
      await ensure(key)
      evidence += 1
    }
    await store.writeGroup(group)
  }

  const isDone = (group: EvalGroup) =>
    !recheck && checkpoint.record.done[group.id] === recordingFingerprint(group)

  try {
    for (const id of ids) {
      if (limit !== undefined && summary.recorded.length + summary.deferred.length >= limit) break
      signal?.throwIfAborted()
      const group = await store.readGroup(id)
      if (group === undefined || isDone(group)) continue
      try {
        await recordGroup(group)
        checkpoint.record.done[id] = recordingFingerprint(group)
        delete checkpoint.record.deferred[id]
        summary.recorded.push(id)
        failuresInRow = 0
        log(`recorded ${id} (${summary.pages} pages so far)`)
      } catch (error) {
        if (error instanceof RecorderStop || signal?.aborted) throw error
        delete checkpoint.record.done[id]
        const attempts = (checkpoint.record.deferred[id]?.attempts ?? 0) + 1
        checkpoint.record.deferred[id] = { attempts, error: messageOf(error) }
        summary.deferred.push(id)
        failuresInRow += 1
        log(`deferred ${id}: ${messageOf(error)}`)
        if (failuresInRow >= maxFailuresInRow) {
          throw new RecorderStop(
            `stopped after ${failuresInRow} groups in a row failed (last: ${messageOf(error)}); YouTube may have changed or the network is down, so resume later`,
          )
        }
      }
      await store.writeCheckpoint(checkpoint)
    }
  } catch (error) {
    if (error instanceof RecorderStop) summary.stopped = error.message
    else if (signal?.aborted) summary.stopped = 'aborted'
    else throw error
    log(summary.stopped)
  } finally {
    await store.writeCheckpoint(checkpoint)
  }
  for (const id of ids) {
    const group = await store.readGroup(id)
    if (group !== undefined && checkpoint.record.done[id] !== recordingFingerprint(group)) {
      summary.remaining += 1
    }
  }
  return summary
}
