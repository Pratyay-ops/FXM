import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AmoClient,
  AmoError,
  type AmoVersion,
  amoAuthorization,
  isTransient,
  waitForReview,
  waitForValidation,
} from './amo.ts'
import { amoMetadata } from './listing.ts'

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
      hasSource: null,
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
    hasSource: true,
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

describe('AmoClient.getVersion and the source code', () => {
  it('tells whether the version has its source code, when AMO says', async () => {
    const { fetch } = fakeFetch(
      json({ ...VERSION_BODY, source: 'https://amo.test/source/1.zip' }),
      json({ ...VERSION_BODY, source: null }),
    )
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.getVersion(GUID, '1.2.3')).resolves.toMatchObject({ hasSource: true })
    await expect(client.getVersion(GUID, '1.2.3')).resolves.toMatchObject({ hasSource: false })
  })
})

describe('AmoClient.upload and uploadStatus', () => {
  const ZIP = new Uint8Array([0x50, 0x4b, 5, 6])

  it('posts the file as multipart form data with the channel, under a name AMO accepts', async () => {
    const { calls, fetch } = fakeFetch(json({ uuid: 'abc-123', processed: false }, 201))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.upload(ZIP, 'fxm-connect-firefox-1.2.3.zip', 'unlisted')).resolves.toBe(
      'abc-123',
    )
    const { url, init } = calls[0] ?? { url: '', init: {} }
    expect(url).toBe('https://amo.test/api/v5/addons/upload/')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ Authorization: expect.stringMatching(/^JWT /) })
    expect(init.headers).not.toHaveProperty('Content-Type')
    const form = init.body as FormData
    expect(form.get('channel')).toBe('unlisted')
    const file = form.get('upload') as File
    expect(file.name).toBe('fxm-connect-firefox-1.2.3.zip')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(ZIP)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("reads the validator's progress and its errors", async () => {
    const { calls, fetch } = fakeFetch(
      json({ uuid: 'abc-123', processed: false, valid: false, validation: null }),
      json({
        uuid: 'abc-123',
        processed: true,
        valid: false,
        validation: {
          errors: 1,
          messages: [
            { type: 'error', message: 'The manifest is broken.', file: 'manifest.json' },
            { type: 'warning', message: 'Just a warning.' },
            { type: 'error', message: 'Another problem.' },
          ],
        },
      }),
    )
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.uploadStatus('abc-123')).resolves.toEqual({
      uuid: 'abc-123',
      processed: false,
      valid: false,
      errors: [],
    })
    await expect(client.uploadStatus('abc-123')).resolves.toEqual({
      uuid: 'abc-123',
      processed: true,
      valid: false,
      errors: ['The manifest is broken. (manifest.json)', 'Another problem.'],
    })
    expect(calls[0]?.url).toBe('https://amo.test/api/v5/addons/upload/abc-123/')
  })

  it('refuses an answer without a usable uuid', async () => {
    const { fetch } = fakeFetch(json({ uuid: '../../elsewhere' }))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(client.upload(ZIP, 'a.zip', 'listed')).rejects.toThrow(/without a valid uuid/)
  })
})

describe('AmoClient.submitVersion', () => {
  it('puts the upload and the metadata to the add-on, as one JSON body', async () => {
    const { calls, fetch } = fakeFetch(
      json(
        {
          guid: GUID,
          version: { ...VERSION_BODY, channel: 'listed', file: { status: 'unreviewed' } },
        },
        201,
      ),
    )
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    const metadata = amoMetadata('listed', '1.2.3', 'abc1234')
    await expect(client.submitVersion(GUID, 'abc-123', metadata)).resolves.toMatchObject({
      id: 5551234,
      channel: 'listed',
      status: 'unreviewed',
      fileUrl: null,
    })
    const { url, init } = calls[0] ?? { url: '', init: {} }
    expect(url).toBe('https://amo.test/api/v5/addons/addon/fxm-connect%40fxmusic.pages.dev/')
    expect(init.method).toBe('PUT')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({
      ...metadata,
      version: { upload: 'abc-123', ...metadata.version },
    })
  })

  it('explains a version number AMO already has', async () => {
    const { fetch } = fakeFetch(json({ version: ['Version 1.2.3 already exists.'] }, 409))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(
      client.submitVersion(GUID, 'abc-123', amoMetadata('unlisted', '1.2.3')),
    ).rejects.toThrow(/HTTP 409.*each version number once/s)
  })
})

