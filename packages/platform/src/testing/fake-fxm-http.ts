/**
 * A fake `FxmHttp` plugin (the Android app's OkHttp plugin, stage 6.2) for tests. It speaks the
 * bridge protocol of `android-http.ts` the way the native plugin does: request heads first,
 * bodies in base64 chunks of at most the size asked for, aborts, unknown ids, and hosts outside
 * FXM's host table that need the user's approval (refused with `HOST_NOT_APPROVED` and the host
 * in `data.host`; a host on the table at another path or port is `HOST_NOT_ALLOWED`). Answers
 * come from a handler that returns a standard `Response`, whose body is read lazily, chunk by
 * chunk; a redirect response comes back as it is, as under `redirect: 'manual'`.
 *
 * @module
 */

import {
  encodeBase64,
  FXM_HTTP_MAX_READ_BYTES,
  FXM_HTTP_READ_BYTES,
  type FxmHttpChunk,
  type FxmHttpErrorCode,
  type FxmHttpPlugin,
  type FxmHttpRequest,
  type FxmHttpResponseHead,
} from '../android-http'
import { findHostRule, HOST_RULES, matchesHost } from '../hosts'

/**
 * An error as the bridge delivers the plugin's rejections: a message, a `code` and, for some
 * codes, `data` (`HOST_NOT_APPROVED` names the refused host in `data.host`).
 */
export function fxmHttpError(
  code: FxmHttpErrorCode,
  message: string = code,
  data?: Readonly<Record<string, unknown>>,
): Error & { code: string; data?: Readonly<Record<string, unknown>> } {
  return Object.assign(new Error(message), { code }, data === undefined ? {} : { data })
}

/** Whether a host name matches a rule of FXM's host table, at any path or port. */
function isTableHost(hostname: string): boolean {
  return HOST_RULES.some((rule) => matchesHost(hostname, rule.host))
}

/**
 * A host as the native plugin stores it (`URL.host`: lower case, ASCII, no default port), or a
 * `BAD_REQUEST` error for anything that is not a plain host, as the plugin refuses it.
 */
