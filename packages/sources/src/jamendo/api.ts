/**
 * Jamendo's read API (v3.0), called only through the injected `fetch`.
 *
 * Every request carries a `client_id`: the public one the app is configured with, or the user's
 * own from Settings, which wins when set. With a `client_id`, Jamendo sends
 * `Access-Control-Allow-Origin: *` (measured 2026-10-25), so a browser page reaches it directly.
 * Jamendo answers errors with HTTP 200 and a code in its `headers` object: 5 for an unknown
 * `client_id`, 6 when the rate limit is used up, 11 for a suspended app. Codes 5, 6 and 11 are
 * recorded in the {@link JamendoQuota}, so FXM stops sending requests that cannot succeed until
 * the block's wait is over; then one request tests the ID again while the others fail at once.
 *
 * Answers are kept in memory, keyed without the `client_id`, so switching IDs costs nothing.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { asObject, getJson, statusError, text } from '../shared/json'
import { LoadCache } from '../shared/ttl-cache'
import type { JamendoBlock, JamendoBlockReason, JamendoQuota } from './quota'

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

/**
 * The error for a request that a block stops: `RateLimited` with `retryAfterMs` for a used-up
 * quota, `AuthRequired` for an ID Jamendo refuses.
 */
function blockError(block: JamendoBlock, kind: JamendoClientKind, retryAfterMs: number): FxmError {
  if (block.reason === 'quota-exceeded') {
    const message =
      kind === 'public'
        ? "Jamendo's quota for FXM's client_id is used up: add your own client_id"
        : 'The rate limit of your Jamendo client_id is used up'
    return new FxmError('RateLimited', message, { retryAfterMs: Math.max(0, retryAfterMs) })
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
  /** The `client_id`s whose test request, after a block's wait, has not answered yet. */
  private readonly testing = new Set<string>()

  constructor(private readonly options: JamendoApiOptions) {
    const base = options.baseUrl ?? JAMENDO_API
    this.baseUrl = base.endsWith('/') ? base : `${base}/`
    this.publicClientId = text(options.publicClientId)
    this.userClientId = text(options.userClientId)
    this.now = options.now ?? Date.now
    this.cache = new LoadCache({ maxEntries: 200, now: this.now })
  }

  /**
   * Sets the user's own `client_id`, or clears it with `undefined` or a blank string. Entering an
   * ID, even the same one again, forgets its block, so that the next request tests it at once:
   * call this when the user enters an ID in Settings, and pass a saved one as `userClientId` on
   * start instead, which keeps its block.
   */
  setUserClientId(clientId: string | undefined): void {
    this.userClientId = text(clientId)
    if (this.userClientId !== undefined) this.options.quota.forget(this.userClientId)
  }

  /** Forgets the block on the `client_id` in use, so that the next request tests it again. */
  tryAgain(): void {
    const client = this.client()
    if (client !== undefined) this.options.quota.forget(client.id)
  }

  /** The `client_id` requests use, or `undefined` when none is set. */
  private client(): Client | undefined {
    if (this.userClientId !== undefined) return { id: this.userClientId, kind: 'user' }
    if (this.publicClientId !== undefined) return { id: this.publicClientId, kind: 'public' }
    return undefined
  }

  /**
   * What the source can do right now. A blocked `client_id` keeps its status until a request
   * succeeds, even once FXM may try it again.
   */
  access(): JamendoAccess {
    const client = this.client()
    if (client === undefined) return { status: 'not-configured' }
    if (!CLIENT_ID.test(client.id)) return { status: 'invalid-client-id', client: client.kind }
    const block = this.options.quota.recorded(client.id)
    if (block === undefined) return { status: 'ready', client: client.kind }
    return { status: block.reason, client: client.kind, retryAt: block.retryAt }
  }

  /**
   * The `results` of `GET <entity>/?…` with `params`, kept for `ttlMs`. Rejects with
   * `AuthRequired` when no `client_id` is set or Jamendo does not accept it, and with
   * `RateLimited` while its rate limit is used up (with the time until FXM tries again), all
   * without a request once Jamendo has said so: the app then asks for a `client_id` in Settings.
   */
  async get(
    entity: string,
    params: Readonly<Record<string, string>>,
    ttlMs: number,
    ctx: ProviderContext,
  ): Promise<unknown[]> {
    const client = this.client()
    if (client === undefined) {
      throw new FxmError('AuthRequired', 'Jamendo needs a client_id, and none is set')
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

  /**
   * One request with `client`, unless a block stops it. Once a block's wait is over, this is the
   * one request that tests the ID again, and the others fail at once until it answers.
   */
  private async fetchResults(
    client: Client,
    entity: string,
    params: ReadonlyArray<readonly [string, string]>,
    ctx: ProviderContext,
  ): Promise<unknown[]> {
    const { quota, timeoutMs } = this.options
    const block = quota.blocked(client.id)
    if (block !== undefined) throw blockError(block, client.kind, block.retryAt - this.now())
    const lapsed = quota.recorded(client.id)
    if (lapsed === undefined) return this.send(client, entity, params, ctx)
    // The test request answers, or times out, within `timeoutMs`.
    if (this.testing.has(client.id)) throw blockError(lapsed, client.kind, timeoutMs)
    this.testing.add(client.id)
    try {
      return await this.send(client, entity, params, ctx)
    } finally {
      this.testing.delete(client.id)
    }
  }

  /** Sends one request with `client` and maps the answer to its results or an error. */
  private async send(
    client: Client,
    entity: string,
    params: ReadonlyArray<readonly [string, string]>,
    ctx: ProviderContext,
  ): Promise<unknown[]> {
    const { quota, timeoutMs } = this.options
    const url = new URL(`${entity}/`, this.baseUrl)
    url.searchParams.set('client_id', client.id)
    url.searchParams.set('format', 'json')
    for (const [name, value] of params) url.searchParams.set(name, value)
    const reply = await getJson(ctx, url.href, { service: SERVICE, timeoutMs })
    if (reply.status === 429) return this.refused(client, 'quota-exceeded')
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
    if (code === 6 || code === '6') return this.refused(client, 'quota-exceeded')
    if (code === 5 || code === '5') return this.refused(client, 'invalid-client-id')
    if (code === 11 || code === '11') return this.refused(client, 'suspended')
    if (headers === undefined) {
      throw new FxmError('Parse', 'Jamendo sent an answer FXM does not understand')
    }
    throw new FxmError(
      'Unavailable',
      `Jamendo refused the ${entity} request with code ${String(code)}`,
    )
  }

  /** Records a refusal of `client` and rejects with the error the block on it means. */
  private refused(client: Client, reason: JamendoBlockReason): never {
    const { quota } = this.options
    quota.record(client.id, reason)
    const block = quota.recorded(client.id)
    if (block === undefined) throw new FxmError('Unavailable', 'Jamendo refused the request')
    throw blockError(block, client.kind, block.retryAt - this.now())
  }
}
