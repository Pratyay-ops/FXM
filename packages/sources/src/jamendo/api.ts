/**
 * Jamendo's read API (v3.0), called only through the injected `fetch`.
 *
 * Every request carries a `client_id`: the public one the app is configured with, or the user's
 * own from Settings, which wins when set. With a `client_id`, Jamendo sends
 * `Access-Control-Allow-Origin: *` (measured 2026-10-25), so a browser page reaches it directly.
 * Jamendo answers errors with HTTP 200 and a code in its `headers` object: 5 for an unknown
 * `client_id`, 6 when the rate limit is used up, 11 for a suspended app. Codes 5, 6 and 11 are
 * recorded in the {@link JamendoQuota}, so FXM stops sending requests that cannot succeed.
 *
 * Answers are kept in memory, keyed without the `client_id`, so switching IDs costs nothing.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { asObject, getJson, statusError, text } from '../shared/json'
import { LoadCache } from '../shared/ttl-cache'
import type { JamendoBlock, JamendoQuota } from './quota'

/** The read API's root. */
export const JAMENDO_API = 'https://api.jamendo.com/v3.0/'

const SERVICE = 'Jamendo'

/** Which `client_id` a request uses: the app's public one, or the user's own. */
export type JamendoClientKind = 'public' | 'user'

/** What the Jamendo source can do right now, for the settings screen. */
export type JamendoAccess =
  | {
      /** Requests can go out with this `client_id`. */
      status: 'ready'
      client: JamendoClientKind
    }
  | {
      /** No `client_id` is set: neither a public one nor the user's own. */
      status: 'not-configured'
    }
  | {
      /**
       * The rate limit of this `client_id` is used up. For the public one, the app shows
       * "Jamendo's quota is used up: add your own client_id".
       */
      status: 'quota-exceeded'
      client: JamendoClientKind
      /** When FXM tries again, in epoch milliseconds. */
      retryAt: number
    }
  | {
      /** Jamendo does not know this `client_id`, or it is not one at all. */
      status: 'invalid-client-id'
      client: JamendoClientKind
    }
  | {
      /** Jamendo suspended the application this `client_id` belongs to. */
      status: 'suspended'
      client: JamendoClientKind
    }

/** Settings of a {@link JamendoApi}. */
export interface JamendoApiOptions {
  /** The read API's root, {@link JAMENDO_API} by default. */
  baseUrl?: string
  /** The app's public `client_id`, from its configuration. */
  publicClientId?: string
  /** The user's own `client_id`, from Settings. Used instead of the public one when set. */
  userClientId?: string
  /** Abort a request after this many milliseconds. */
  timeoutMs: number
  /** Where blocks on `client_id`s are recorded. */
  quota: JamendoQuota
  /** The clock, in epoch milliseconds. `Date.now` by default. */
  now?: () => number
}

/** What a Jamendo `client_id` looks like: letters, digits, `_` and `-` (issued as 8 hex digits). */
const CLIENT_ID = /^[A-Za-z0-9_-]{4,64}$/u

/** A `client_id` and whose it is. */
interface Client {
  id: string
  kind: JamendoClientKind
}

/** The error for a request that a block stops. */
function blockError(block: JamendoBlock, kind: JamendoClientKind, now: number): FxmError {
  if (block.reason === 'quota-exceeded') {
    const message =
      kind === 'public'
        ? "Jamendo's quota for FXM's client_id is used up: add your own client_id"
        : 'The rate limit of your Jamendo client_id is used up'
    return new FxmError('RateLimited', message, { retryAfterMs: Math.max(0, block.retryAt - now) })
  }
  return new FxmError(
    'AuthRequired',
    block.reason === 'suspended'
      ? 'Jamendo suspended the application of this client_id'
      : 'Jamendo does not accept this client_id',
  )
}

/** A client for Jamendo's read API: the `client_id`, the quota and the cache. */
export class JamendoApi {
  private readonly baseUrl: string
  private readonly publicClientId: string | undefined
  private userClientId: string | undefined
  private readonly cache: LoadCache<unknown[]>
  private readonly now: () => number

  constructor(private readonly options: JamendoApiOptions) {
    const base = options.baseUrl ?? JAMENDO_API
    this.baseUrl = base.endsWith('/') ? base : `${base}/`
    this.publicClientId = text(options.publicClientId)
    this.userClientId = text(options.userClientId)
    this.now = options.now ?? Date.now
    this.cache = new LoadCache({ maxEntries: 200, now: this.now })
  }

