/**
 * Test helpers for the SponsorBlock client: the fixture, a fake SponsorBlock behind an injected
 * `fetch`, and tracks.
 *
 * `bucket.json` keeps the shape of an answer recorded on 2026-10-26
 * (`GET /api/skipSegments/6db9?category=music_offtopic`): the fields, their order and their types.
 * Its videoIDs, times, UUIDs and votes are made up, so the repository holds none of SponsorBlock's
 * CC BY-NC-SA 4.0 data.
 *
 * @module
 */

import { formatId, type ProviderContext, type Track } from '@fxm/core'
import bucket from './bucket.json'

/** The fixture: three made-up videos and their segments, in SponsorBlock's format. */
export const fixtures = {
  /** `/api/skipSegments/<prefix>` with segments for `fxmVideoBBB`, `fxmVideoAAA`, `fxmVideoCCC`. */
  bucket,
}

/** The video of the fixture with three segments, out of order: an intro, a skit and an outro. */
export const VIDEO_ID = 'fxmVideoAAA'

/** A JSON response. */
export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  })
}

/** One request the fake SponsorBlock received. */
export interface Call {
  /** The URL. */
  url: URL
  /** The request options. */
  init: RequestInit | undefined
}

/**
 * A fake SponsorBlock that answers each request with `route(url, init)` and records it. Like a
 * real `fetch`, it rejects with the signal's reason when the request is cancelled.
 */
export function fakeSponsorBlock(
  route: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push({ url, init })
    return route(url, init)
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

/** A provider context around `fetch`, for a web page in Music + Video mode. */
export function contextFor(fetch: typeof globalThis.fetch, signal?: AbortSignal): ProviderContext {
  return {
    fetch,
    platform: 'web',
    capabilities: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
    mode: 'all',
    ...(signal === undefined ? {} : { signal }),
  }
}

/** A YouTube video with the videoId `videoId`, four minutes long, with `overrides`. */
export function video(videoId = VIDEO_ID, overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('ytm', 'track', videoId),
    source: 'ytm',
    title: 'Made-up Song (Official Video)',
    artists: [{ name: 'Made-up Artist' }],
    artwork: [],
    kind: 'music-video',
    durationMs: 240_000,
    ...overrides,
  }
}
