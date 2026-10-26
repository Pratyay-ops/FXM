/**
 * The recorder's binding to `@fxm/platform`, offline: the commands load the platform at run time
 * against a hand-written interface (`platform.ts`), which `tsc` cannot check, so this test runs
 * the same wiring with a fake `fetch`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadPlatform, recorderNetwork } from './platform'
import { emptyCheckpoint, parseCheckpoint } from './store'

// Should the transport ever ignore the fake `fetch`, it must not reach the network.
beforeAll(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))
})
afterAll(() => {
  vi.restoreAllMocks()
})

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'x' })
const AGENT = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36'

/** A `fetch` that answers every request with an empty JSON object, and notes what it sent. */
function fakeFetch() {
  const sent: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

describe("the recorder's network", async () => {
  const platform = await loadPlatform()

  it('sends a bulk InnerTube call through the budget, which keeps its state in the checkpoint', async () => {
    const checkpoint = emptyCheckpoint()
    const fake = fakeFetch()
    const network = recorderNetwork(platform, checkpoint, { fetch: fake.fetch, userAgent: AGENT })
    const response = await network.fetch(SEARCH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: BODY,
    })
    expect(response.status).toBe(200)
    expect(fake.sent.map((request) => request.url)).toEqual([`${SEARCH}?prettyPrint=false`])
    expect(network.budget.snapshot()).toMatchObject({ used: 1, pauseLevel: 0 })
    const stored = JSON.parse(checkpoint.budget['fxm.requestBudget'] ?? '{}') as {
      calls?: unknown[]
    }
    expect(stored.calls).toHaveLength(1)
  })

  it('carries the hour and a bot-check pause over to the next run', async () => {
    const checkpoint = emptyCheckpoint()
    const fake = fakeFetch()
    const network = recorderNetwork(platform, checkpoint, { fetch: fake.fetch })
    await network.fetch(SEARCH, { method: 'POST', body: BODY })
    network.budget.reportBotCheck('login-required')
    const pausedUntil = network.budget.snapshot().bulkPausedUntil
    expect(pausedUntil).toBeGreaterThan(Date.now())
    // The checkpoint as the next run reads it back from disk.
    const next = parseCheckpoint(JSON.parse(JSON.stringify(checkpoint)))
    const resumed = recorderNetwork(platform, next, { fetch: fakeFetch().fetch })
    expect(resumed.budget.snapshot()).toMatchObject({
      used: 1,
      pauseLevel: 1,
      bulkPausedUntil: pausedUntil,
    })
    // A bulk call during the pause is turned away at once, as the recorder expects.
    await expect(resumed.fetch(SEARCH, { method: 'POST', body: BODY })).rejects.toMatchObject({
      code: 'RateLimited',
      reason: 'paused',
    })
  })
})