  /** Sets the user's own `client_id`, or clears it with `undefined` or a blank string. */
  setUserClientId(clientId: string | undefined): void {
    this.userClientId = text(clientId)
  }

  /** The `client_id` requests use, or `undefined` when none is set. */
  private client(): Client | undefined {
    if (this.userClientId !== undefined) return { id: this.userClientId, kind: 'user' }
    if (this.publicClientId !== undefined) return { id: this.publicClientId, kind: 'public' }
    return undefined
  }

  /**
   * What the source can do right now. A rate-limited `client_id` stays `quota-exceeded` until a
   * request succeeds, even once FXM may try it again.
   */
  access(): JamendoAccess {
    const client = this.client()
    if (client === undefined) return { status: 'not-configured' }
    if (!CLIENT_ID.test(client.id)) return { status: 'invalid-client-id', client: client.kind }
    const block = this.options.quota.recorded(client.id)
    if (block === undefined) return { status: 'ready', client: client.kind }
    if (block.reason === 'quota-exceeded') {
      return { status: 'quota-exceeded', client: client.kind, retryAt: block.retryAt }
    }
    return { status: block.reason, client: client.kind }
  }

  /**
   * The `results` of `GET <entity>/?…` with `params`, kept for `ttlMs`. Rejects with
   * `Unsupported` when no `client_id` is set, with `RateLimited` while its rate limit is used up
   * (with the time until FXM tries again), and with `AuthRequired` when Jamendo does not accept
   * it, all without a request once Jamendo has said so.
   */
  async get(
    entity: string,
    params: Readonly<Record<string, string>>,
    ttlMs: number,
    ctx: ProviderContext,
  ): Promise<unknown[]> {
    const client = this.client()
    if (client === undefined) {
      throw new FxmError('Unsupported', 'Jamendo needs a client_id, and none is set')
    }
    if (!CLIENT_ID.test(client.id)) {
      throw new FxmError('AuthRequired', 'The Jamendo client_id is not one Jamendo issues')
    }
    const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
    const key = `${entity}?${new URLSearchParams(sorted).toString()}`
    return this.cache.get(
      key,
      ttlMs,
      () => this.fetchResults(client, entity, sorted, ctx),
      ctx.signal,
    )
  }

  /** One request with `client`, mapped to its results or an error. */
  private async fetchResults(
    client: Client,
    entity: string,
    params: ReadonlyArray<readonly [string, string]>,
    ctx: ProviderContext,
  ): Promise<unknown[]> {
    const { quota, timeoutMs } = this.options
    const block = quota.blocked(client.id)
    if (block !== undefined) throw blockError(block, client.kind, this.now())
    const url = new URL(`${entity}/`, this.baseUrl)
    url.searchParams.set('client_id', client.id)
    url.searchParams.set('format', 'json')
    for (const [name, value] of params) url.searchParams.set(name, value)
    const reply = await getJson(ctx, url.href, { service: SERVICE, timeoutMs })
    if (reply.status === 429) return this.refused(client, 'rate-limited')
    if (reply.status !== 200) throw statusError(SERVICE, `the ${entity} request`, reply)
    const body = asObject(reply.body)
    const headers = asObject(body?.headers)
    const code = headers?.code
    // The samples say `success`, the response-code table `succeed`: code 0 decides.
    if ((code === 0 || code === '0') && headers?.status !== 'failed') {
      if (!Array.isArray(body?.results)) {
        throw new FxmError('Parse', 'Jamendo sent results FXM does not understand')
      }
      quota.record(client.id, 'ok')
      return body.results
    }
    if (code === 6 || code === '6') return this.refused(client, 'rate-limited')
    if (code === 5 || code === '5') return this.refused(client, 'invalid')
    if (code === 11 || code === '11') return this.refused(client, 'suspended')
    if (headers === undefined) {
      throw new FxmError('Parse', 'Jamendo sent an answer FXM does not understand')
    }
    throw new FxmError(
      'Unavailable',
      `Jamendo refused the ${entity} request with code ${String(code)}`,
    )
  }

  /** Records a refusal of `client` and rejects with the error it means. */
  private refused(client: Client, outcome: 'rate-limited' | 'invalid' | 'suspended'): never {
    const { quota } = this.options
    quota.record(client.id, outcome)
    const block = quota.recorded(client.id)
    if (block === undefined) throw new FxmError('Unavailable', 'Jamendo refused the request')
    throw blockError(block, client.kind, this.now())
  }
}
