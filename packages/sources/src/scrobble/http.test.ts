import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bodyText, MAX_RETRY_AFTER_MS, parseJson, RequestGate, retryAfterMs, sleep } from './http'

describe('retryAfterMs', () => {
  const NOW = Date.UTC(2026, 9, 26, 9)
  const headers = (init: Record<string, string>) => new Headers(init)

  it('reads Retry-After in seconds or as an HTTP date', () => {
    expect(retryAfterMs(headers({ 'retry-after': '30' }), NOW)).toBe(30_000)
    expect(retryAfterMs(headers({ 'retry-after': '1.5' }), NOW)).toBe(1500)
    const date = new Date(NOW + 90_000).toUTCString()
    expect(retryAfterMs(headers({ 'retry-after': date }), NOW)).toBe(90_000)
  })

  it("falls back to ListenBrainz's X-RateLimit-Reset-In", () => {
    expect(retryAfterMs(headers({ 'x-ratelimit-reset-in': '7' }), NOW)).toBe(7000)
    expect(retryAfterMs(headers({ 'retry-after': 'soon', 'x-ratelimit-reset-in': '2' }), NOW)).toBe(
      2000,
    )
  })

  it('caps waits at an hour, never goes below zero and ignores nonsense', () => {
    expect(retryAfterMs(headers({ 'retry-after': '999999' }), NOW)).toBe(MAX_RETRY_AFTER_MS)
    const past = new Date(NOW - 60_000).toUTCString()
    expect(retryAfterMs(headers({ 'retry-after': past }), NOW)).toBe(0)
    expect(retryAfterMs(headers({ 'retry-after': '-1' }), NOW)).toBeUndefined()
    expect(retryAfterMs(headers({}), NOW)).toBeUndefined()
  })
})

describe('RequestGate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 26, 9) })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const tooLong = (waitMs: number) => new Error(`wait ${waitMs}`)

  it('runs requests one at a time, in order, with the pause between them', async () => {
    const gate = new RequestGate({ minIntervalMs: 1000, maxWaitMs: 10_000, tooLong })
    const starts: number[] = []
    const request = (ms: number) => async () => {
      starts.push(Date.now())
      await sleep(ms)
      return ms
    }
    const done = Promise.all([gate.run(request(200)), gate.run(request(100)), gate.run(request(0))])
    await vi.runAllTimersAsync()
    expect(await done).toEqual([200, 100, 0])
    const t0 = starts[0] as number
    expect(starts.map((at) => at - t0)).toEqual([0, 1200, 2300])
  })

  it('keeps going after a request fails', async () => {
    const gate = new RequestGate({ minIntervalMs: 0, maxWaitMs: 10_000, tooLong })
    const failed = gate.run(async () => {
      throw new Error('boom')
    })
    await expect(failed).rejects.toThrow('boom')
    await expect(gate.run(async () => 'next')).resolves.toBe('next')
  })

  it('waits out a short hold, and fails at once beyond maxWaitMs', async () => {
    const gate = new RequestGate({ minIntervalMs: 0, maxWaitMs: 10_000, tooLong })
    gate.holdUntil(Date.now() + 5000)
    const started = Date.now()
    const waited = gate.run(async () => Date.now() - started)
    await vi.runAllTimersAsync()
    expect(await waited).toBe(5000)
    gate.holdUntil(Date.now() + 60_000)
    await expect(gate.run(async () => 'never')).rejects.toThrow('wait 60000')
  })

  it('takes a cancelled request out before it starts', async () => {
    const gate = new RequestGate({ minIntervalMs: 1000, maxWaitMs: 10_000, tooLong })
    const controller = new AbortController()
    const request = vi.fn(async () => 'ran')
    await gate.run(async () => 'first')
    const second = gate.run(request, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(second).rejects.toThrow('cancelled')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('bodyText and parseJson', () => {
  it('read whatever the answer holds, and nothing when it is broken', async () => {
    expect(await bodyText(new Response('{"a":1}'))).toBe('{"a":1}')
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('reset'))
        },
      }),
    )
    expect(await bodyText(broken)).toBeUndefined()
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson('<html>')).toBeUndefined()
    expect(parseJson('  ')).toBeUndefined()
    expect(parseJson(undefined)).toBeUndefined()
  })
})
