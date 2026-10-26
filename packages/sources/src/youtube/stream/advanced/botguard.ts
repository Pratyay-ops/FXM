/**
 * Web PO tokens for the attested and SABR rungs, minted by BotGuard in the isolated evaluator.
 * BotGuard makes no network request of its own: the evaluator document allows none. This module
 * makes them through `ctx.fetch` and hands the results in:
 *
 * 1. **The challenge.** YouTube's home page (`https://www.youtube.com/`) carries an initial
 *    attestation challenge (`window.ytAtN({...})`: BotGuard's interpreter URL, its program and the
 *    name of its global) and the page's `EVENT_ID`, which BotGuard reads as `yt.config_`.
 * 2. **The interpreter**, from `https://www.google.com/js/th/…` (cached by URL: it never changes).
 * 3. **The snapshot**, taken by BotGuard in the evaluator (`Evaluator.botguardSnapshot`).
 * 4. **The integrity token**, from `https://www.youtube.com/api/jnn/v1/GenerateIT` for that
 *    snapshot. It lasts as long as the answer says (12 hours on 2026-10-26).
 * 5. **The tokens**, minted in the evaluator for each video ID: web PO tokens are bound to the
 *    video they are for (`Evaluator.mintWebPoTokens`).
 *
 * Measured on 2026-10-26 (`CLEAN-ROOM.md`): googlevideo accepts such a token only when BotGuard
 * ran in a real browser engine whose document is at `https://www.youtube.com`. Elsewhere
 * (`about:blank`, an opaque document, happy-dom) `GenerateIT` answers no integrity token, and
 * tokens from Google's generic `Create` challenge are refused by googlevideo wherever they are
 * minted. So these rungs only run with an evaluator at that origin (`ATTESTATION_ORIGIN`).
 *
 * The session is shared: every caller waits for the same one, each with its own signal, and only
 * timeouts stop it. A refused attestation is remembered for a while, and so is a home page that
 * YouTube answers with its cookie consent page (`consent.youtube.com`, for requests without
 * cookies from some regions such as the European Union), which carries no challenge.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { GOOG_API_KEY, parseLooseJSON } from 'bgutils-js/utils'
import { fetchWithTimeout } from '../../../shared'
import { requestFailure } from '../../errors'
import { arrayAt, asRecord, asString, at } from '../../json'
import { untilAborted } from './abort'
import type { StreamEvaluator } from './evaluator'

/** YouTube's home page, which carries the challenge. */
export const YOUTUBE_HOME_URL = 'https://www.youtube.com/'

/** Where a snapshot becomes an integrity token, on YouTube's own host. */
export const GENERATE_IT_URL = 'https://www.youtube.com/api/jnn/v1/GenerateIT'

/** The request key YouTube's web player uses for its integrity token. */
export const BOTGUARD_REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo'

/** Where BotGuard's interpreter scripts are, and the only place one is fetched from. */
export const INTERPRETER_PREFIX = 'https://www.google.com/js/th/'

/** How long before its end an integrity token is replaced. */
const RENEW_MARGIN_MS = 10 * 60_000

/** How long a refused attestation is remembered, so the ladder does not ask again at once. */
const REFUSAL_MEMORY_MS = 30 * 60_000

/** How many videos' tokens are kept. */
const MAX_TOKENS = 64

/** The host of {@link YOUTUBE_HOME_URL}: an answer from anywhere else was redirected. */
const YOUTUBE_HOST = 'www.youtube.com'

/**
 * The form of YouTube's cookie consent page, where it sends a request without cookies from some
 * regions (the European Union, for one) instead of its home page.
 */
const CONSENT_FORM = /<form[^>]*\saction="https:\/\/consent\.(?:youtube|google)\.com\//u

/**
 * Why the home page carries no challenge when YouTube answered it from `finalUrl` (the URL of
 * the response, empty where the transport doesn't say) with `html`: its cookie consent page
 * instead of the home page, or `undefined` for another reason.
 */
export function consentRedirect(finalUrl: string, html: string): string | undefined {
  const host = URL.canParse(finalUrl) ? new URL(finalUrl).host : undefined
  if (host !== undefined && host !== YOUTUBE_HOST) return host
  return CONSENT_FORM.test(html) && !html.includes('window.ytAtN(')
    ? 'consent.youtube.com'
    : undefined
}

