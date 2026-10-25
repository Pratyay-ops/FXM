import { describe, expect, it } from 'vitest'
import { createZip } from '../scripts/zip.ts'
import { buildManifest } from '../src/manifest.ts'
import type { Reporter } from './actions.ts'
import {
  checkReleaseZip,
  EdgeClient,
  type EdgeOperation,
  edgeCredentials,
  operationId,
  planSubmission,
  settle,
  submitToEdge,
} from './edge.ts'

const CREDENTIALS = {
  productId: 'd34f98f5-0000-4000-8000-98707202b21d',
  clientId: 'client-1',
  apiKey: 'key-1',
}
const BASE = 'https://edge.test'
const PRODUCT = `${BASE}/v1/products/${CREDENTIALS.productId}`

interface Call {
  url: string
  init: RequestInit
}

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

const accepted = (location: string) =>
  new Response(null, { status: 202, headers: { Location: location } })
const status = (body: Partial<EdgeOperation> & { status: string }) =>
  new Response(JSON.stringify({ id: 'op', createdTime: 'now', lastUpdatedTime: 'now', ...body }))

function recorder() {
  const lines: string[] = []
  const reporter: Reporter = {
    info: (m) => lines.push(`info ${m}`),
    notice: (t, m) => lines.push(`notice ${t}: ${m}`),
    warning: (t, m) => lines.push(`warning ${t}: ${m}`),
    error: (t, m) => lines.push(`error ${t}: ${m}`),
    output: (n, v) => lines.push(`output ${n}=${v}`),
    summary: (m) => lines.push(`summary ${m}`),
  }
  return { lines, reporter }
}

describe('operationId', () => {
  it('takes the ID from a bare Location or from a URL ending with it', () => {
    expect(operationId('abc-123')).toBe('abc-123')
    expect(operationId(` ${PRODUCT}/submissions/operations/abc-123/ `)).toBe('abc-123')
    expect(() => operationId(null)).toThrow(/no operation ID/)
    expect(() => operationId('')).toThrow(/no operation ID/)
  })
})

describe('EdgeClient', () => {
  it('uploads the zip as the draft package with the v1.1 headers', async () => {
    const { calls, fetch } = fakeFetch(accepted('upload-op'))
    const client = new EdgeClient(CREDENTIALS, { baseUrl: BASE, fetch })
    const zip = new Uint8Array([0x50, 0x4b, 3, 4])
    await expect(client.uploadPackage(zip)).resolves.toBe('upload-op')
    expect(calls[0]?.url).toBe(`${PRODUCT}/submissions/draft/package`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers).toEqual({
      Authorization: 'ApiKey key-1',
      'X-ClientID': 'client-1',
      'Content-Type': 'application/zip',
    })
    expect(calls[0]?.init.body).toBe(zip)
  })

  it('checks operations and submits the draft with notes', async () => {
    const { calls, fetch } = fakeFetch(
      status({ status: 'Succeeded', message: 'Successfully updated package' }),
      accepted('publish-op'),
      status({ status: 'Failed', errorCode: 'InProgressSubmission', message: 'In review' }),
    )
    const client = new EdgeClient(CREDENTIALS, { baseUrl: BASE, fetch })
    await expect(client.uploadStatus('upload-op')).resolves.toEqual({
      status: 'Succeeded',
      message: 'Successfully updated package',
      errorCode: null,
      errors: [],
    })
    await expect(client.publish('Notes for the testers')).resolves.toBe('publish-op')
    await expect(client.publishStatus('publish-op')).resolves.toMatchObject({
      status: 'Failed',
      errorCode: 'InProgressSubmission',
    })
    expect(calls.map((call) => call.url)).toEqual([
      `${PRODUCT}/submissions/draft/package/operations/upload-op`,
      `${PRODUCT}/submissions`,
      `${PRODUCT}/submissions/operations/publish-op`,
    ])
    expect(calls[1]?.init.body).toBe(JSON.stringify({ notes: 'Notes for the testers' }))
  })

  it('says which secret to check when Edge refuses the request', async () => {
    const unauthorized = new EdgeClient(CREDENTIALS, {
      baseUrl: BASE,
      fetch: fakeFetch(new Response('', { status: 401 })).fetch,
    })
    await expect(unauthorized.uploadPackage(new Uint8Array())).rejects.toThrow(
      /HTTP 401: check EDGE_CLIENT_ID and EDGE_API_KEY/,
    )
    const unknown = new EdgeClient(CREDENTIALS, {
      baseUrl: BASE,
      fetch: fakeFetch(new Response('', { status: 404 })).fetch,
    })
    await expect(unknown.publish('notes')).rejects.toThrow(/HTTP 404: check EDGE_PRODUCT_ID/)
  })
})

