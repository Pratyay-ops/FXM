/**
 * The CORS-simple shape of every InnerTube request, and the `fetch` adapter that youtubei.js
 * sends its requests through.
 *
 * A browser page can call InnerTube without a CORS preflight only with a "simple" request, and
 * the Lite tier's sandboxed document can only make those (preflights from an opaque origin get
 * 403). FXM therefore sends one shape on every platform and tier, so the same code and fixtures
 * serve them all:
 *
 * - `POST https://<host>/youtubei/v1/<endpoint>?prettyPrint=false`;
 * - the JSON body as a string, labelled `Content-Type: text/plain;charset=UTF-8`, which InnerTube
 *   parses as JSON; no other header, so no `X-Goog-*`, `X-YouTube-*`, `Authorization` or
 *   `Content-Type: application/json`;
 * - the client name, version, `hl`, `gl` and visitorData inside `context.client`, where InnerTube
 *   reads them when the `X-YouTube-Client-*` and `X-Goog-Visitor-Id` headers are absent;
 * - `credentials: 'omit'`.
 *
 * youtubei.js builds richer requests (headers, a desktop browser's context, cookies), so the
 * adapter takes only the endpoint and the payload from them and writes the rest itself. Stage
 * 1.2 adds a generic `toSimpleInnerTubeRequest()` to `@fxm/platform`; this module can then use
 * it.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from '../shared'
import type { InnerTubeHost, YouTubeClientConfig, YouTubeConfig } from './config'
import { botCheckIn, httpError, isBotCheckPage, requestFailure } from './errors'
import { asRecord, asString, at, type JsonRecord } from './json'
import type { VisitorData } from './visitor'

/**
 * The InnerTube endpoints FXM calls: the Lite sandbox's allowlist. Anything else youtubei.js
 * might try (`/config`, `/att/get`, `/visitor_id`, …) is refused.
 */
export const INNERTUBE_ENDPOINTS = [
  'browse',
  'search',
  'next',
  'player',
  'music/get_search_suggestions',
] as const

/** One of the {@link INNERTUBE_ENDPOINTS}. */
export type InnerTubeEndpoint = (typeof INNERTUBE_ENDPOINTS)[number]

/** The only header a request carries: a CORS-safelisted content type. */
export const SIMPLE_CONTENT_TYPE = 'text/plain;charset=UTF-8'

/** The language and region a request asks for. */
export interface Locale {
  /** `context.client.hl`, e.g. `en` or `pt-BR`. */
  hl: string
  /** `context.client.gl`, e.g. `IN`. Absent to let YouTube use the IP address's region. */
  gl?: string
}

/** Options for {@link toSimpleInnerTubeRequest}. */
export interface SimpleRequestOptions extends Locale {
  /** Where hosts and client versions come from. */
  config: YouTubeConfig
  /**
   * The client the request is for, which sets its name, version and host. Absent for a client
   * the config does not list (such as the stream clients of stage 1.4): the request then keeps
   * the client fields youtubei.js wrote, unless the config lists a client of the same name.
   */
  client?: YouTubeClientConfig
  /** The server-issued visitorData, if there is one yet. */
  visitorData?: string
}

/** An InnerTube request in the CORS-simple shape, ready for `fetch(url, init)`. */
export interface SimpleInnerTubeRequest {
  /** E.g. `https://music.youtube.com/youtubei/v1/search?prettyPrint=false`. */
  url: string
  /** The endpoint, e.g. `search`. */
  endpoint: InnerTubeEndpoint
  /** The host the request goes to. */
  host: InnerTubeHost
  /** The `fetch` options: a `text/plain` POST without credentials. */
  init: {
    method: 'POST'
    headers: { 'Content-Type': typeof SIMPLE_CONTENT_TYPE }
    body: string
    credentials: 'omit'
  }
  /** The body, parsed: the payload plus `context`. */
  body: JsonRecord
}

/** youtubei.js's context fields that FXM never sends for a client of its own config. */
const DROPPED_CLIENT_FIELDS = new Set([
  'hl',
  'gl',
  'visitorData',
  'remoteHost',
  'timeZone',
  'utcOffsetMinutes',
  'memoryTotalKbytes',
  'screenDensityFloat',
  'screenHeightPoints',
  'screenPixelDensity',
  'screenWidthPoints',
  'mainAppWebInfo',
  'configInfo',
  'rolloutToken',
  'deviceExperimentId',
  'originalUrl',
  'browserName',
  'browserVersion',
  'clientFormFactor',
  'userInterfaceTheme',
])

function isEndpoint(value: string): value is InnerTubeEndpoint {
  return (INNERTUBE_ENDPOINTS as readonly string[]).includes(value)
}

function clientNamed(config: YouTubeConfig, name: unknown): YouTubeClientConfig | undefined {
  return Object.values(config.clients).find((client) => client.name === name)
}

/**
 * Turns a request youtubei.js built (its URL and JSON body) into the CORS-simple shape: the
 * endpoint and payload stay, while the host, the query, the headers and `context` are FXM's.
 *
 * @throws FxmError `Unsupported` for an endpoint outside {@link INNERTUBE_ENDPOINTS}, and `Parse`
 * for a body that is not a JSON object.
 */