function normalizedHosts(hosts: readonly string[]): string[] {
  const normalized = hosts.map((entry) => {
    const trimmed = entry.trim()
    try {
      if (trimmed === '' || /[/?#@\\\s]/u.test(trimmed)) throw new TypeError(entry)
      return new URL(`https://${trimmed}/`).host
    } catch {
      throw fxmHttpError('BAD_REQUEST', `Not a host name: ${entry}`)
    }
  })
  return [...new Set(normalized)]
}

/** Options for {@link createFakeFxmHttp}. */
export interface FakeFxmHttpOptions {
  /**
   * Answers a request, or throws (e.g. an {@link fxmHttpError}) to make the plugin reject it.
   * Default: 200 with `{}`.
   */
  respond?: (request: FxmHttpRequest) => Response | Promise<Response>
  /** Hosts the user approved already (`host` or `host:port`). */
  approved?: Iterable<string>
  /** How the user answers the approval dialog. Default: they allow every host. */
  answer?: (hosts: readonly string[]) => boolean | Promise<boolean>
}

/** A fake plugin that records what it was asked. */
export interface FakeFxmHttp extends FxmHttpPlugin {
  /** Every request, in order. */
  readonly requests: readonly FxmHttpRequest[]
  /** Every read, in order. */
  readonly reads: readonly { id: string; maxBytes?: number }[]
  /** Every aborted id, in order. */
  readonly aborts: readonly string[]
  /** Every approval dialog's hosts, in order. */
  readonly questions: readonly (readonly string[])[]
  /** The ids whose bodies are open. */
  readonly open: readonly string[]
}

interface OpenBody {
  reader: ReadableStreamDefaultReader<Uint8Array>
  pending: Uint8Array
  aborted: boolean
  waiting: ((error: Error) => void) | undefined
}

/** Creates a fake `FxmHttp` plugin. */
export function createFakeFxmHttp(options: FakeFxmHttpOptions = {}): FakeFxmHttp {
  const requests: FxmHttpRequest[] = []
  const reads: { id: string; maxBytes?: number }[] = []
  const aborts: string[] = []
  const questions: (readonly string[])[] = []
  const approved = new Set(options.approved)
  const bodies = new Map<string, OpenBody>()
  const pendingIds = new Map<string, () => void>()

  async function nextBytes(body: OpenBody, maxBytes: number): Promise<Uint8Array | undefined> {
    if (body.pending.length === 0) {
      const aborted = new Promise<never>((_, reject) => {
        body.waiting = reject
      })
      const result = await Promise.race([body.reader.read(), aborted])
      body.waiting = undefined
      if (result.done) return undefined
      body.pending = result.value
    }
    const bytes = body.pending.subarray(0, maxBytes)
    body.pending = body.pending.subarray(bytes.length)
    return bytes
  }

  return {
    get requests() {
      return requests
    },
    get reads() {
      return reads
    },
    get aborts() {
      return aborts
    },
    get questions() {
      return questions
    },
    get open() {
      return [...bodies.keys()]
    },

    async request(request) {
      requests.push(request)
      if (bodies.has(request.id) || pendingIds.has(request.id)) {
        throw fxmHttpError('BAD_REQUEST', `The id ${request.id} is in use`)
      }
      const url = new URL(request.url)
      if (url.protocol !== 'https:') throw fxmHttpError('HOST_NOT_ALLOWED', 'FXM only uses HTTPS')
      if (findHostRule(url) === undefined) {
        // As in the native plugin: a host on the table is never a user host, whatever was approved.
        if (isTableHost(url.hostname)) {
          throw fxmHttpError('HOST_NOT_ALLOWED', `FXM does not contact ${url.host} at that path`)
        }
        if (!approved.has(url.host)) {
          throw fxmHttpError('HOST_NOT_APPROVED', `The user has not approved ${url.host}`, {
            host: url.host,
          })
        }
      }
      let abortedEarly = false
      pendingIds.set(request.id, () => {
        abortedEarly = true
      })
      let response: Response
      try {
        response = await (options.respond?.(request) ?? Response.json({}))
      } finally {
        pendingIds.delete(request.id)
      }
      if (abortedEarly) throw fxmHttpError('ABORTED', 'The request was aborted')
      const hasBody =
        response.body !== null &&
        request.method !== 'HEAD' &&
        ![204, 205, 304].includes(response.status)
      if (hasBody && response.body !== null) {
        bodies.set(request.id, {
          reader: response.body.getReader(),
          pending: new Uint8Array(0),
          aborted: false,
          waiting: undefined,
        })
      }
      const head: FxmHttpResponseHead = {
        id: request.id,
        status: response.status,
        statusText: response.statusText,
        url: response.url === '' ? request.url : response.url,
        redirected: response.redirected,
        headers: [...response.headers].filter(([name]) => name !== 'set-cookie'),
        body: hasBody,
      }
      return head
    },

    async read({ id, maxBytes }) {
      reads.push(maxBytes === undefined ? { id } : { id, maxBytes })
      const body = bodies.get(id)
      if (body === undefined) throw fxmHttpError('UNKNOWN_ID', `No open response has the id ${id}`)
      const limit = Math.max(1, Math.min(maxBytes ?? FXM_HTTP_READ_BYTES, FXM_HTTP_MAX_READ_BYTES))
      let bytes: Uint8Array | undefined
      try {
        bytes = await nextBytes(body, limit)
      } catch (error) {
        bodies.delete(id)
        if (body.aborted) throw fxmHttpError('ABORTED', 'The request was aborted')
        throw fxmHttpError('NETWORK', `The body broke off: ${String(error)}`)
      }
      if (bytes === undefined) {
        bodies.delete(id)
        return { data: '', done: true } satisfies FxmHttpChunk
      }
      return { data: encodeBase64(bytes), done: false } satisfies FxmHttpChunk
    },

    async abort({ id }) {
      aborts.push(id)
      pendingIds.get(id)?.()
      const body = bodies.get(id)
      if (body === undefined) return
      bodies.delete(id)
      body.aborted = true
      body.waiting?.(fxmHttpError('ABORTED'))
      await body.reader.cancel().catch(() => undefined)
    },

    async approveHosts(request) {
      const hosts = normalizedHosts(request.hosts)
      const builtIn = hosts.find((host) => isTableHost(new URL(`https://${host}/`).hostname))
      if (builtIn !== undefined) {
        throw fxmHttpError('BAD_REQUEST', `${builtIn} is one of FXM's own services`)
      }
      const missing = hosts.filter((host) => !approved.has(host))
      if (missing.length > 0) {
        questions.push(missing)
        if (await (options.answer?.(missing) ?? true)) {
          for (const host of missing) approved.add(host)
        }
      }
      return { approved: hosts.filter((host) => approved.has(host)) }
    },

    async approvedHosts() {
      return { hosts: [...approved].sort() }
    },

    async revokeHosts(request) {
      for (const host of normalizedHosts(request.hosts)) approved.delete(host)
      return { hosts: [...approved].sort() }
    },
  }
}
