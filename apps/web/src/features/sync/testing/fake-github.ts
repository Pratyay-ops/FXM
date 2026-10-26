/**
 * An in-memory GitHub for sync tests: the REST endpoints FXM uses (`/user` and the gist
 * endpoints), answered the way the real API answers them (status codes, the error body, ETags
 * and 304, `X-OAuth-Scopes`, `Link` pagination, the 1 MB truncation of file contents), behind a
 * `fetch` the sync code can be given. Tests only: app code never imports it.
 *
 * @module
 */

import type { Fetch } from '@fxm/core'
import { hashHex } from '../canonical'

/** A token the fake accepts. */
export interface FakeToken {
  login: string
  /** A classic token's scopes, sent as `X-OAuth-Scopes`. Leave out for a fine-grained token. */
  scopes?: string[]
  /** Whether the token may create, change and delete gists. */
  canWriteGists?: boolean
}

/** A gist the fake holds. */
export interface FakeGist {
  id: string
  owner: string
  description: string
  public: boolean
  files: Map<string, string>
  version: number
  updatedAt: string
}

/** One request the fake received. */
export interface FakeRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
  init: RequestInit | undefined
}

/** Runs before the fake answers a request; may answer instead (a `Response`) or change state. */
export type FakeHook = (
  request: FakeRequest,
) => Response | undefined | Promise<Response | undefined>

/** How much of a file's content the API returns. */
export const FAKE_TRUNCATE_BYTES = 1024 * 1024

