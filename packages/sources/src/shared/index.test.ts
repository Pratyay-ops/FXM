import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchWithTimeout } from './index'

/** A fetch that never answers on its own and rejects when its signal aborts. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason)
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })

/** The behaviour every engine must show, with or without `AbortSignal.timeout` and `.any`. */
function behavesLikeATimeout() {
  it('returns the response when the request finishes in time', async () => {
    const quickFetch: typeof fetch = async () => new Response('ok')
    const response = await fetchWithTimeout(quickFetch, 'https://example.test', { timeoutMs: 1000 })
    expect(await response.text()).toBe('ok')
  })

  it('aborts with a TimeoutError when the request takes too long', async () => {
    await expect(
      fetchWithTimeout(hangingFetch, 'https://example.test', { timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    const controller = new AbortController()
    await expect(
      fetchWithTimeout(hangingFetch, 'https://example.test', {
        timeoutMs: 10,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('still honours a signal from the caller', async () => {
    const controller = new AbortController()
    const request = fetchWithTimeout(hangingFetch, 'https://example.test', {
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const reason = new Error('left the page')
    await expect(
      fetchWithTimeout(hangingFetch, 'https://example.test', {
        timeoutMs: 10_000,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason)
  })
}

describe('fetchWithTimeout', () => {
  behavesLikeATimeout()

  describe('without AbortSignal.timeout and AbortSignal.any (Safari 16, iOS 16, macOS 11)', () => {
    const { timeout, any } = AbortSignal
    beforeEach(() => {
      Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true })
      Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true })
    })
    afterEach(() => {
      Object.defineProperty(AbortSignal, 'timeout', { value: timeout, configurable: true })
      Object.defineProperty(AbortSignal, 'any', { value: any, configurable: true })
    })

    behavesLikeATimeout()

    it('reports a timeout as such even where fetch rejects with a plain AbortError', async () => {
      const oldFetch: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        })
      await expect(
        fetchWithTimeout(oldFetch, 'https://example.test', { timeoutMs: 10 }),
      ).rejects.toMatchObject({ name: 'TimeoutError' })
    })
  })
})
