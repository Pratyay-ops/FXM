/**
 * The YouTube session one device shares between its providers: the config, the visitorData and
 * the way calls reach InnerTube, which is youtubei.js with the CORS-simple `fetch` adapter of
 * `request.ts`.
 *
 * Each call gets its own lightweight youtubei.js `Innertube`, bound to that call's
 * `ProviderContext` (its `fetch`, signal, language and region). Creating one makes no request:
 * the session data is built locally and replaced in every request by the adapter. For the
 * clients of the config, which every provider call uses, the request carries only FXM's client
 * fields, so youtubei.js's locally made parts (a random user agent, a desktop browser's context)
 * never leave the device, and neither does any visitorData that YouTube did not issue.
 *
 * youtubei.js is loaded on the first call that needs it, so it stays out of an app's first
 * bundle: a bundler puts it in a chunk of its own.
 *
 * @module
 */

import { FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import type { Innertube } from 'youtubei.js'
import { BUNDLED_YOUTUBE_CONFIG, type YouTubeClientConfig, type YouTubeConfig } from './config'
import { asRecord, type JsonRecord } from './json'
import { createInnerTubeFetch, type InnerTubeEndpoint, type Locale } from './request'
import {
  VisitorData,
  type VisitorDataStore,
  type VisitorLease,
  type YouTubeVisitorData,
} from './visitor'

/** Options for {@link createYouTubeSession}. */
export interface YouTubeSessionOptions {
  /** The config to use; the bundled `youtube-config.json` by default. */
  config?: YouTubeConfig
  /** Where to persist the visitorData; in memory only by default. */
  visitorDataStore?: VisitorDataStore
  /** How long one request may take, in milliseconds; 20 s by default. */
  timeoutMs?: number
}

/**
 * Options for every provider factory (`createYouTubeProviders`, `createYouTubeMusicProvider` and
 * `createYouTubeVideoProvider`): either the device's session, to share one visitorData between
 * providers, or the options to create a session with. Not both, since a session's options are
 * fixed when it is created.
 */
export type YouTubeProviderOptions =
  | { readonly session: YouTubeSession }
  | (YouTubeSessionOptions & { readonly session?: undefined })

/** The clients a call can use: YouTube Music (`WEB_REMIX`), or plain YouTube's web client (`WEB`). */
export type YouTubeClientId = 'music' | 'web'

/** youtubei.js's names for the clients, which pick the payload extras it adds. */
const YOUTUBEI_CLIENT: Readonly<Record<YouTubeClientId, string>> = {
  music: 'YTMUSIC',
  web: 'WEB',
}

/**
 * A placeholder for youtubei.js's own visitorData, which the adapter never sends: passing one
 * keeps youtubei.js from generating a session locally.
 */
const UNUSED_VISITOR_DATA = 'fxm-replaced-by-the-adapter'

/** A device's YouTube session. Create one with {@link createYouTubeSession}. */
export interface YouTubeSession {
  /** The config in use. */
  readonly config: YouTubeConfig
  /** The device's visitorData: the one in use, and a way to drop it. */
  readonly visitorData: YouTubeVisitorData
  /**
   * Calls an InnerTube endpoint as `client` and returns the JSON response.
   *
   * @throws FxmError `Unsupported` when `ctx.capabilities.youtube` is `none`, before any request;
   * otherwise any `FxmError` the request ended in (see `errors.ts`).
   */
  call(
    ctx: ProviderContext,
    client: YouTubeClientId,
    endpoint: InnerTubeEndpoint,
    payload: JsonRecord,
  ): Promise<JsonRecord>
  /**
   * A youtubei.js `Innertube` whose requests take the CORS-simple shape and go through
   * `ctx.fetch`, for code that needs more of youtubei.js. Bound to `ctx`: create one per call.
   *
   * `client` sets the name, version and host of every request, and then `context.client` holds
   * only those fields, `hl`, `gl` and the visitorData. Without `client`, a request keeps the
   * client fields youtubei.js writes for the client it asks for (with `YTMUSIC` or `WEB`, the
   * config's version and host), minus its session fields: for any other client that means
   * youtubei.js's random user agent and operating system fields go out with the request.
   *
   * A bot check rejects with `BotCheck` and drops the visitorData; an age gate or a private
   * video (`LOGIN_REQUIRED` with its reason) comes back as YouTube's answer, for the caller to
   * read.
   */
  innertube(ctx: ProviderContext, client?: YouTubeClientConfig): Promise<Innertube>
}

/** The visitorData behind each session that {@link createYouTubeSession} made. */
const VISITOR_DATA = new WeakMap<YouTubeSession, VisitorData>()

/**
 * A lease on the session's visitorData, for code of this module that sends InnerTube requests
 * itself rather than through `call` or `innertube`, such as the stream resolver. End every lease
 * in a `finally` (see `VisitorLease`). After a bot check, call `session.visitorData.invalidate()`
 * once, so the next lease asks YouTube for a fresh one.
 *
 * @throws FxmError `Unsupported` for a session that `createYouTubeSession` did not make.
 */
export async function leaseVisitorData(
  session: YouTubeSession,
  ctx: ProviderContext,
): Promise<VisitorLease> {
  const visitorData = VISITOR_DATA.get(session)
  if (visitorData === undefined) {
    throw new FxmError('Unsupported', 'This YouTube session was not made by createYouTubeSession')
  }
  return visitorData.lease(ctx)
}

/**
 * Fails fast where YouTube cannot be reached at all: a plain web page without FXM Connect and
 * without the Lite tier.
 *
 * @throws FxmError `Unsupported` when `ctx.capabilities.youtube` is `none`.
 */
export function assertYouTubeReachable(ctx: ProviderContext): void {
  if (ctx.capabilities.youtube === 'none') {
    throw new FxmError(
      'Unsupported',
      'YouTube is not reachable here: it needs FXM Connect, the desktop app or the Android app',
    )
  }
}

/** The BCP 47 subtags InnerTube's `hl` takes: a language, plus a region where it has one. */
const LOCALE = /^([a-z]{2,3})(?:[-_]([a-z]{4}))?(?:[-_]([a-z]{2}|\d{3}))?(?:[-_].*)?$/iu

/**
 * InnerTube's `hl` for a BCP 47 locale: `en-in` → `en-IN`, `zh-Hant` → `zh-TW`, `zh-Hans` →
 * `zh-CN`, `sr-Latn` → `sr-Latn`. `en` when the locale is absent or unreadable.
 */
export function innerTubeLanguage(locale: string | undefined): string {
  const match = locale === undefined ? null : LOCALE.exec(locale.trim())
  if (match === null) return 'en'
  const language = (match[1] as string).toLowerCase()
  const script = match[2]?.toLowerCase()
  const region = match[3]?.toUpperCase()
  if (language === 'zh' && region === undefined && script !== undefined) {
    return script === 'hant' ? 'zh-TW' : 'zh-CN'
  }
  if (language === 'sr' && script === 'latn') return 'sr-Latn'
  return region === undefined || /^\d+$/u.test(region) ? language : `${language}-${region}`
}

/**
 * InnerTube's `gl` for an ISO 3166-1 alpha-2 region, in upper case, or `undefined` when it is
 * absent or malformed, which lets YouTube use the region of the IP address that streams play
 * from.
 */
export function innerTubeRegion(region: string | undefined): string | undefined {
  const value = region?.trim().toUpperCase()
  return value !== undefined && /^[A-Z]{2}$/u.test(value) ? value : undefined
}

/** The `hl` and `gl` of a call. */
export function localeOf(ctx: ProviderContext): Locale {
  const gl = innerTubeRegion(ctx.region)
  return { hl: innerTubeLanguage(ctx.locale), ...(gl === undefined ? {} : { gl }) }
}

/** youtubei.js, once a call has loaded it. */
let youtubei: Promise<{ readonly Innertube: typeof Innertube }> | undefined

/**
 * Loads youtubei.js on first use. A failed load, e.g. a chunk the network lost, is a `Network`
 * error, and the next call tries again.
 */
function loadYoutubei(): Promise<{ readonly Innertube: typeof Innertube }> {
  youtubei ??= import('youtubei.js').catch((error: unknown) => {
    youtubei = undefined
    throw new FxmError('Network', 'Could not load youtubei.js', { cause: error })
  })
  return youtubei
}

/**
 * Creates a device's YouTube session. Share one between the `ytm` and `yt` providers so that
 * they use one visitorData.
 */
export function createYouTubeSession(options: YouTubeSessionOptions = {}): YouTubeSession {
  const config = options.config ?? BUNDLED_YOUTUBE_CONFIG
  const timeoutMs = options.timeoutMs ?? 20_000
  const visitorData = new VisitorData(
    config.visitorData.swJsDataUrl,
    options.visitorDataStore,
    timeoutMs,
  )

  async function innertube(ctx: ProviderContext, client?: YouTubeClientConfig): Promise<Innertube> {
    assertYouTubeReachable(ctx)
    const locale = localeOf(ctx)
    const { Innertube } = await loadYoutubei()
    return Innertube.create({
      fetch: createInnerTubeFetch(ctx, {
        config,
        visitorData,
        timeoutMs,
        ...locale,
        ...(client === undefined ? {} : { client }),
      }),
      lang: locale.hl,
      ...(locale.gl === undefined ? {} : { location: locale.gl }),
      visitor_data: UNUSED_VISITOR_DATA,
      generate_session_locally: true,
      retrieve_player: false,
      retrieve_innertube_config: false,
      enable_session_cache: false,
    })
  }

  const session: YouTubeSession = {
    config,
    visitorData,
    innertube,
    async call(ctx, clientId, endpoint, payload) {
      const yt = await innertube(ctx, config.clients[clientId])
      try {
        const response = await yt.actions.execute(`/${endpoint}`, {
          ...payload,
          client: YOUTUBEI_CLIENT[clientId],
        })
        const json = asRecord(response.data)
        if (json === undefined) {
          throw new FxmError('Parse', `YouTube answered ${endpoint} with something unexpected`)
        }
        return json
      } catch (error) {
        if (isFxmError(error) || ctx.signal?.aborted) throw error
        throw new FxmError('Parse', `youtubei.js could not make the ${endpoint} call`, {
          cause: error,
        })
      }
    },
  }
  VISITOR_DATA.set(session, visitorData)
  return session
}
