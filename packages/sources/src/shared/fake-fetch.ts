/**
 * Test helpers for the free-source providers: a fake service behind an injected `fetch` that
 * records every request, JSON responses and provider contexts. Only tests import this module.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'

/** A JSON response, 200 by default. */
export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** One request a fake service received. */
export interface Call {
  /** The URL. */
  url: URL
  /** The request headers. */
  headers: Headers
  /** The request options as passed. */
  init: RequestInit | undefined
  /** When it arrived, by `Date.now()`. */
  at: number
}

/**
 * A fake service that answers each request with `route(url, call)` and records it in `calls`.
 * Like a real `fetch`, it rejects with the signal's reason when the request is cancelled, and
 * it throws a `TypeError` for a route that throws one (a network error).
 */
export function fakeService(route: (url: URL, call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    const call: Call = { url, headers: new Headers(init?.headers), init, at: Date.now() }
    calls.push(call)
    return route(url, call)
  }
  return { fetch: fakeFetch, calls }
}

/** A `fetch` that never answers, and rejects like a real one when its signal aborts. */
export const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

/**
 * A provider context around `fetch`: by default a web page without FXM Connect or the Lite tier,
 * in Music mode, which is where the free sources matter most.
 */
export function contextFor(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Omit<ProviderContext, 'fetch'>> = {},
): ProviderContext {
  return {
    fetch,
    platform: 'web',
    capabilities: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
    mode: 'music',
    ...overrides,
  }
}