describe('settle', () => {
  it('polls while the operation is in progress, up to the timeout', async () => {
    let time = 0
    const answers: EdgeOperation[] = [
      { status: 'InProgress', message: null, errorCode: null, errors: [] },
      { status: 'Succeeded', message: 'done', errorCode: null, errors: [] },
    ]
    const result = await settle(
      async () => answers.shift() ?? { status: 'X', message: null, errorCode: null, errors: [] },
      {
        intervalMs: 5000,
        timeoutMs: 60_000,
        now: () => time,
        sleep: async (ms) => {
          time += ms
        },
      },
    )
    expect(result.status).toBe('Succeeded')
    expect(time).toBe(5000)
  })
})

describe('submitToEdge', () => {
  const ok = { status: 'Succeeded', message: 'ok', errorCode: null, errors: [] }
  const fake = (upload: EdgeOperation, submission: EdgeOperation) => {
    const calls: string[] = []
    return {
      calls,
      client: {
        uploadPackage: async () => {
          calls.push('upload')
          return 'u'
        },
        uploadStatus: async () => upload,
        publish: async (notes: string) => {
          calls.push(`publish ${notes}`)
          return 'p'
        },
        publishStatus: async () => submission,
      },
    }
  }
  const instant = { sleep: async () => {}, intervalMs: 1, timeoutMs: 1 }

  it('uploads, then submits for certification', async () => {
    const { calls, client } = fake(ok, { ...ok, message: 'Successfully created submission' })
    await expect(submitToEdge(client, new Uint8Array(), 'notes', instant)).resolves.toEqual({
      outcome: 'submitted',
      detail: 'Successfully created submission',
    })
    expect(calls).toEqual(['upload', 'publish notes'])
  })

  it('stops when Edge refuses the package', async () => {
    const { calls, client } = fake(
      {
        status: 'Failed',
        message: 'Invalid package',
        errorCode: 'InvalidPackage',
        errors: ['no manifest'],
      },
      ok,
    )
    await expect(submitToEdge(client, new Uint8Array(), 'notes', instant)).rejects.toThrow(
      'Edge Add-ons refused the package: InvalidPackage: Invalid package: no manifest',
    )
    expect(calls).toEqual(['upload'])
  })

  it('reports an earlier submission still in review, and a package Edge already has', async () => {
    const inReview = fake(ok, {
      status: 'Failed',
      message: 'busy',
      errorCode: 'InProgressSubmission',
      errors: [],
    })
    await expect(
      submitToEdge(inReview.client, new Uint8Array(), 'n', instant),
    ).resolves.toMatchObject({
      outcome: 'in-review',
    })
    const same = fake(ok, {
      status: 'Failed',
      message: 'no updates',
      errorCode: 'NoModulesUpdated',
      errors: [],
    })
    await expect(submitToEdge(same.client, new Uint8Array(), 'n', instant)).resolves.toMatchObject({
      outcome: 'unchanged',
    })
  })

  it('explains that the first version must come from Partner Center', async () => {
    const { client } = fake(ok, {
      status: 'Failed',
      message: "Can't create new extension.",
      errorCode: 'CreateNotAllowed',
      errors: [],
    })
    await expect(submitToEdge(client, new Uint8Array(), 'n', instant)).rejects.toThrow(
      /first published in Partner Center/,
    )
  })

  it("reports an operation Edge hasn't finished when the wait ends", async () => {
    const busy = { status: 'InProgress', message: null, errorCode: null, errors: [] }
    const upload = fake(busy, ok)
    await expect(
      submitToEdge(upload.client, new Uint8Array(), 'n', instant),
    ).resolves.toMatchObject({
      outcome: 'pending',
    })
    expect(upload.calls).toEqual(['upload'])
    const submission = fake(ok, busy)
    await expect(
      submitToEdge(submission.client, new Uint8Array(), 'n', instant),
    ).resolves.toMatchObject({
      outcome: 'pending',
    })
  })
})

