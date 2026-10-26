/**
 * One `/player` call for one rung, in the CORS-simple request shape of `../request.ts`, with the
 * device's server-issued visitorData from `../visitor.ts` and the error mapping of
 * `../errors.ts`.
 *
 * The stream calls don't go through youtubei.js's `Innertube` (`session.innertube`): its fetch
 * adapter treats every `LOGIN_REQUIRED` as a bot check and drops the visitorData each time,
 * while the ladder must tell an age gate from a bot check, refresh the visitorData only once per
 * resolution, and send each stream client's own fields. The request itself is built by the same
 * `toSimpleInnerTubeRequest` as every other InnerTube call, with the stream client named
 * explicitly, so that a stream client that shares its name with a metadata client (`WEB_REMIX`,
 * `WEB`) keeps its own version, host and fields.
 *
 * @module
 */

import { FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from '../../shared'
import { httpError, isBotCheckPage, requestFailure } from '../errors'
import { asRecord, at, type JsonRecord } from '../json'
import { describeRequest, type SimpleInnerTubeRequest, toSimpleInnerTubeRequest } from '../request'
import { innerTubeRegion, leaseVisitorData, type YouTubeSession } from '../session'
import type { VisitorLease } from '../visitor'
import type { StreamBudget, StreamRequestPriority } from './budget'
import type { StreamClientConfig } from './config'

/**
 * The language of every stream call. YouTube's reasons are read to tell an age gate from a bot
 * check (see `playability.ts`), and nobody sees them, so they are always asked for in English.
 */
export const STREAM_LANGUAGE = 'en'

/** What a stream call needs besides its context. */
export interface PlayerCallOptions {
  /** The device's YouTube session: its config and visitorData. */
  readonly session: YouTubeSession
  /** The request budget every InnerTube call draws on. */
  readonly budget: StreamBudget
  /** What the call is for. */
  readonly priority: StreamRequestPriority
  /**
   * How long one request may take, in milliseconds: the `/player` call, and the call that asks
   * YouTube for a visitorData first in the Lite tier.
   */
  readonly timeoutMs: number
  /**
   * Fields to add to the `/player` payload, e.g. a `playbackContext` (stage 1.11). They can't
   * replace `context`, which the request shape writes, or `videoId`.
   */
  readonly payload?: JsonRecord
  /**
   * More request headers, such as a client's `User-Agent` where the transport sends it (stage
   * 1.11). The request shape's own headers win.
   */
  readonly headers?: Readonly<Record<string, string>>
}

/** The outcome of one `/player` call. */
export type PlayerAnswer =
  /** YouTube answered with JSON, to be classified by `classifyPlayability`. */
  | { readonly json: JsonRecord; readonly sentVisitorData: boolean }
  /** YouTube answered with a bot check page or status instead of JSON. */
  | { readonly botCheck: string; readonly sentVisitorData: boolean }

/** The payload of a `/player` call for `videoId`, before the request shape adds `context`. */
export function playerPayload(videoId: string, extra: JsonRecord = {}): JsonRecord {
  return {
    ...extra,
    videoId,
    // The answers the official clients send once the user has accepted a content warning.
    contentCheckOk: true,
    racyCheckOk: true,
  }
}

/** What {@link playerRequest} needs besides the client and the video. */
export interface PlayerRequestOptions {
  /** The session's config, for the request shape. */
  readonly session: YouTubeSession
  /** The visitorData to send, if there is one. */
  readonly visitorData?: string
  /** The `gl` to send; none lets YouTube use the IP address's region. */
  readonly gl?: string
  /** Fields to add to the payload (see {@link PlayerCallOptions.payload}). */
  readonly payload?: JsonRecord
}

/**
 * A `/player` request for `videoId` as `client`, in the CORS-simple shape: the client's name,
 * version and host as the stream config has them, its own fields (such as IOS's device
 * fields), `hl=en`, and `gl` and the visitorData when given.
 */
export function playerRequest(
  client: StreamClientConfig,
  videoId: string,
  options: PlayerRequestOptions,
): SimpleInnerTubeRequest {
  const request = toSimpleInnerTubeRequest(
    `https://${client.host}/youtubei/v1/player`,
    JSON.stringify(playerPayload(videoId, options.payload)),
    {
      config: options.session.config,
      client: { name: client.name, version: client.version, host: client.host },
      hl: STREAM_LANGUAGE,
      ...(options.gl === undefined ? {} : { gl: options.gl }),
      ...(options.visitorData === undefined ? {} : { visitorData: options.visitorData }),
    },
  )
  // The request shape writes only the name and version of a client it is given. The stream
  // client's own fields go next to them: the config allows only `STREAM_CLIENT_FIELDS`, so they
  // can't replace the name, version, language, region or visitorData.
  const context = asRecord(request.body.context) ?? {}
  const { clientName, clientVersion, ...rest } = asRecord(context.client) ?? {}
  const body: JsonRecord = {
    ...request.body,
    context: { ...context, client: { clientName, clientVersion, ...client.fields, ...rest } },
  }
  return { ...request, body, init: { ...request.init, body: JSON.stringify(body) } }
}

/**
 * Sends one InnerTube request and reads its JSON, mapping failures to `FxmError`s. An HTTP 429
 * is reported to the budget as a bot check before it is thrown as `RateLimited`.
 */
async function send(
  ctx: ProviderContext,
  request: SimpleInnerTubeRequest,
  options: PlayerCallOptions,
  headers: Readonly<Record<string, string>> = {},
): Promise<JsonRecord> {
  const what = describeRequest(request)
  let response: Response
  let text: string
  try {
    response = await fetchWithTimeout(ctx.fetch, request.url, {
      ...request.init,
      headers: { ...headers, ...request.init.headers },
      timeoutMs: options.timeoutMs,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    text = await response.text()
  } catch (error) {
    throw requestFailure(error, what, ctx.signal)
  }
  if (!response.ok) {
    if (response.status === 429) options.budget.reportBotCheck('rate-limited')
    // A 400 here means YouTube refused the request's shape (an outdated client in the config):
    // the videoId was checked before, so it is a `Parse` failure of the rung, not `NotFound`.
    throw httpError(response.status, response.headers.get('retry-after'), text, {
      what,
      entity: false,
    })
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    if (isBotCheckPage(text)) {
      throw new FxmError('BotCheck', `YouTube answered ${what} with a bot check page`)
    }
    throw new FxmError('Parse', `YouTube answered ${what} with something other than JSON`, {
      cause: error,
    })
  }
  const record = asRecord(json)
  if (record === undefined) throw new FxmError('Parse', `YouTube answered ${what} with no object`)
  return record
}

/** The `gl` of a call: the user's region, or none to let YouTube use the IP address's. */
function regionOf(ctx: ProviderContext): { gl?: string } {
  const gl = innerTubeRegion(ctx.region)
  return gl === undefined ? {} : { gl }
}

/** Takes a slot from the budget for the next InnerTube call. */
function acquire(ctx: ProviderContext, options: PlayerCallOptions): Promise<void> {
  return options.budget.acquire(options.priority, ctx.signal ? { signal: ctx.signal } : {})
}

/**
 * Spends a lease without a visitorData, the one that asks YouTube for one, on the lightest
 * call that gets one issued: empty search suggestions. VISIONOS answers a `/player` call
 * without a visitorData with a bot check (measured 2026-10-26), so in the Lite tier, where
 * `sw.js_data` can't be read, the first stream call of a session needs this. The caller has
 * taken the budget's slot for it already. A bot check here is reported to the budget and
 * thrown: no rung would fare better.
 */
async function primeVisitorData(
  ctx: ProviderContext,
  lease: VisitorLease,
  options: PlayerCallOptions,
): Promise<void> {
  let issued: unknown
  try {
    const { config } = options.session
    const music = config.clients.music
    const request = toSimpleInnerTubeRequest(
      `https://${music.host}/youtubei/v1/music/get_search_suggestions`,
      JSON.stringify({ input: '' }),
      { config, client: music, hl: STREAM_LANGUAGE, ...regionOf(ctx) },
    )
    issued = at(await send(ctx, request, options), 'responseContext', 'visitorData')
  } catch (error) {
    if (isFxmError(error, 'BotCheck')) options.budget.reportBotCheck('login-required')
    throw error
  } finally {
    lease.end(issued)
  }
}

/**
 * Calls `/player` for `videoId` as `client`, with the device's server-issued visitorData,
 * after drawing a slot from the budget. A session without a visitorData gets one first (see
 * {@link primeVisitorData}); in the `full` tier the session reads it from `sw.js_data`.
 *
 * Every slot is taken before the visitorData lease: a lease without a visitorData holds back
 * every other InnerTube call of the device until its answer arrives, so waiting for the budget
 * while holding one (a `bulk` call during a bot-check pause, say) would hold back the track
 * that is about to play.
 *
 * @throws FxmError for a failed request (see `../errors.ts`), except a bot check, which is
 * returned so the ladder can refresh the visitorData and go on.
 */
export async function callPlayer(
  ctx: ProviderContext,
  client: StreamClientConfig,
  videoId: string,
  options: PlayerCallOptions,
): Promise<PlayerAnswer> {
  const { session } = options
  await acquire(ctx, options)
  let lease = await leaseVisitorData(session, ctx)
  if (lease.visitorData === undefined) {
    // The slot just taken goes to the call that asks for a visitorData; `/player` takes another.
    await primeVisitorData(ctx, lease, options)
    await acquire(ctx, options)
    lease = await leaseVisitorData(session, ctx)
  }
  const sentVisitorData = lease.visitorData !== undefined
  let issued: unknown
  try {
    const request = playerRequest(client, videoId, {
      session,
      ...regionOf(ctx),
      ...(lease.visitorData === undefined ? {} : { visitorData: lease.visitorData }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    })
    const json = await send(ctx, request, options, options.headers)
    issued = at(json, 'responseContext', 'visitorData')
    return { json, sentVisitorData }
  } catch (error) {
    if (isFxmError(error, 'BotCheck')) return { botCheck: error.message, sentVisitorData }
    throw error
  } finally {
    lease.end(issued)
  }
}