export interface FakeGitHub {
  /** The `fetch` to give the code under test. */
  fetch: Fetch
  gists: Map<string, FakeGist>
  requests: FakeRequest[]
  /** Requests other than reads that answered 304. */
  writes(): FakeRequest[]
  /** Adds a hook that runs before every request; returns a function that removes it. */
  hook(hook: FakeHook): () => void
  /** Answers the next request matching `method` and `path` (a prefix) with `status`. */
  failNext(
    method: string,
    path: string,
    status: number,
    body?: unknown,
    headers?: Record<string, string>,
  ): void
  /** Rejects the next matching request as a network failure. */
  dropNext(method: string, path: string): void
  /** Whether listing gists includes secret ones (fine-grained tokens may not see them). */
  listsSecretGists: boolean
  /**
   * Whether deleting a file the gist lacks is ignored instead of refused (422). GitHub doesn't
   * document which it does.
   */
  ignoresMissingDeletes: boolean
  /** Whether new gists come out public whatever the request asks: a broken API, for tests. */
  makesGistsPublic: boolean
  /** Creates a gist directly, as another device or app would. */
  putGist(
    owner: string,
    files: Record<string, string>,
    options?: { public?: boolean; description?: string },
  ): FakeGist
  /** Changes a gist's files directly. */
  editGist(id: string, files: Record<string, string | null>): void
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

function error(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json(
    status,
    { message, documentation_url: 'https://docs.github.com/rest', status: String(status) },
    headers,
  )
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** A new fake GitHub with these tokens. */
export function createFakeGitHub(
  tokens: Record<string, FakeToken>,
  { now = () => Date.UTC(2026, 9, 26, 12) }: { now?: () => number } = {},
): FakeGitHub {
  const gists = new Map<string, FakeGist>()
  const requests: FakeRequest[] = []
  const hooks: FakeHook[] = []
  let nextId = 1

  const newId = () => hashHex(`gist-${nextId++}`).padEnd(32, '0').slice(0, 32)
  // Derived from what a read returns, as GitHub's are: making a gist public changes it.
  const etagOf = (gist: FakeGist) =>
    `W/"${hashHex(`${gist.id}:${gist.version}:${gist.public}:${gist.description}`)}"`

  function view(gist: FakeGist, withContent: boolean) {
    const files: Record<string, unknown> = {}
    for (const [name, content] of [...gist.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const size = bytes(content)
      const file: Record<string, unknown> = {
        filename: name,
        type: 'application/json',
        language: 'JSON',
        raw_url: `https://gist.githubusercontent.com/${gist.owner}/${gist.id}/raw/${name}`,
        size,
      }
      if (withContent) {
        const truncated = size > FAKE_TRUNCATE_BYTES
        file.truncated = truncated
        file.content = truncated ? content.slice(0, FAKE_TRUNCATE_BYTES / 4) : content
      }
      files[name] = file
    }
    return {
      url: `https://api.github.com/gists/${gist.id}`,
      id: gist.id,
      html_url: `https://gist.github.com/${gist.owner}/${gist.id}`,
      description: gist.description,
      public: gist.public,
      owner: { login: gist.owner },
      updated_at: gist.updatedAt,
      created_at: gist.updatedAt,
      files,
      truncated: false,
    }
  }

  function create(
    owner: string,
    files: Record<string, string>,
    isPublic: boolean,
    description: string,
  ) {
    const gist: FakeGist = {
      id: newId(),
      owner,
      description,
      public: isPublic,
      files: new Map(Object.entries(files)),
      version: 1,
      updatedAt: new Date(now()).toISOString(),
    }
    gists.set(gist.id, gist)
    return gist
  }

  function edit(gist: FakeGist, files: Record<string, string | null>) {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) gist.files.delete(name)
      else gist.files.set(name, content)
    }
    gist.version++
    gist.updatedAt = new Date(now()).toISOString()
  }

  async function handle(request: FakeRequest): Promise<Response> {
    for (const hook of [...hooks]) {
      const answer = await hook(request)
      if (answer !== undefined) return answer
    }
    const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')
    const token = auth ? tokens[auth[1] as string] : undefined
    if (token === undefined) return error(401, 'Bad credentials')
    const scopeHeaders: Record<string, string> =
      token.scopes === undefined ? {} : { 'x-oauth-scopes': token.scopes.join(', ') }
    const url = new URL(request.path, 'https://api.github.com')
    const parts = url.pathname.split('/').filter((part) => part !== '')
    const canWrite = token.canWriteGists ?? true

    if (request.method === 'GET' && url.pathname === '/user') {
      return json(200, { login: token.login, id: 1, type: 'User' }, scopeHeaders)
    }
    if (parts[0] !== 'gists') return error(404, 'Not Found')

    if (parts.length === 1 && request.method === 'GET') {
      const perPage = Number(url.searchParams.get('per_page') ?? 30)
      const page = Number(url.searchParams.get('page') ?? 1)
      const mine = [...gists.values()]
        .filter((gist) => gist.owner === token.login && (gist.public || fake.listsSecretGists))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      const slice = mine.slice((page - 1) * perPage, page * perPage)
      const more = page * perPage < mine.length
      const link = more
        ? {
            link: `<https://api.github.com/gists?per_page=${perPage}&page=${page + 1}>; rel="next"`,
          }
        : {}
      return json(
        200,
        slice.map((gist) => view(gist, false)),
        { ...scopeHeaders, ...link },
      )
    }
    if (parts.length === 1 && request.method === 'POST') {
      if (!canWrite) return error(403, 'Resource not accessible by personal access token')
      const body = request.body as {
        description?: string
        public?: boolean
        files?: Record<string, { content?: string }>
      }
      const files: Record<string, string> = {}
      for (const [name, file] of Object.entries(body.files ?? {})) {
        if (typeof file?.content !== 'string' || file.content === '') {
          return error(422, 'Validation Failed')
        }
        files[name] = file.content
      }
      if (Object.keys(files).length === 0) return error(422, 'Validation Failed')
      const gist = create(
        token.login,
        files,
        body.public === true || fake.makesGistsPublic,
        body.description ?? '',
      )
      return json(201, view(gist, true), { etag: etagOf(gist) })
    }

    const gist = gists.get(parts[1] ?? '')
    if (gist === undefined) return error(404, 'Not Found')
    if (request.method === 'GET') {
      // Secret gists are readable by anyone with the ID.
      const etag = etagOf(gist)
      if (request.headers['if-none-match'] === etag) {
        return new Response(null, { status: 304, headers: { etag } })
      }
      return json(200, view(gist, true), { etag })
    }
    if (gist.owner !== token.login || !canWrite) return error(404, 'Not Found')
    if (request.method === 'PATCH') {
      const body = request.body as { files?: Record<string, { content?: string } | null> }
      const changes: Record<string, string | null> = {}
      for (const [name, file] of Object.entries(body.files ?? {})) {
        if (file === null) {
          if (gist.files.has(name)) changes[name] = null
          else if (!fake.ignoresMissingDeletes) return error(422, 'Validation Failed')
        } else if (typeof file.content === 'string' && file.content !== '') {
          changes[name] = file.content
        } else {
          return error(422, 'Validation Failed')
        }
      }
      const remaining = new Set(gist.files.keys())
      for (const [name, content] of Object.entries(changes)) {
        if (content === null) remaining.delete(name)
        else remaining.add(name)
      }
      if (remaining.size === 0) return error(422, 'Validation Failed')
      edit(gist, changes)
      return json(200, view(gist, true), { etag: etagOf(gist) })
    }
    if (request.method === 'DELETE') {
      gists.delete(gist.id)
      return new Response(null, { status: 204 })
    }
    return error(404, 'Not Found')
  }

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.github.com') throw new TypeError(`Unexpected host ${url.host}`)
    const headers: Record<string, string> = {}
    // Lower-cased as browsers do (happy-dom keeps the case it was given).
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    if (init?.signal?.aborted) throw init.signal.reason
    const request: FakeRequest = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      init,
    }
    requests.push(request)
    return handle(request)
  }) as Fetch

  const fake: FakeGitHub = {
    fetch,
    gists,
    requests,
    listsSecretGists: true,
    ignoresMissingDeletes: false,
    makesGistsPublic: false,
    writes: () => requests.filter((request) => request.method !== 'GET'),
    hook(hook) {
      hooks.push(hook)
      return () => {
        const index = hooks.indexOf(hook)
        if (index >= 0) hooks.splice(index, 1)
      }
    },
    failNext(method, path, status, body, headers) {
      const remove = fake.hook((request) => {
        if (request.method !== method || !request.path.startsWith(path)) return undefined
        remove()
        return body === undefined ? error(status, 'Failure', headers) : json(status, body, headers)
      })
    },
    dropNext(method, path) {
      const remove = fake.hook((request) => {
        if (request.method !== method || !request.path.startsWith(path)) return undefined
        remove()
        throw new TypeError('Failed to fetch')
      })
    },
    putGist(owner, files, options = {}) {
      return create(owner, files, options.public ?? false, options.description ?? '')
    },
    editGist(id, files) {
      const gist = gists.get(id)
      if (gist === undefined) throw new Error(`No gist ${id}`)
      edit(gist, files)
    },
  }
  return fake
}
