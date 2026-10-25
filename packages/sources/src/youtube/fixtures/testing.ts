/**
 * Test helpers for the YouTube providers: contexts for each tier and mode, a fake InnerTube
 * behind an injected `fetch` that records every request, and a check that a request is
 * CORS-simple.
 *
 * The fixtures next to this file are real InnerTube responses recorded on 2026-10-25 UTC by
 * `record.live.test.ts` and sanitized by `sanitize.ts`.
 *
 * @module
 */

import type { CatalogMode, NetworkCapabilities, ProviderContext } from '@fxm/core'
import { FAKE_VISITOR_DATA } from './sanitize'

/** FXM Connect, the desktop app or the Android app: everything, including media bytes. */
export const FULL: NetworkCapabilities = {
  youtube: 'full',
  spotify: 'anonymous',
  mediaBytes: true,
  fileSystem: false,
}

/** The web app's Lite tier: InnerTube through a sandboxed document, no media bytes. */
export const SIMPLE: NetworkCapabilities = {
  youtube: 'simple',
  spotify: 'unreachable',
  mediaBytes: false,
  fileSystem: false,
}

/** A plain web page: no YouTube at all. */
export const NONE: NetworkCapabilities = { ...SIMPLE, youtube: 'none' }

/** A provider context. */
export function context(
  fetch: typeof globalThis.fetch,
  options: {
    mode?: CatalogMode
    capabilities?: NetworkCapabilities
    locale?: string
    region?: string
    signal?: AbortSignal
  } = {},
): ProviderContext {
  return {
    fetch,
    platform: 'web',
    capabilities: options.capabilities ?? FULL,
    mode: options.mode ?? 'all',
    locale: options.locale ?? 'en',
    region: options.region ?? 'IN',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

/** One request the fake InnerTube received. */
export interface Recorded {
  /** The full URL. */
  readonly url: URL
  /** `GET` or `POST`. */
  readonly method: string
  /** The headers, as sent. */
  readonly headers: Headers
  /** The body as sent, if any. */
  readonly rawBody: string | undefined
  /** The body parsed as JSON, or `{}`. */
  readonly body: Record<string, unknown>
  /** The `credentials` option. */
  readonly credentials: RequestCredentials | undefined
}

/** How the fake InnerTube answers a request: a response, or `undefined` to try the next route. */
export type Route = (request: Recorded) => Response | undefined

/** A JSON response. */
export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers },
  })
}

/** The InnerTube endpoint of a request, e.g. `browse`. */
export function endpointOf(request: Recorded): string {
  return request.url.pathname.replace(/^\/youtubei\/v1\//u, '')
}

/** A route that answers `endpoint` requests whose body has all of `fields` with `body`. */
export function on(
  endpoint: string,
  fields: Record<string, unknown>,
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Route {
  return (request) =>
    endpointOf(request) === endpoint &&
    Object.entries(fields).every(([key, value]) => request.body[key] === value)
      ? json(body, init)
      : undefined
}

/** A route that answers `GET sw.js_data` with a JSPB body carrying `visitorData`. */
export function onSwJsData(visitorData = FAKE_VISITOR_DATA, status = 200): Route {
  return (request) =>
    request.url.pathname === '/sw.js_data'
      ? new Response(swJsData(visitorData), { status })
      : undefined
}

/**
 * A `sw.js_data` body in the shape YouTube sends: the `)]}'` guard, then a JSPB array with the
 * device info at `[0][2][0][0]`, whose index 13 is the visitorData. The other entries are
 * placeholders: hl, gl, a documentation IP address and the WEB client version.
 */
export function swJsData(visitorData: string): string {
  const device: unknown[] = Array.from({ length: 20 }, () => null)
  device[0] = 'en'
  device[1] = 'IN'
  device[3] = '192.0.2.1'
  device[13] = visitorData
  device[16] = '2.20261023.01.00'
  return `)]}'\n${JSON.stringify([['yt.sw.adr', null, [[device], 'public-api-key']]])}`
}

/**
 * A fake InnerTube: answers each request with the first matching route, records it, and fails
 * the test for a request no route answers. Like a real `fetch`, it rejects with the signal's
 * reason when the request is cancelled.
 */
export function fakeInnerTube(...routes: Route[]): {
  fetch: typeof globalThis.fetch
  requests: Recorded[]
} {
  const requests: Recorded[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    init?.signal?.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    let body: Record<string, unknown> = {}
    try {
      body = rawBody === undefined ? {} : (JSON.parse(rawBody) as Record<string, unknown>)
    } catch {
      body = {}
    }
    const request: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      rawBody,
      body,
      credentials: init?.credentials,
    }
    requests.push(request)
    for (const route of routes) {
      const response = route(request)
      if (response !== undefined) return response
    }
    throw new Error(`No fixture for ${request.method} ${url.href} ${rawBody ?? ''}`)
  }
  return { fetch, requests }
}

/** The headers a CORS-simple request may carry, besides the browser's own. */
const SAFELISTED = new Set(['accept', 'accept-language', 'content-language', 'content-type'])

/** The content types a CORS-simple request may carry. */
const SIMPLE_TYPES = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']

/**
 * Why a request would need a CORS preflight, or `undefined` when it is CORS-simple: `GET`,
 * `HEAD` or `POST`, only safelisted headers, and a simple content type.
 */
export function preflightReason(request: Recorded): string | undefined {
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return `method ${request.method}`
  for (const [name, value] of request.headers) {
    if (!SAFELISTED.has(name)) return `header ${name}`
    if (name === 'content-type' && !SIMPLE_TYPES.some((type) => value.startsWith(type))) {
      return `content type ${value}`
    }
  }
  return undefined
}
