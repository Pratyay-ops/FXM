/**
 * A minimal client for GitHub's REST API: the gist endpoints sync uses, and the user endpoint
 * that checks a token. It takes the platform's `fetch` (see `Fetch` in `@fxm/core`) and never
 * touches the global one, so tests pass a fake GitHub and every platform can pass its own.
 *
 * Every request carries the user's token as `Authorization: Bearer …` and goes only to
 * `api.github.com`, which answers CORS requests from any origin (measured 2026-10-25, see
 * `CLEAN-ROOM.md`). Requests omit credentials, skip the HTTP cache and send no referrer. Errors
 * are {@link GitHubError}s with a code, and never contain the token.
 *
 * @module
 */

import type { Fetch } from '@fxm/core'

/** GitHub's REST API. */
export const GITHUB_API = 'https://api.github.com'

/** The REST API version FXM was written against. */
export const GITHUB_API_VERSION = '2022-11-28'

/** Why a GitHub request failed. */
export type GitHubErrorCode =
  /** 401: the token is wrong, expired or revoked. */
  | 'unauthorized'
  /** 403: the token may not do this, e.g. it lacks the Gists permission. */
  | 'forbidden'
  /** 404: no such gist, or one the token can't see. */
  | 'not-found'
  /** 403 or 429 with a rate limit: try again after `retryAfterMs`. */
  | 'rate-limited'
  /** 400, 409 or 422: GitHub refused the request as it was. */
  | 'invalid'
  /** 5xx, or an unexpected status. */
  | 'server'
  /** No answer: offline, DNS, a blocked request. */
  | 'network'
  /** No answer in time. */
  | 'timeout'
  /** An answer FXM can't read. */
  | 'parse'

/** A failed GitHub request. */
export class GitHubError extends Error {
  override readonly name = 'GitHubError'
  readonly code: GitHubErrorCode
  /** The HTTP status, when GitHub answered. */
  readonly status: number | undefined
  /** For `rate-limited`: how long to wait. */
  readonly retryAfterMs: number | undefined

  constructor(
    code: GitHubErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
  }
}

/** One file of a gist. */
export interface GistFile {
  filename: string
  /** The content, absent in lists of gists. At most about 1 MB: see `truncated`. */
  content?: string
  /** Whether `content` is only the start of the file. */
  truncated: boolean
  /** Size in bytes. */
  size?: number
}

/** A gist, as FXM reads it. */
export interface Gist {
  id: string
  /** The gist's page on GitHub. */
  htmlUrl: string
  description: string
  public: boolean
  /** The owner's login. */
  owner?: string
  /** When it last changed, as an ISO 8601 date. */
  updatedAt: string
  files: Record<string, GistFile>
  /** More than 300 files: GitHub listed only the first 300. */
  truncated: boolean
}

/** The user a token belongs to. */
export interface GitHubUser {
  login: string
  /**
   * A classic token's OAuth scopes (`X-OAuth-Scopes`). Absent for fine-grained tokens, which
   * have permissions instead.
   */
  scopes?: string[]
}

/** A gist read, or "not modified" for a conditional read. */
export type GistRead =
  | { notModified: true; etag?: string }
  | { notModified: false; gist: Gist; etag?: string }

