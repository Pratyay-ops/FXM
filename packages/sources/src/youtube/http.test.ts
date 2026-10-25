import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { abortReason, fetchText, untilAborted, within } from './http'

/** A transport that never answers and ignores every abort. */
const deaf: typeof fetch = () => new Promise<Response>(() => {})

/** A transport that answers at once. */
const quick: typeof fetch = async () => new Response('{"ok":true}', { status: 200 })

/** A transport that rejects with a bare AbortError when its signal aborts, as older ones do. */
const bare: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    )
  })

describe('requests with a deadline, on engines without AbortSignal.any or .timeout', () => {
  const saved = {
    any: Object.getOwnPropertyDescriptor(AbortSignal, 'any'),
    timeout: Object.getOwnPropertyDescriptor(AbortSignal, 'timeout'),
  }

  beforeEach(() => {
    // Safari before 17.4 and 16: iOS 16 and the system WebKit of macOS 11.
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true })
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true })
  })

  afterEach(() => {
    if (saved.any) Object.defineProperty(AbortSignal, 'any', saved.any)
    if (saved.timeout) Object.defineProperty(AbortSignal, 'timeout', saved.timeout)
  })

  it('read the answer', async () => {
    const { response, text } = await fetchText(quick, 'https://www.youtube.com/', {}, 1000)
    expect(response.status).toBe(200)
    expect(text).toBe('{"ok":true}')
  })

  it('time out with a TimeoutError, even when the transport ignores the abort', async () => {
    await expect(fetchText(deaf, 'https://www.youtube.com/', {}, 10)).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    await expect(fetchText(bare, 'https://www.youtube.com/', {}, 10)).rejects.toMatchObject({
      name: 'TimeoutError',
    })
  })

  it('stop with the caller’s reason when the caller cancels', async () => {
    const controller = new AbortController()
    const pending = fetchText(deaf, 'https://www.youtube.com/', {}, 10_000, controller.signal)
    controller.abort('user')
    await expect(pending).rejects.toBe('user')
    const cancelled = new AbortController()
    cancelled.abort('early')
    await expect(
      fetchText(quick, 'https://www.youtube.com/', {}, 10_000, cancelled.signal),
    ).rejects.toBe('early')
  })
})

describe('waits', () => {
  it('give up at their limit, and take a value that comes in time', async () => {
    expect(await within(new Promise<string>(() => {}), 10, 'late')).toBe('late')
    expect(await within(Promise.resolve('now'), 1000, 'late')).toBe('now')
    expect(await within(Promise.reject(new Error('x')), 1000, 'failed')).toBe('failed')
  })

  it('end with an AbortError where the engine keeps no abort reason', async () => {
    const old = {
      aborted: true,
      reason: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal
    expect(abortReason(old)).toMatchObject({ name: 'AbortError' })
    await expect(untilAborted(new Promise(() => {}), old)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
