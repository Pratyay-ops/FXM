/**
 * A 1,000-track import run the way a job runner runs one: it waits for a bulk slot with
 * `budget.whenAvailable` before each provider call, outside any timeout, and the provider fetches
 * through the transport's `bulk` fetch with a 15 s request timeout, like the providers' own
 * `fetchWithTimeout`. Meanwhile the user listens, and two hours in YouTube answers a playback
 * call with a bot check. No call may time out, the hour's cap holds, playback never waits, and
 * the import pauses for 30 minutes, then resumes where it was.
 */
import { describe, expect, it } from 'vitest'
import { createRequestBudget, isBudgetError } from './budget'
import { createNodeTransport } from './node'
import { createFakeClock, type FakeClock } from './testing/fake-clock'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const START = Date.UTC(2026, 9, 25, 12)

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const PLAYER = 'https://www.youtube.com/youtubei/v1/player'
const body = (query: string) =>
  JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query })

/** `fetchWithTimeout` of `packages/sources`, on the fake clock. */
function withTimeout(fetch: typeof globalThis.fetch, clock: FakeClock, timeoutMs: number) {
  return async (input: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController()
    const timer = clock.setTimeout(
      () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      timeoutMs,
    )
    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clock.clearTimeout(timer)
    }
  }
}

/** Calls in the hour that ends at `time`. */
function inHour(times: readonly number[], time: number): number {
  return times.filter((t) => t > time - HOUR && t <= time).length
}

describe('a 1,000-track import through the transport', () => {
  it('never times out, stays under the cap, gives way to playback and pauses on a bot check', async () => {
    const clock = createFakeClock(START)
    const budget = createRequestBudget({ clock })
    const botCheckAt = START + 2 * HOUR
    const searchesSent: number[] = []
    const playerSent: number[] = []
    const upstream = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(PLAYER)) {
        playerSent.push(clock.now())
        const flagged = clock.now() === botCheckAt
        return Response.json({
          playabilityStatus: flagged
            ? { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' }
            : { status: 'OK' },
        })
      }
      searchesSent.push(clock.now())
      return Response.json({ contents: {} })
    }) as typeof fetch
    const transport = createNodeTransport({ budget, fetch: upstream })

    // The import: one search per track, retried after a budget refusal, never skipped.
    const provider = withTimeout(transport.withPriority('bulk'), clock, 15 * SECOND)
    const imported: number[] = []
    const failures: unknown[] = []
    let refusals = 0
    const importer = (async () => {
      while (imported.length < 1000) {
        await budget.whenAvailable('bulk')
        try {
          const response = await provider(SEARCH, {
            method: 'POST',
            body: body(`track ${imported.length}`),
          })
          await response.json()
          imported.push(clock.now())
        } catch (error) {
          if (isBudgetError(error)) refusals += 1
          else {
            failures.push(error)
            return
          }
        }
      }
    })()

    // The user listens: a track every 3 minutes, resolved with one call for the current track
    // and two to prefetch the next ones. They must never wait.
    const playbackFailures: unknown[] = []
    const play = (priority: 'current-track' | 'prefetch') =>
      transport
        .withPriority(priority)(PLAYER, { method: 'POST', body: body('') })
        .catch((error: unknown) => {
          playbackFailures.push(error)
        })
    const listen = () => {
      void play('current-track')
      void play('prefetch')
      void play('prefetch')
      clock.setTimeout(listen, 3 * MINUTE)
    }
    listen()

    for (let hour = 0; hour < 6 && imported.length < 1000 && failures.length === 0; hour += 1) {
      await clock.advanceAsync(HOUR)
    }
    await importer

    expect(failures).toEqual([])
    expect(playbackFailures).toEqual([])
    expect(imported).toHaveLength(1000)
    expect(searchesSent).toHaveLength(1000)
    expect(refusals).toBe(0)
    expect(budget.snapshot().lastBotCheck).toEqual({ at: botCheckAt, cause: 'login-required' })

    const all = [...searchesSent, ...playerSent].sort((a, b) => a - b)
    for (const time of all) expect(inHour(all, time)).toBeLessThanOrEqual(600)
    for (const time of searchesSent) expect(inHour(searchesSent, time)).toBeLessThanOrEqual(500)
    for (let index = 1; index < searchesSent.length; index += 1) {
      expect(searchesSent[index] as number).toBeGreaterThanOrEqual(
        (searchesSent[index - 1] as number) + 5 * SECOND,
      )
    }
    // Playback went on during the pause; the import sent nothing then, and resumed right after.
    const pauseEnd = botCheckAt + 30 * MINUTE
    expect(playerSent.some((t) => t > botCheckAt && t < pauseEnd)).toBe(true)
    expect(searchesSent.some((t) => t > botCheckAt && t < pauseEnd)).toBe(false)
    expect(searchesSent.some((t) => t >= pauseEnd && t < pauseEnd + MINUTE)).toBe(true)
  })

  it('turns a bulk call made during a pause away at once, so the runner can wait and resume', async () => {
    const clock = createFakeClock(START)
    const budget = createRequestBudget({ clock })
    const sent: number[] = []
    const transport = createNodeTransport({
      budget,
      fetch: (async () => {
        sent.push(clock.now())
        return Response.json({})
      }) as typeof fetch,
    })
    const provider = withTimeout(transport.withPriority('bulk'), clock, 15 * SECOND)
    budget.reportBotCheck('rate-limited')
    let error: unknown
    try {
      await provider(SEARCH, { method: 'POST', body: body('x') })
    } catch (caught) {
      error = caught
    }
    expect(isBudgetError(error, 'paused')).toBe(true)
    expect(budget.nextSlotAt('bulk')).toBe(START + 30 * MINUTE)
    let resumed = false
    void budget.whenAvailable('bulk').then(() => {
      resumed = true
    })
    await clock.advanceAsync(30 * MINUTE - 1)
    expect(resumed).toBe(false)
    await clock.advanceAsync(1)
    expect(resumed).toBe(true)
    await provider(SEARCH, { method: 'POST', body: body('x') })
    expect(sent).toEqual([START + 30 * MINUTE])
  })
})
