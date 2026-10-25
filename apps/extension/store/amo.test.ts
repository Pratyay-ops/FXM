import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AmoClient, AmoError, type AmoVersion, amoAuthorization, waitForReview } from './amo.ts'

const CREDENTIALS = { key: 'user:12345:67', secret: 'not-a-real-secret' }
const BASE = 'https://amo.test/api/v5/'
const GUID = 'fxm-connect@fxmusic.pages.dev'

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

interface Call {
  url: string
  init: RequestInit
}

/** A fetch that answers from a list of responses and records the requests. */
function fakeFetch(...responses: Response[]) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const response = responses.shift()
    if (!response) throw new Error(`unexpected request: ${url}`)
    return response
  }
  return { calls, fetch }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const VERSION_BODY = {
  id: 5551234,
  version: '1.2.3',
  channel: 'unlisted',
  edit_url: 'https://amo.test/developers/addon/x/versions/5551234',
  file: { id: 99, status: 'public', url: 'https://amo.test/firefox/downloads/file/99/x-1.2.3.xpi' },
}

describe('amoAuthorization', () => {
  it("is an HS256 JWT signed with the secret, valid for AMO's five minutes at most", () => {
    const header = amoAuthorization(CREDENTIALS, 1_700_000_000_000, 'nonce-1')
    expect(header.startsWith('JWT ')).toBe(true)
    const [head, payload, signature] = header.slice(4).split('.')
    expect(decode(head ?? '')).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(decode(payload ?? '')).toEqual({
      iss: CREDENTIALS.key,
      jti: 'nonce-1',
      iat: 1_700_000_000,
      exp: 1_700_000_300,
    })
    const expected = createHmac('sha256', CREDENTIALS.secret)
      .update(`${head}.${payload}`)
      .digest('base64url')
    expect(signature).toBe(expected)
  })

  it('uses a fresh nonce for every request', () => {
    const one = decode(amoAuthorization(CREDENTIALS).slice(4).split('.')[1] ?? '')
    const two = decode(amoAuthorization(CREDENTIALS).slice(4).split('.')[1] ?? '')
    expect(one.jti).not.toBe(two.jti)
  })
})

describe('AmoClient.getVersion', () => {
  it('looks the version up by number, authenticated, and reads its file', async () => {
    const { calls, fetch } = fakeFetch(json(VERSION_BODY))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.getVersion(GUID, '1.2.3')).resolves.toEqual({
      id: 5551234,
      version: '1.2.3',
      channel: 'unlisted',
      status: 'public',
      fileUrl: 'https://amo.test/firefox/downloads/file/99/x-1.2.3.xpi',
      editUrl: 'https://amo.test/developers/addon/x/versions/5551234',
    })
    expect(calls[0]?.url).toBe(
      'https://amo.test/api/v5/addons/addon/fxm-connect%40fxmusic.pages.dev/versions/1.2.3/',
    )
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^JWT [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(headers.Accept).toBe('application/json')
  })

  it('answers null when AMO has no such version or add-on', async () => {
    const { fetch } = fakeFetch(json({ detail: 'Not found.' }, 404))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.getVersion(GUID, '1.2.3')).resolves.toBeNull()
  })

  it('says to check the credentials when AMO refuses them', async () => {
    const { fetch } = fakeFetch(json({ detail: 'Signature has expired.' }, 401))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.getVersion(GUID, '1.2.3')).rejects.toThrow(
      /AMO_API_KEY and AMO_API_SECRET.*/,
    )
  })

  it('fails on other errors instead of reading them as "no version"', async () => {
    const { fetch } = fakeFetch(new Response('Bad gateway', { status: 502 }))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    const error = await client.getVersion(GUID, '1.2.3').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AmoError)
    expect((error as AmoError).status).toBe(502)
  })

  it('refuses a version number without dots, which AMO would read as an id', async () => {
    const client = new AmoClient({
      credentials: CREDENTIALS,
      baseUrl: BASE,
      fetch: fakeFetch().fetch,
    })
    await expect(client.getVersion(GUID, '123')).rejects.toThrow(/dotted/)
  })

  it('fails on an answer that is not a version', async () => {
    const { fetch } = fakeFetch(json({ hello: 'world' }))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.getVersion(GUID, '1.2.3')).rejects.toThrow(/version/)
  })
})

describe('AmoClient.download', () => {
  it('downloads a file from AMO with the token', async () => {
    const { calls, fetch } = fakeFetch(new Response(new Uint8Array([1, 2, 3])))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.download(VERSION_BODY.file.url)).resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: expect.stringMatching(/^JWT /) })
  })

  it('never sends the token to another host', async () => {
    const { calls, fetch } = fakeFetch()
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.download('https://elsewhere.test/file.xpi')).rejects.toThrow(/not on/)
    expect(calls).toHaveLength(0)
  })

  it('fails when the download does', async () => {
    const { fetch } = fakeFetch(new Response('', { status: 403 }))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.download(VERSION_BODY.file.url)).rejects.toThrow(/HTTP 403/)
  })
})

describe('waitForReview', () => {
  const version = (status: string): AmoVersion => ({
    id: 1,
    version: '1.2.3',
    channel: 'unlisted',
    status,
    fileUrl: status === 'public' ? 'https://amo.test/f.xpi' : null,
    editUrl: null,
  })

  /** A clock that advances only when the waiter sleeps. */
  function clock() {
    let time = 0
    return {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms
      },
    }
  }

  it('asks until the version is signed', async () => {
    const answers = [version('unreviewed'), version('unreviewed'), version('public')]
    const { now, sleep } = clock()
    const waits: string[] = []
    const result = await waitForReview(
      { getVersion: async () => answers.shift() ?? null },
      GUID,
      '1.2.3',
      { timeoutMs: 600_000, intervalMs: 10_000, now, sleep, onWait: (v) => waits.push(v.status) },
    )
    expect(result?.status).toBe('public')
    expect(waits).toEqual(['unreviewed', 'unreviewed'])
  })

  it('stops at a rejection', async () => {
    const { now, sleep } = clock()
    const result = await waitForReview(
      { getVersion: async () => version('disabled') },
      GUID,
      '1.2.3',
      {
        timeoutMs: 600_000,
        now,
        sleep,
      },
    )
    expect(result?.status).toBe('disabled')
  })

  it('returns the version still in review when the time is up', async () => {
    const { now, sleep } = clock()
    let looks = 0
    const result = await waitForReview(
      {
        getVersion: async () => {
          looks++
          return version('unreviewed')
        },
      },
      GUID,
      '1.2.3',
      { timeoutMs: 60_000, intervalMs: 15_000, now, sleep },
    )
    expect(result?.status).toBe('unreviewed')
    expect(looks).toBe(5)
    expect(now()).toBeLessThanOrEqual(60_000)
  })

  it('returns null when AMO has no such version', async () => {
    const { now, sleep } = clock()
    await expect(
      waitForReview({ getVersion: async () => null }, GUID, '1.2.3', {
        timeoutMs: 1000,
        now,
        sleep,
      }),
    ).resolves.toBeNull()
  })
})
