/**
 * Authenticated calls to Spotify's GraphQL endpoint (pathfinder) and spclient, and what their
 * answers mean:
 *
 * - 401: the token is dropped and the call repeated once with a fresh one; a second 401 is
 *   `AuthRequired` (`token-rejected`)
 * - 403 `Client/request not allowed`: `Unsupported` (`client-rejected`), the transport's
 *   User-Agent is refused. Not retried
 * - any other 403: `Unavailable` (`forbidden`)
 * - 404: `NotFound`
 * - 412 `Invalid query hash`, or 400 with GraphQL validation errors: the operation is marked
 *   broken for the session, `Unavailable` (`operation-broken`)
 * - GraphQL `errors` and no data: `Unavailable` (`graphql`)
 * - 429 and 5xx: retried, then paused by the transport (see `http.ts`)
 *
 * Requests send only `Authorization`, `Content-Type` and `Accept` (plus a User-Agent on native
 * transports), the headers FXM Connect allows from a web page.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import type { SpotifyConfig, SpotifyOperationName } from './config'
import { SpotifyError } from './errors'
import type { SpotifyHttp, SpotifyRequest } from './http'
import type { OperationRegistry } from './operations'
import type { TokenKind, TokenManager } from './token'

/** A JSON object. */
export type JsonRecord = Record<string, unknown>

/** What {@link SpotifyClient} needs. */
export interface SpotifyClientOptions {
  /** Endpoints. */
  config: SpotifyConfig
  /** The transport. */
  http: SpotifyHttp
  /** Access tokens. */
  tokens: TokenManager
  /** Operation hashes and broken marks. */
  operations: OperationRegistry
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One GraphQL error, as Spotify sends it. */
interface GraphQLError {
  message?: unknown
  extensions?: { code?: unknown }
}

function graphQLErrors(body: unknown): GraphQLError[] {
  const errors = isRecord(body) ? body.errors : undefined
  return Array.isArray(errors) ? errors.filter(isRecord) : []
}

function errorText(errors: GraphQLError[]): string {
  return errors
    .map((e) => (typeof e.message === 'string' ? e.message : 'unknown error'))
    .slice(0, 3)
    .join('; ')
}

/** Whether GraphQL errors say the request no longer fits the persisted query. */
function isSchemaMismatch(errors: GraphQLError[]): boolean {
  return errors.some((e) => {
    const code = e.extensions?.code
    return typeof code === 'string' && /^(VALIDATION|PERSISTED_QUERY)/u.test(code)
  })
}

/** Makes authenticated calls and maps Spotify's answers to typed errors. */
export class SpotifyClient {
  readonly #o: SpotifyClientOptions

  constructor(options: SpotifyClientOptions) {
    this.#o = options
  }