/** The challenge of YouTube's home page. */
export interface PageChallenge {
  /** The page's `EVENT_ID`, which BotGuard reads as `yt.config_.EVENT_ID`. */
  readonly eventId: string
  /** BotGuard's interpreter script, an absolute `https://www.google.com/js/th/…` URL. */
  readonly interpreterUrl: string
  /** The challenge's program. */
  readonly program: string
  /** The name of the global the interpreter defines. */
  readonly globalName: string
}

/**
 * Reads the challenge from YouTube's home page: the page's `EVENT_ID` from its `ytcfg`, and the
 * challenge from its `window.ytAtN({...})` call, whose loose JSON bgutils-js reads.
 *
 * @throws FxmError `Parse` when the page has no challenge or names an interpreter elsewhere.
 */
export function parsePageChallenge(html: string): PageChallenge {
  const eventId = /"EVENT_ID":"([\w-]{1,64})"/u.exec(html)?.[1]
  const loose = /window\.ytAtN\(\s*(\{[\s\S]*?\})\s*\)/u.exec(html)?.[1]
  if (eventId === undefined || loose === undefined) {
    throw new FxmError('Parse', "YouTube's page has no attestation challenge")
  }
  let data: unknown
  try {
    data = parseLooseJSON(loose)
  } catch (error) {
    throw new FxmError('Parse', "YouTube's attestation challenge is unreadable", { cause: error })
  }
  const challenge = asRecord(at(data, 'R', 'bgChallenge'))
  const wrapped = asString(
    at(challenge, 'interpreterUrl', 'privateDoNotAccessOrElseTrustedResourceUrlWrappedValue'),
  )
  const program = asString(challenge?.program)
  const globalName = asString(challenge?.globalName)
  if (wrapped === undefined || program === undefined || globalName === undefined) {
    throw new FxmError('Parse', "YouTube's attestation challenge is incomplete")
  }
  const interpreterUrl = new URL(wrapped, 'https://www.google.com/').href
  if (!interpreterUrl.startsWith(INTERPRETER_PREFIX)) {
    throw new FxmError(
      'Parse',
      `BotGuard's interpreter is not where it should be: ${interpreterUrl}`,
    )
  }
  return { eventId, interpreterUrl, program, globalName }
}

/** An integrity token and when to replace it. */
interface Session {
  readonly integrityToken: string
  readonly renewAt: number
}

/** Options for {@link WebPoTokens}. */
export interface WebPoTokensOptions {
  /** The isolated evaluator BotGuard runs in. */
  evaluator: StreamEvaluator
  /** How long one request may take, in milliseconds; 30 s by default. */
  timeoutMs?: number
  /** The clock, for tests. */
  now?: () => number
}

/** Web PO tokens for the device: one BotGuard session at a time, one token per video. */
export class WebPoTokens {
  #session: Session | undefined
  #pending: Promise<Session> | undefined
  #refusal: { readonly error: FxmError; readonly until: number } | undefined
  readonly #tokens = new Map<string, { readonly token: string; readonly until: number }>()
  readonly #interpreters = new Map<string, string>()
  readonly #evaluator: StreamEvaluator
  readonly #timeoutMs: number
  readonly #now: () => number

  constructor(options: WebPoTokensOptions) {
    this.#evaluator = options.evaluator
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#now = options.now ?? Date.now
  }

  /**
   * A web PO token bound to `videoId`, for the `pot` parameter of its stream URLs and for its
   * SABR requests.
   *
   * @throws FxmError `Parse` when BotGuard's attestation was refused or failed, `Network` when a
   * request failed, or the caller's cancellation.
   */
  async tokenFor(ctx: ProviderContext, videoId: string): Promise<string> {
    const now = this.#now()
    const cached = this.#tokens.get(videoId)
    if (cached !== undefined && cached.until > now) return cached.token
    for (let attempt = 0; ; attempt += 1) {
      // The session is shared by every caller; a cancellation stops only this caller's wait.
      const session = await untilAborted(this.#sessionFor(ctx), ctx.signal)
      let token: string | undefined
      try {
        ;[token] = await this.#evaluator.mintWebPoTokens(session.integrityToken, [videoId], {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      } catch (error) {
        // The evaluator document restarted and lost BotGuard: start a new session, once.
        const lost = (error as { evaluatorCode?: unknown }).evaluatorCode === 'no-botguard-session'
        if (lost && attempt === 0) {
          this.#session = undefined
          continue
        }
        throw error
      }
      if (token === undefined) throw new FxmError('Parse', 'BotGuard minted no token')
      this.#tokens.delete(videoId)
      this.#tokens.set(videoId, { token, until: session.renewAt })
      while (this.#tokens.size > MAX_TOKENS) {
        const oldest = this.#tokens.keys().next().value
        if (oldest === undefined) break
        this.#tokens.delete(oldest)
      }
      return token
    }
  }

  #sessionFor(ctx: ProviderContext): Promise<Session> {
    const now = this.#now()
    if (this.#session !== undefined && this.#session.renewAt > now) {
      return Promise.resolve(this.#session)
    }
    if (this.#refusal !== undefined && this.#refusal.until > now) {
      return Promise.reject(this.#refusal.error)
    }
    // One session for every caller, without any one caller's signal: only timeouts stop it.
    this.#pending ??= this.#start(ctx.fetch).finally(() => {
      this.#pending = undefined
    })
    return this.#pending
  }

