import { describe, expect, it } from 'vitest'
import { fetchWithTimeout } from './index'

/** A fetch that never answers on its own and rejects when its signal aborts. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })

describe('fetchWithTimeout', () => {
  it('returns the response when the request finishes in time', async () => {
    const quickFetch: typeof fetch = async () => new Response('ok')
    const response = await fetchWithTimeout(quickFetch, 'https://example.test', { timeoutMs: 1000 })
    expect(await response.text()).toBe('ok')
  })

  it('aborts with a TimeoutError when the request takes too long', async () => {
    await expect(
      fetchWithTimeout(hangingFetch, 'https://example.test', { timeoutMs: 10 }),
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
  })
})