export function toSimpleInnerTubeRequest(
  url: string,
  body: string,
  options: SimpleRequestOptions,
): SimpleInnerTubeRequest {
  const path = URL.canParse(url) ? new URL(url).pathname : url
  const endpoint = path.replace(/^\/youtubei\/v1\//u, '')
  if (!isEndpoint(endpoint)) {
    throw new FxmError('Unsupported', `FXM does not call the InnerTube endpoint ${path}`)
  }
  let parsed: JsonRecord | undefined
  try {
    parsed = asRecord(JSON.parse(body))
  } catch {
    parsed = undefined
  }
  if (parsed === undefined) throw new FxmError('Parse', `The ${endpoint} request is not JSON`)
  const { context, client: _client, ...payload } = parsed
  const wrote = asRecord(at(context, 'client')) ?? {}
  const configured = options.client ?? clientNamed(options.config, wrote.clientName)
  const host = configured?.host ?? options.config.defaultHost
  const client: Record<string, unknown> = configured
    ? { clientName: configured.name, clientVersion: configured.version }
    : Object.fromEntries(Object.entries(wrote).filter(([key]) => !DROPPED_CLIENT_FIELDS.has(key)))
  client.hl = options.hl
  if (options.gl !== undefined) client.gl = options.gl
  if (options.visitorData !== undefined) client.visitorData = options.visitorData
  const thirdParty = configured ? undefined : asRecord(at(context, 'thirdParty'))
  const shaped: JsonRecord = {
    context: {
      client,
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
      ...(thirdParty ? { thirdParty } : {}),
    },
    ...payload,
  }
  return {
    url: `https://${host}/youtubei/v1/${endpoint}?prettyPrint=false`,
    endpoint,
    host,
    init: {
      method: 'POST',
      headers: { 'Content-Type': SIMPLE_CONTENT_TYPE },
      body: JSON.stringify(shaped),
      credentials: 'omit',
    },
    body: shaped,
  }
}

/** What the adapter needs besides the call's context. */
export interface InnerTubeFetchOptions extends Locale {
  /** The config in use. */
  config: YouTubeConfig
  /** The client the call is for; see {@link SimpleRequestOptions.client}. */
  client?: YouTubeClientConfig
  /** The device's visitorData. */
  visitorData: VisitorData
  /** How long one request may take. */
  timeoutMs: number
}

/** A short description of a request, for error messages: the endpoint and what it names. */
export function describeRequest(request: SimpleInnerTubeRequest): string {
  const { body } = request
  const subject =
    asString(body.browseId) ??
    asString(body.videoId) ??
    asString(body.playlistId) ??
    (asString(body.query) === undefined ? undefined : `"${asString(body.query)}"`) ??
    (asString(body.continuation) === undefined ? undefined : 'continuation')
  return subject === undefined ? request.endpoint : `${request.endpoint} ${subject}`
}

function namesEntity(body: JsonRecord): boolean {
  return ['browseId', 'videoId', 'playlistId'].some((key) => typeof body[key] === 'string')
}

/**
 * The `fetch` that youtubei.js gets for one call: it reshapes each request with
 * {@link toSimpleInnerTubeRequest}, sends it through `ctx.fetch` with the call's signal and a
 * timeout, and turns failures into `FxmError`s before youtubei.js sees them. It also hands the
 * visitorData that YouTube issues to the device's {@link VisitorData}, and drops it after a bot
 * check.
 */
export function createInnerTubeFetch(
  ctx: ProviderContext,
  options: InnerTubeFetchOptions,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? init.body : ''
    const lease = await options.visitorData.lease(ctx)
    let issued: unknown
    try {
      const request = toSimpleInnerTubeRequest(url, body, {
        config: options.config,
        hl: options.hl,
        ...(options.gl === undefined ? {} : { gl: options.gl }),
        ...(options.client === undefined ? {} : { client: options.client }),
        ...(lease.visitorData === undefined ? {} : { visitorData: lease.visitorData }),
      })
      const what = describeRequest(request)
      let text: string
      let response: Response
      try {
        response = await fetchWithTimeout(ctx.fetch, request.url, {
          ...request.init,
          timeoutMs: options.timeoutMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        text = await response.text()
      } catch (error) {
        throw requestFailure(error, what, ctx.signal)
      }
      if (!response.ok) {
        const failure = httpError(response.status, response.headers.get('retry-after'), text, {
          what,
          entity: namesEntity(request.body),
        })
        if (failure.code === 'BotCheck') options.visitorData.invalidate()
        throw failure
      }
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch (error) {
        if (isBotCheckPage(text)) {
          options.visitorData.invalidate()
          throw new FxmError('BotCheck', `YouTube answered ${what} with a bot check page`)
        }
        throw new FxmError('Parse', `YouTube answered ${what} with something other than JSON`, {
          cause: error,
        })
      }
      const botCheck = botCheckIn(json)
      if (botCheck !== undefined) {
        options.visitorData.invalidate()
        throw new FxmError('BotCheck', `YouTube answered ${what} with a bot check: ${botCheck}`)
      }
      issued = at(json, 'responseContext', 'visitorData')
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } finally {
      lease.end(issued)
    }
  }
}