/** The gist operations sync needs. */
export interface GistApi {
  /** The token's user. Fails with `unauthorized` for a bad token. */
  getUser(signal?: AbortSignal): Promise<GitHubUser>
  /** One page (1-based) of the token's gists, 100 at a time, without file contents. */
  listGists(page: number, signal?: AbortSignal): Promise<{ gists: Gist[]; hasMore: boolean }>
  /** A gist with its files. With `etag`, resolves `notModified` when it hasn't changed. */
  getGist(id: string, options?: { etag?: string; signal?: AbortSignal }): Promise<GistRead>
  /** Creates a secret gist. */
  createGist(
    input: { description: string; files: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<{ gist: Gist; etag?: string }>
  /** Adds, replaces (a string) or deletes (`null`) files of a gist, as one revision. */
  updateGist(
    id: string,
    files: Record<string, string | null>,
    signal?: AbortSignal,
  ): Promise<{ gist: Gist; etag?: string }>
  /** Deletes a gist. */
  deleteGist(id: string, signal?: AbortSignal): Promise<void>
}

/** What {@link createGitHubClient} needs. */
export interface GitHubClientOptions {
  /** The user's token. */
  token: string
  /** The platform's `fetch`. */
  fetch: Fetch
  /** How long a request may take, in milliseconds. */
  timeoutMs?: number
  /** The clock, for rate-limit resets. */
  now?: () => number
}

interface Answer {
  status: number
  headers: { get(name: string): string | null }
  data: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readGist(value: unknown): Gist {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.files)) {
    throw new GitHubError('parse', 'GitHub sent a gist FXM cannot read')
  }
  const files: Record<string, GistFile> = {}
  for (const [name, file] of Object.entries(value.files)) {
    if (!isRecord(file)) continue
    const entry: GistFile = {
      filename: typeof file.filename === 'string' ? file.filename : name,
      truncated: file.truncated === true,
    }
    if (typeof file.content === 'string') entry.content = file.content
    if (typeof file.size === 'number') entry.size = file.size
    files[name] = entry
  }
  const gist: Gist = {
    id: value.id,
    htmlUrl: typeof value.html_url === 'string' ? value.html_url : '',
    description: typeof value.description === 'string' ? value.description : '',
    public: value.public === true,
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : '',
    files,
    truncated: value.truncated === true,
  }
  if (isRecord(value.owner) && typeof value.owner.login === 'string') {
    gist.owner = value.owner.login
  }
  return gist
}

/** A client for the GitHub REST API with the user's token. */
export function createGitHubClient(options: GitHubClientOptions): GistApi {
  const { token, fetch, timeoutMs = 30_000, now = () => Date.now() } = options

  async function errorFrom(response: Response): Promise<GitHubError> {
    const status = response.status
    let message = ''
    try {
      const body: unknown = await response.json()
      if (isRecord(body) && typeof body.message === 'string') message = body.message.slice(0, 300)
    } catch {
      // Not JSON: the status says enough.
    }
    const text =
      message === '' ? `GitHub answered ${status}` : `GitHub answered ${status}: ${message}`
    const retryAfter = Number(response.headers.get('retry-after'))
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const limited =
      status === 429 ||
      (status === 403 && (remaining === '0' || retryAfter > 0 || /rate limit/i.test(message)))
    if (limited) {
      let retryAfterMs = 60_000
      if (retryAfter > 0) retryAfterMs = retryAfter * 1000
      else if (reset > 0) retryAfterMs = Math.max(1000, reset * 1000 - now())
      return new GitHubError('rate-limited', text, { status, retryAfterMs })
    }
    if (status === 401) return new GitHubError('unauthorized', text, { status })
    if (status === 403) return new GitHubError('forbidden', text, { status })
    if (status === 404) return new GitHubError('not-found', text, { status })
    if (status === 400 || status === 409 || status === 422) {
      return new GitHubError('invalid', text, { status })
    }
    return new GitHubError('server', text, { status })
  }

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init: { body?: unknown; etag?: string | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<Answer> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const outer = init.signal
    const onAbort = () => controller.abort(outer?.reason)
    if (outer?.aborted) controller.abort(outer.reason)
    else outer?.addEventListener('abort', onAbort, { once: true })
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (init.etag !== undefined) headers['If-None-Match'] = init.etag
    try {
      let response: Response
      try {
        response = await fetch(`${GITHUB_API}${path}`, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        })
      } catch (cause) {
        if (outer?.aborted) throw outer.reason ?? cause
        if (timedOut) throw new GitHubError('timeout', 'GitHub did not answer in time', { cause })
        throw new GitHubError('network', 'GitHub could not be reached', { cause })
      }
      if (response.status === 304)
        return { status: 304, headers: response.headers, data: undefined }
      if (!response.ok) throw await errorFrom(response)
      if (response.status === 204)
        return { status: 204, headers: response.headers, data: undefined }
      let data: unknown
      try {
        data = await response.json()
      } catch (cause) {
        if (outer?.aborted) throw outer.reason ?? cause
        if (timedOut) throw new GitHubError('timeout', 'GitHub did not answer in time', { cause })
        throw new GitHubError('parse', 'GitHub sent something FXM cannot read', { cause })
      }
      return { status: response.status, headers: response.headers, data }
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }

  const etagOf = (answer: Answer) => answer.headers.get('etag') ?? undefined
  const withEtag = <T extends object>(value: T, answer: Answer): T & { etag?: string } => {
    const etag = etagOf(answer)
    return etag === undefined ? value : { ...value, etag }
  }

  return {
    async getUser(signal) {
      const answer = await request('GET', '/user', { signal })
      if (!isRecord(answer.data) || typeof answer.data.login !== 'string') {
        throw new GitHubError('parse', 'GitHub sent a user FXM cannot read')
      }
      const user: GitHubUser = { login: answer.data.login }
      const scopes = answer.headers.get('x-oauth-scopes')
      if (scopes !== null) {
        user.scopes = scopes
          .split(',')
          .map((scope) => scope.trim())
          .filter((scope) => scope !== '')
      }
      return user
    },

    async listGists(page, signal) {
      const answer = await request('GET', `/gists?per_page=100&page=${page}`, { signal })
      if (!Array.isArray(answer.data)) throw new GitHubError('parse', 'GitHub sent no gist list')
      const gists = answer.data.flatMap((item) => {
        try {
          return [readGist(item)]
        } catch {
          return []
        }
      })
      const link = answer.headers.get('link') ?? ''
      return { gists, hasMore: /rel="next"/.test(link) }
    },

    async getGist(id, { etag, signal } = {}) {
      const answer = await request('GET', `/gists/${encodeURIComponent(id)}`, { etag, signal })
      if (answer.status === 304) return withEtag({ notModified: true as const }, answer)
      return withEtag({ notModified: false as const, gist: readGist(answer.data) }, answer)
    },

    async createGist({ description, files }, signal) {
      const body = {
        description,
        public: false,
        files: Object.fromEntries(
          Object.entries(files).map(([name, content]) => [name, { content }]),
        ),
      }
      const answer = await request('POST', '/gists', { body, signal })
      return withEtag({ gist: readGist(answer.data) }, answer)
    },

    async updateGist(id, files, signal) {
      const body = {
        files: Object.fromEntries(
          Object.entries(files).map(([name, content]) => [
            name,
            content === null ? null : { content },
          ]),
        ),
      }
      const answer = await request('PATCH', `/gists/${encodeURIComponent(id)}`, { body, signal })
      return withEtag({ gist: readGist(answer.data) }, answer)
    },

    async deleteGist(id, signal) {
      await request('DELETE', `/gists/${encodeURIComponent(id)}`, { signal })
    },
  }
}

// --- Tokens and gist links -------------------------------------------------------------------

/**
 * A pasted token, trimmed, or `null` when it can't be one: GitHub's tokens are letters,
 * digits and underscores (`github_pat_…` for fine-grained ones, `ghp_…` for classic ones).
 */
export function normalizeToken(input: string): string | null {
  const token = input.trim()
  return /^[A-Za-z0-9_]{20,255}$/.test(token) ? token : null
}

/** The scopes of a classic token beyond `gist`, which FXM refuses to hold. */
export function extraScopes(user: GitHubUser): string[] {
  return (user.scopes ?? []).filter((scope) => scope !== 'gist')
}

/**
 * GitHub's form for a new fine-grained token, filled in: named for FXM, with only the Gists
 * permission (read and write), expiring in 90 days. GitHub documents these parameters as
 * "template URLs" (see `CLEAN-ROOM.md`).
 */
export const NEW_TOKEN_URL = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams(
  {
    name: 'FXM library sync',
    description: 'Lets FXM keep your library in step across your devices through one secret gist.',
    expires_in: '90',
    gists: 'write',
  },
)}`

/**
 * The gist ID in a pasted link or ID, or `null`: a gist's page (`gist.github.com/<user>/<id>`),
 * its API URL, or the ID itself (32 hex digits, or the numbers of an old gist).
 */
export function parseGistId(input: string): string | null {
  const text = input.trim()
  if (/^([0-9a-f]{20,40}|\d{1,12})$/i.test(text)) return text.toLowerCase()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  let candidate: string | undefined
  if (url.hostname === 'gist.github.com') candidate = segments.at(-1)
  else if (url.hostname === 'api.github.com' && segments[0] === 'gists') candidate = segments[1]
  if (candidate === undefined) return null
  return /^([0-9a-f]{20,40}|\d{1,12})$/i.test(candidate) ? candidate.toLowerCase() : null
}
