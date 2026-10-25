/**
 * Test helpers for the LRCLIB provider: the recorded fixtures, a fake LRCLIB behind an injected
 * `fetch`, and tracks. The fixtures are real LRCLIB responses recorded on 2026-10-25 and
 * sanitized: catalog fields (IDs, titles, artists, albums, durations) are kept, every lyric is
 * replaced with placeholder lines, and one uploader's handle with a generic name.
 *
 * @module
 */

import { formatId, type ProviderContext, type Track } from '@fxm/core'
import notFound from './error-not-found.json'
import overloaded from './error-overloaded.json'
import rateLimited from './error-rate-limited.json'
import getCreep from './get-creep.json'
import searchHansZimmerTime from './search-hans-zimmer-time.json'
import searchRadioheadCreep from './search-radiohead-creep.json'

/** The recorded responses. */
export const fixtures = {
  /** `GET /api/get` for Radiohead, Creep, Pablo Honey, 239 s: record 496, synced. */
  getCreep,
  /** `GET /api/search?q=Radiohead Creep`: 20 messy records. */
  searchRadioheadCreep,
  /** `GET /api/search?q=Hans Zimmer Time`: instrumental records. */
  searchHansZimmerTime,
  /** The documented 404 body. */
  notFound,
  /** The 503 body LRCLIB sent for every miss on 2026-10-25. */
  overloaded,
  /** The documented 429 body. */
  rateLimited,
}

/** A JSON response. */
export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** LRCLIB's 503 for a miss, with `Retry-After: 1`. */
export function busy(): Response {
  return json(overloaded, { status: 503, headers: { 'retry-after': '1' } })
}

/** One request the fake LRCLIB received. */
export interface Call {
  /** The URL. */
  url: URL
  /** The request headers. */
  headers: Headers
  /** The request options. */
  init: RequestInit | undefined
  /** When it arrived, by `Date.now()`. */
  at: number
}

/**
 * A fake LRCLIB that answers each request with `route(url)` and records it. Like a real
 * `fetch`, it rejects with the signal's reason when the request is cancelled.
 */
export function fakeLrclib(route: (url: URL) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push({ url, headers: new Headers(init?.headers), init, at: Date.now() })
    return route(url)
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

/** A provider context around `fetch`, for a web page without FXM Connect. */
export function contextFor(fetch: typeof globalThis.fetch, signal?: AbortSignal): ProviderContext {
  return {
    fetch,
    platform: 'web',
    capabilities: { youtube: false, spotify: false, mediaBytes: false, fileSystem: false },
    mode: 'music',
    ...(signal === undefined ? {} : { signal }),
  }
}

/** Radiohead's "Creep" as Spotify describes it, with `overrides`. */
export function creep(overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('spotify', 'track', '70LcF31zb1H0PyJoS1Sx1r'),
    source: 'spotify',
    title: 'Creep',
    artists: [{ name: 'Radiohead' }],
    album: { name: 'Pablo Honey' },
    durationMs: 238_640,
    artwork: [],
    kind: 'song',
    ...overrides,
  }
}
