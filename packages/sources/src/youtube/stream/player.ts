/**
 * One `/player` call for one rung, in the CORS-simple request shape of `../request.ts`, with the
 * device's server-issued visitorData from `../visitor.ts` and the error mapping of
 * `../errors.ts`.
 *
 * The stream calls don't go through youtubei.js's `Innertube` (`session.innertube`): its fetch
 * adapter treats every `LOGIN_REQUIRED` as a bot check and drops the visitorData each time,
 * while the ladder must tell an age gate from a bot check, refresh the visitorData only once per
 * resolution, and send each stream client's own fields. The request itself is built by the same
 * `toSimpleInnerTubeRequest` as every other InnerTube call.
 *
 * @module
 */

import { FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from '../../shared'
import { httpError, isBotCheckPage, requestFailure } from '../errors'
import { asRecord, at, type JsonRecord } from '../json'
import { describeRequest, type SimpleInnerTubeRequest, toSimpleInnerTubeRequest } from '../request'
import { innerTubeRegion, type YouTubeSession } from '../session'
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
  /** How long one request may take, in milliseconds. */
  readonly timeoutMs: number
}

/** The outcome of one `/player` call. */
export type PlayerAnswer =
  /** YouTube answered with JSON, to be classified by `classifyPlayability`. */
  | { readonly json: JsonRecord; readonly sentVisitorData: boolean }
  /** YouTube answered with a bot check page or status instead of JSON. */
  | { readonly botCheck: string; readonly sentVisitorData: boolean }

/** The body of a `/player` call for `videoId` as `client`. */
export function playerPayload(client: StreamClientConfig, videoId: string): JsonRecord {
  return {
    context: {
      client: { clientName: client.name, clientVersion: client.version, ...client.fields },
    },
    videoId,
    // The answers the official clients send once the user has accepted a content warning.
    contentCheckOk: true,
    racyCheckOk: true,
  }
}

/**
 * Sends one InnerTube request and reads its JSON, mapping failures to `FxmError`s. An HTTP 429
 * is reported to the budget as a bot check before it is thrown as `RateLimited`.
 */
async function send(
  ctx: ProviderContext,
  request: SimpleInnerTubeRequest,
  options: PlayerCallOptions,
): Promise<JsonRecord> {
  const what = describeRequest(request)
  let response: Response
  let text: string
  try {
    response = await fetchWithTimeout(ctx.fetch, request.url, {
      ...request.init,
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

/**
 * Spends a lease without a visitorData, the one that asks YouTube for one, on the lightest
 * call that gets one issued: empty search suggestions. VISIONOS answers a `/player` call
 * without a visitorData with a bot check (measured 2026-10-26), so in the Lite tier, where
 * `sw.js_data` can't be read, the first stream call of a session needs this. A bot check here
 * is reported to the budget and thrown: no rung would fare better.
 */
async function primeVisitorData(
  ctx: ProviderContext,
  lease: VisitorLease,
  options: PlayerCallOptions,
): Promise<void> {
  let issued: unknown
  try {
    await options.budget.acquire(options.priority, ctx.signal ? { signal: ctx.signal } : {})
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
  let lease = await session.visitorData.lease(ctx)
  if (lease.visitorData === undefined) {
    await primeVisitorData(ctx, lease, options)
    lease = await session.visitorData.lease(ctx)
  }
  const sentVisitorData = lease.visitorData !== undefined
  let issued: unknown
  try {
    await options.budget.acquire(options.priority, ctx.signal ? { signal: ctx.signal } : {})
    const request = toSimpleInnerTubeRequest(
      `https://${client.host}/youtubei/v1/player`,
      JSON.stringify(playerPayload(client, videoId)),
      {
        // A stream client is not one of the config's metadata clients, so the request keeps
        // the client fields of the payload and goes to the stream client's host.
        config: { ...session.config, defaultHost: client.host },
        hl: STREAM_LANGUAGE,
        ...regionOf(ctx),
        ...(lease.visitorData === undefined ? {} : { visitorData: lease.visitorData }),
      },
    )
    const json = await send(ctx, request, options)
    issued = at(json, 'responseContext', 'visitorData')
    return { json, sentVisitorData }
  } catch (error) {
    if (isFxmError(error, 'BotCheck')) return { botCheck: error.message, sentVisitorData }
    throw error
  } finally {
    lease.end(issued)
  }
}
