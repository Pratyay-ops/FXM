/**
 * A fake network for tests: an injected `fetch` that answers each request from a route and
 * records it, and helpers to build responses.
 *
 * @module
 */

/** One request the fake network received. */
export interface FetchCall {
  /** The URL. */
  url: URL
  /** The request options. */
  init: RequestInit | undefined
  /** When it arrived, by `Date.now()`. */
  at: number
}

/**
 * A `fetch` that answers each request with `route(url, init)` and records it in `calls`. Like a
 * real `fetch`, it rejects with the signal's reason when the request is cancelled, also while a
 * route's answer is pending.
 */
export function fakeFetch(
  route: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchFake: typeof fetch = async (input, init) => {
    const signal = init?.signal
    signal?.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push({ url, init, at: Date.now() })
    const answer = Promise.resolve(route(url, init))
    if (signal === undefined || signal === null) return answer
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }
  return { fetch: fetchFake, calls }
}

/** A JSON response. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** A text response, `text/html` unless `contentType` says otherwise. */
export function textResponse(
  text: string,
  init: { status?: number; contentType?: string; headers?: Record<string, string> } = {},
): Response {
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'text/html; charset=utf-8', ...init.headers },
  })
}

/** The query parameters of a request, as a plain object. */
export function paramsOf(call: FetchCall | undefined): Record<string, string> {
  return Object.fromEntries(call?.url.searchParams ?? [])
}

/** What a browser page would learn about one response's CORS. */
export interface CorsRecord {
  /** The URL requested. */
  url: string
  /** The final URL, after redirects. */
  finalUrl: string
  /** The HTTP status. */
  status: number
  /** The `Access-Control-Allow-Origin` header, or `null`. */
  allowOrigin: string | null
}

/**
 * For live tests: wraps a real `fetch` so that each request carries the web app's `Origin`, as a
 * browser page's would, and records what each response says about CORS.
 */
export function withOrigin(
  realFetch: typeof fetch,
  origin = 'https://fxmusic.pages.dev',
): { fetch: typeof fetch; records: CorsRecord[] } {
  const records: CorsRecord[] = []
  const wrapped: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('origin', origin)
    const url = input instanceof Request ? input.url : String(input)
    const response = await realFetch(url, { ...init, headers })
    records.push({
      url,
      finalUrl: response.url,
      status: response.status,
      allowOrigin: response.headers.get('access-control-allow-origin'),
    })
    return response
  }
  return { fetch: wrapped, records }
}

/** Whether live tests should run: only with `FXM_LIVE=1`. */
export function liveTestsEnabled(): boolean {
  // Read without Node's types: this package type-checks as a web worker.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env?.FXM_LIVE === '1'
}

/** An environment variable, for live tests, without Node's types. */
export function liveEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  const value = env?.[name]?.trim()
  return value === '' ? undefined : value
}