  /** Remembers `error` as BotGuard's verdict on this device for a while, and returns it. */
  #refuse(error: FxmError): FxmError {
    this.#refusal = { error, until: this.#now() + REFUSAL_MEMORY_MS }
    return error
  }

  /** A request of the shared session: it has no caller's signal, only its timeout. */
  async #request(
    fetch: ProviderContext['fetch'],
    url: string,
    init: RequestInit = {},
  ): Promise<{ readonly text: string; readonly url: string }> {
    let response: Response
    let text: string
    try {
      response = await fetchWithTimeout(fetch, url, {
        method: 'GET',
        credentials: 'omit',
        ...init,
        timeoutMs: this.#timeoutMs,
      })
      text = await response.text()
    } catch (error) {
      throw requestFailure(error, url)
    }
    if (!response.ok) {
      throw new FxmError('Network', `${url} answered HTTP ${response.status}`)
    }
    return { text, url: response.url }
  }

  async #interpreter(fetch: ProviderContext['fetch'], url: string): Promise<string> {
    const cached = this.#interpreters.get(url)
    if (cached !== undefined) return cached
    const { text: script } = await this.#request(fetch, url)
    this.#interpreters.clear()
    this.#interpreters.set(url, script)
    return script
  }

  /** The challenge of YouTube's home page. */
  async #challenge(fetch: ProviderContext['fetch']): Promise<PageChallenge> {
    const page = await this.#request(fetch, YOUTUBE_HOME_URL)
    try {
      return parsePageChallenge(page.text)
    } catch (error) {
      const consent = consentRedirect(page.url, page.text)
      if (consent === undefined) throw error
      // Asking again soon would only download the same page.
      throw this.#refuse(
        new FxmError(
          'Unsupported',
          `YouTube answered its home page with ${consent} (a cookie consent page), which carries no attestation challenge`,
          { cause: error },
        ),
      )
    }
  }

  async #start(fetch: ProviderContext['fetch']): Promise<Session> {
    this.#tokens.clear()
    const challenge = await this.#challenge(fetch)
    const interpreter = await this.#interpreter(fetch, challenge.interpreterUrl)
    const snapshot = await this.#evaluator.botguardSnapshot({
      interpreter,
      program: challenge.program,
      globalName: challenge.globalName,
      pageConfig: { EVENT_ID: challenge.eventId },
    })
    const { text: answer } = await this.#request(fetch, GENERATE_IT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json+protobuf',
        'x-goog-api-key': GOOG_API_KEY,
        'x-user-agent': 'grpc-web-javascript/0.1',
      },
      body: JSON.stringify([BOTGUARD_REQUEST_KEY, snapshot]),
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(answer)
    } catch (error) {
      throw new FxmError('Parse', 'GenerateIT answered something other than JSON', {
        cause: error,
      })
    }
    const [integrityToken, ttl] = arrayAt(parsed)
    if (typeof integrityToken !== 'string' || integrityToken === '') {
      // BotGuard's verdict on this document: no token. Asking again soon would not change it.
      throw this.#refuse(
        new FxmError(
          'Parse',
          'BotGuard refused the attestation: GenerateIT answered no integrity token',
        ),
      )
    }
    const seconds = Number(ttl)
    const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000
    this.#refusal = undefined
    const session: Session = {
      integrityToken,
      renewAt: this.#now() + Math.max(60_000, lifetimeMs - RENEW_MARGIN_MS),
    }
    this.#session = session
    return session
  }
}