  /**
   * Runs a persisted GraphQL query and returns its `data` object.
   *
   * @param operation The operation, whose hash comes from the config.
   * @param variables Its variables.
   * @param kind Which token to send.
   */
  async query(
    operation: SpotifyOperationName,
    variables: JsonRecord,
    ctx: ProviderContext,
    kind: TokenKind = 'anonymous',
  ): Promise<JsonRecord> {
    const { operations, config } = this.#o
    const sha256Hash = operations.hashOf(operation)
    const body = JSON.stringify({
      variables,
      operationName: operation,
      extensions: { persistedQuery: { version: 1, sha256Hash } },
    })
    const response = await this.#authorized(
      (token) => ({
        url: config.endpoints.pathfinder,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json;charset=UTF-8',
          Accept: 'application/json',
        },
        body,
        what: `The Spotify operation ${operation}`,
      }),
      ctx,
      kind,
    )
    const json = await readJson(response, `The Spotify operation ${operation}`, ctx)
    const errors = graphQLErrors(json)
    if (response.status === 412 || (response.status === 400 && isSchemaMismatch(errors))) {
      operations.markBroken(operation)
      throw new SpotifyError(
        'Unavailable',
        'operation-broken',
        `Spotify rejected the operation ${operation} (HTTP ${response.status}); ` +
          'it needs a newer config',
      )
    }
    if (!response.ok) throw statusError(response.status, json, `The Spotify operation ${operation}`)
    const data = isRecord(json) ? json.data : undefined
    if (isRecord(data)) return data
    if (errors.length > 0) {
      const mismatch = isSchemaMismatch(errors)
      if (mismatch) operations.markBroken(operation)
      throw new SpotifyError(
        'Unavailable',
        mismatch ? 'operation-broken' : 'graphql',
        `The Spotify operation ${operation} failed: ${errorText(errors)}`,
      )
    }
    throw new SpotifyError(
      'Parse',
      'bad-response',
      `The Spotify operation ${operation} sent no data`,
    )
  }

  /**
   * GETs a JSON resource from spclient, e.g. `/metadata/4/track/<gid>?market=from_token`.
   *
   * @param path The path and query, starting with `/`.
   * @param kind Which token to send.
   */
  async spclient(
    path: string,
    ctx: ProviderContext,
    kind: TokenKind = 'anonymous',
  ): Promise<unknown> {
    const url = `${this.#o.config.endpoints.spclient}${path}`
    const what = `spclient ${path.split('?')[0]?.split('/').slice(0, 3).join('/') ?? ''}`
    const response = await this.#authorized(
      (token) => ({
        url,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        what,
      }),
      ctx,
      kind,
    )
    const json = await readJson(response, what, ctx)
    if (!response.ok) throw statusError(response.status, json, what)
    if (json === undefined) throw new SpotifyError('Parse', 'bad-response', `${what} sent no JSON`)
    return json
  }

  /** Sends a request with a token, and once more with a fresh token after a 401. */
  async #authorized(
    build: (token: string) => SpotifyRequest,
    ctx: ProviderContext,
    kind: TokenKind,
  ): Promise<Response> {
    const { tokens, http } = this.#o
    for (let attempt = 0; ; attempt++) {
      const token = await tokens.get(kind, ctx)
      const response = await http.request(build(token.accessToken), ctx)
      if (response.status !== 401) return response
      tokens.invalidate(kind, token.accessToken)
      await response.body?.cancel().catch(() => undefined)
      if (attempt >= 1) {
        throw new SpotifyError(
          'AuthRequired',
          'token-rejected',
          'Spotify answered 401 to a freshly minted token',
        )
      }
    }
  }
}

/**
 * Reads a body as JSON: `undefined` when it is empty, the raw text when an error response is not
 * JSON.
 *
 * @throws SpotifyError `Parse` when a successful response is not JSON, `Network` when the body
 * cannot be read. A caller's abort rejects with its signal's reason.
 */
async function readJson(response: Response, what: string, ctx: ProviderContext): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch {
    if (ctx.signal?.aborted) throw ctx.signal.reason
    throw new SpotifyError('Network', 'network', `${what}: the response could not be read`)
  }
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    if (response.ok) throw new SpotifyError('Parse', 'bad-response', `${what} sent malformed JSON`)
    return text
  }
}

/** The typed error for an unsuccessful status other than 401, 412 and the retried ones. */
function statusError(status: number, body: unknown, what: string): SpotifyError {
  if (status === 403) {
    const message = isRecord(body) && isRecord(body.error) ? body.error.message : body
    if (typeof message === 'string' && /client\/request not allowed/iu.test(message)) {
      return new SpotifyError(
        'Unsupported',
        'client-rejected',
        `${what}: Spotify refused this client (403 Client/request not allowed); ` +
          'native transports must send a browser User-Agent',
      )
    }
    return new SpotifyError('Unavailable', 'forbidden', `${what} answered HTTP 403`)
  }
  if (status === 404) return new SpotifyError('NotFound', 'not-found', `${what} answered HTTP 404`)
  const errors = graphQLErrors(body)
  if (errors.length > 0) {
    return new SpotifyError('Unavailable', 'graphql', `${what} failed: ${errorText(errors)}`)
  }
  return new SpotifyError('Unavailable', 'http', `${what} answered HTTP ${status}`)
}