describe('checkReleaseZip', () => {
  const zip = (version: string, dev = false) =>
    createZip([
      {
        name: 'manifest.json',
        data: new TextEncoder().encode(
          JSON.stringify(buildManifest({ browser: 'chromium', version, dev })),
        ),
      },
    ])

  it('accepts the release build of the version', () => {
    expect(() => checkReleaseZip(zip('1.2.3'), '1.2.3')).not.toThrow()
  })

  it('refuses another version and the development build', () => {
    expect(() => checkReleaseZip(zip('1.2.4'), '1.2.3')).toThrow(/holds version 1.2.4/)
    expect(() => checkReleaseZip(zip('1.2.3', true), '1.2.3')).toThrow(/development build/)
    expect(() =>
      checkReleaseZip(createZip([{ name: 'x', data: new Uint8Array([1]) }]), '1.2.3'),
    ).toThrow(/no manifest.json/)
  })
})

describe('planSubmission', () => {
  it('skips with a notice when no Edge secret is set', () => {
    const { lines, reporter } = recorder()
    expect(planSubmission({}, reporter)).toBe(false)
    expect(lines).toEqual([
      expect.stringMatching(
        /^notice Edge Add-ons: EDGE_PRODUCT_ID, EDGE_CLIENT_ID, EDGE_API_KEY are not set in the stores environment/,
      ),
    ])
  })

  it('skips with a warning when only some are set', () => {
    const { lines, reporter } = recorder()
    const env = {
      EDGE_PRODUCT_ID_SET: 'true',
      EDGE_CLIENT_ID_SET: 'false',
      EDGE_API_KEY_SET: 'false',
    }
    expect(planSubmission(env, reporter)).toBe(false)
    expect(lines).toEqual([
      expect.stringMatching(/^warning Edge Add-ons: EDGE_CLIENT_ID and EDGE_API_KEY are not set/),
    ])
  })

  it('submits when all three are set, from the booleans of the plan step alone', () => {
    const { lines, reporter } = recorder()
    const env = {
      EDGE_PRODUCT_ID_SET: 'true',
      EDGE_CLIENT_ID_SET: 'true',
      EDGE_API_KEY_SET: 'true',
    }
    expect(planSubmission(env, reporter)).toBe(true)
    expect(lines).toEqual([])
  })
})

describe('edgeCredentials', () => {
  it('reads the three values of the submit step', () => {
    expect(
      edgeCredentials({ EDGE_PRODUCT_ID: ' p ', EDGE_CLIENT_ID: 'c', EDGE_API_KEY: 'k' }),
    ).toEqual({
      productId: 'p',
      clientId: 'c',
      apiKey: 'k',
    })
  })

  it('refuses to go on without all three', () => {
    expect(() => edgeCredentials({ EDGE_PRODUCT_ID: 'p', EDGE_API_KEY: ' ' })).toThrow(
      'set EDGE_CLIENT_ID, EDGE_API_KEY first',
    )
  })
})