describe('AmoClient.uploadSource', () => {
  it('patches the version with the source code, as multipart form data', async () => {
    const { calls, fetch } = fakeFetch(json(VERSION_BODY))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await client.uploadSource(GUID, 5551234, new Uint8Array([1, 2, 3]), 'fxm-1.2.3-source.zip')
    const { url, init } = calls[0] ?? { url: '', init: {} }
    expect(url).toBe(
      'https://amo.test/api/v5/addons/addon/fxm-connect%40fxmusic.pages.dev/versions/5551234/',
    )
    expect(init.method).toBe('PATCH')
    const file = (init.body as FormData).get('source') as File
    expect(file.name).toBe('fxm-1.2.3-source.zip')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('fails with what AMO said', async () => {
    const { fetch } = fakeFetch(json({ source: ['Unsupported file type.'] }, 400))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(
      client.uploadSource(GUID, 1, new Uint8Array([1]), 'fxm-1.2.3-source.zip'),
    ).rejects.toThrow(/HTTP 400: .*Unsupported file type/)
  })

  it('says to check the credentials when AMO refuses them', async () => {
    const { fetch } = fakeFetch(json({ detail: 'You do not own this add-on.' }, 403))
    const client = new AmoClient({ credentials: CREDENTIALS, baseUrl: BASE, fetch })
    await expect(
      client.uploadSource(GUID, 1, new Uint8Array([1]), 'fxm-1.2.3-source.zip'),
    ).rejects.toThrow(/AMO_API_KEY and AMO_API_SECRET/)
  })
})

describe('isTransient', () => {
  it('asks again after an overloaded AMO or a network failure, never after a refusal', () => {
    expect(isTransient(new AmoError('x', 502))).toBe(true)
    expect(isTransient(new AmoError('x', 429))).toBe(true)
    expect(isTransient(new TypeError('fetch failed'))).toBe(true)
    expect(isTransient(new DOMException('slow', 'TimeoutError'))).toBe(true)
    expect(isTransient(new AmoError('x', 401))).toBe(false)
    expect(isTransient(new AmoError('AMO sent no version object'))).toBe(false)
  })
})

describe('waiting through transient failures', () => {
  function clock() {
    let time = 0
    return {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms
      },
    }
  }
  const signed: AmoVersion = {
    id: 1,
    version: '1.2.3',
    channel: 'unlisted',
    status: 'public',
    fileUrl: 'https://amo.test/f.xpi',
    editUrl: null,
    hasSource: true,
  }

  it('asks again after a 502, up to three times in a row', async () => {
    const answers: (AmoVersion | Error)[] = [new AmoError('bad gateway', 502), signed]
    const getVersion = async () => {
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      return answer ?? null
    }
    await expect(
      waitForReview({ getVersion }, GUID, '1.2.3', { timeoutMs: 600_000, ...clock() }),
    ).resolves.toEqual(signed)

    const down = async () => {
      throw new AmoError('bad gateway', 502)
    }
    await expect(
      waitForReview({ getVersion: down }, GUID, '1.2.3', { timeoutMs: 600_000, ...clock() }),
    ).rejects.toThrow('bad gateway')
  })

  it('stops at once on a failure that asking again would not fix', async () => {
    let looks = 0
    const refused = async () => {
      looks++
      throw new AmoError('refused', 401)
    }
    await expect(
      waitForReview({ getVersion: refused }, GUID, '1.2.3', { timeoutMs: 600_000, ...clock() }),
    ).rejects.toThrow('refused')
    expect(looks).toBe(1)
  })

  it('waits for the validator to finish', async () => {
    const answers = [
      { uuid: 'u', processed: false, valid: false, errors: [] },
      { uuid: 'u', processed: true, valid: true, errors: [] },
    ]
    const result = await waitForValidation(
      {
        uploadStatus: async () =>
          answers.shift() ?? { uuid: 'u', processed: false, valid: false, errors: [] },
      },
      'u',
      { timeoutMs: 600_000, intervalMs: 1000, ...clock() },
    )
    expect(result).toEqual({ uuid: 'u', processed: true, valid: true, errors: [] })
  })
})
