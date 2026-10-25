import type { Fetch } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGitHubClient,
  extraScopes,
  GITHUB_API_VERSION,
  GitHubError,
  NEW_TOKEN_URL,
  normalizeToken,
  parseGistId,
} from './github'
import { createFakeGitHub, type FakeToken } from './testing/fake-github'

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'

function setup(tokens: Record<string, FakeToken> = { [TOKEN]: { login: 'octo' } }) {
  const github = createFakeGitHub(tokens)
  return { github, client: createGitHubClient({ token: TOKEN, fetch: github.fetch }) }
}

async function failure(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitHubError) return error
    throw error
  }
  throw new Error('Expected a GitHubError')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createGitHubClient', () => {
  it('sends the token and API version to api.github.com only, without cookies or referrer', async () => {
    const { github, client } = setup()
    await client.getUser()
    const [request] = github.requests
    expect(request?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'x-github-api-version': GITHUB_API_VERSION,
    })
    expect(request?.headers).not.toHaveProperty('content-type')
    expect(request?.init).toMatchObject({
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
  })

  it('reads the user, with a classic token’s scopes', async () => {
    const fine = setup()
    expect(await fine.client.getUser()).toEqual({ login: 'octo' })
    const classic = setup({ [TOKEN]: { login: 'octo', scopes: ['gist', 'repo'] } })
    const user = await classic.client.getUser()
    expect(user).toEqual({ login: 'octo', scopes: ['gist', 'repo'] })
    expect(extraScopes(user)).toEqual(['repo'])
    expect(extraScopes({ login: 'octo', scopes: ['gist'] })).toEqual([])
  })

  it('creates a secret gist, reads it with an ETag and updates it', async () => {
    const { github, client } = setup()
    const created = await client.createGist({
      description: 'FXM',
      files: { 'a.json': '1', 'b.json': '2' },
    })
    expect(github.requests.at(-1)?.body).toEqual({
      description: 'FXM',
      public: false,
      files: { 'a.json': { content: '1' }, 'b.json': { content: '2' } },
    })
    expect(created.gist).toMatchObject({ public: false, owner: 'octo', truncated: false })
    expect(created.etag).toBeDefined()

    const read = await client.getGist(created.gist.id)
    if (read.notModified) throw new Error('Expected the gist')
    expect(read.gist.files['a.json']).toMatchObject({ content: '1', truncated: false })
    const again = await client.getGist(created.gist.id, { etag: read.etag as string })
    expect(again.notModified).toBe(true)
    expect(github.requests.at(-1)?.headers['if-none-match']).toBe(read.etag)

    const updated = await client.updateGist(created.gist.id, { 'a.json': '3', 'b.json': null })
    expect(github.requests.at(-1)?.body).toEqual({
      files: { 'a.json': { content: '3' }, 'b.json': null },
    })
    expect(Object.keys(updated.gist.files)).toEqual(['a.json'])
    expect((await client.getGist(created.gist.id, { etag: read.etag as string })).notModified).toBe(
      false,
    )

    await client.deleteGist(created.gist.id)
    expect(github.gists.size).toBe(0)
  })

  it('pages through the account’s gists', async () => {
    const { github, client } = setup()
    for (let index = 0; index < 150; index++) github.putGist('octo', { [`f${index}.json`]: 'x' })
    const first = await client.listGists(1)
    const second = await client.listGists(2)
    expect(first.gists).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    expect(second.gists).toHaveLength(50)
    expect(second.hasMore).toBe(false)
    expect(first.gists[0]?.files).not.toHaveProperty('content')
  })

  it('maps GitHub’s answers to error codes, without the token', async () => {
    const { github, client } = setup()
    const cases: [number, Record<string, string>, string, string][] = [
      [401, {}, 'Bad credentials', 'unauthorized'],
      [403, {}, 'Resource not accessible by personal access token', 'forbidden'],
      [404, {}, 'Not Found', 'not-found'],
      [422, {}, 'Validation Failed', 'invalid'],
      [500, {}, 'Oops', 'server'],
      [429, { 'retry-after': '7' }, 'Too many', 'rate-limited'],
    ]
    for (const [status, headers, message, code] of cases) {
      github.failNext('GET', '/user', status, { message }, headers)
      const error = await failure(client.getUser())
      expect(error.code).toBe(code)
      expect(error.status).toBe(status)
      expect(error.message).toContain(message)
      expect(error.message).not.toContain(TOKEN)
    }
    github.failNext('GET', '/user', 429, { message: 'Too many' }, { 'retry-after': '7' })
    expect((await failure(client.getUser())).retryAfterMs).toBe(7000)
  })

  it('reads a used-up rate limit from its reset time', async () => {
    const github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
    const client = createGitHubClient({
      token: TOKEN,
      fetch: github.fetch,
      now: () => 1_000_000_000_000,
    })
    github.failNext(
      'GET',
      '/user',
      403,
      { message: 'API rate limit exceeded' },
      {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(1_000_000_000 + 90),
      },
    )
    const error = await failure(client.getUser())
    expect(error.code).toBe('rate-limited')
    expect(error.retryAfterMs).toBe(90_000)
  })

  it('reports no answer as a network failure, and a slow one as a timeout', async () => {
    const { github, client } = setup()
    github.dropNext('GET', '/user')
    expect((await failure(client.getUser())).code).toBe('network')

    const hanging: Fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        )
      })) as Fetch
    const slow = createGitHubClient({ token: TOKEN, fetch: hanging, timeoutMs: 10 })
    expect((await failure(slow.getUser())).code).toBe('timeout')
  })

  it('passes a cancellation through as it is', async () => {
    const { client } = setup()
    const controller = new AbortController()
    controller.abort(new DOMException('Stop', 'AbortError'))
    await expect(client.getUser(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('refuses an answer it cannot read', async () => {
    const broken: Fetch = (async () => new Response('<html>', { status: 200 })) as Fetch
    const client = createGitHubClient({ token: TOKEN, fetch: broken })
    expect((await failure(client.getUser())).code).toBe('parse')
  })
})

describe('tokens and links', () => {
  it('accepts what looks like a GitHub token, trimmed', () => {
    expect(normalizeToken(`  ${TOKEN}\n`)).toBe(TOKEN)
    expect(normalizeToken('ghp_0123456789abcdefghijABCDEFGHIJ012345')).not.toBeNull()
    expect(normalizeToken('short')).toBeNull()
    expect(normalizeToken('ghp_0123456789 abcdefghijABCDEFGHIJ')).toBeNull()
    expect(normalizeToken('ghp_0123456789abcdefghij\r\nX-Evil: 1')).toBeNull()
  })

  it('reads a gist ID from its page, its API URL or the ID itself', () => {
    const id = 'aa5a315d61ae9438b18d0123456789ab'
    expect(parseGistId(id)).toBe(id)
    expect(parseGistId(` https://gist.github.com/octo/${id} `)).toBe(id)
    expect(parseGistId(`https://gist.github.com/${id}`)).toBe(id)
    expect(parseGistId(`https://api.github.com/gists/${id}`)).toBe(id)
    expect(parseGistId('https://gist.github.com/octo/1234567')).toBe('1234567')
    expect(parseGistId(`http://gist.github.com/octo/${id}`)).toBeNull()
    expect(parseGistId(`https://example.com/octo/${id}`)).toBeNull()
    expect(parseGistId('not a link')).toBeNull()
  })

  it('links to GitHub’s token form filled in with only the Gists permission', () => {
    const url = new URL(NEW_TOKEN_URL)
    expect(url.origin + url.pathname).toBe('https://github.com/settings/personal-access-tokens/new')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      name: 'FXM library sync',
      gists: 'write',
      expires_in: '90',
    })
    expect((url.searchParams.get('name') ?? '').length).toBeLessThanOrEqual(40)
  })
})
