import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { isCorsSimpleRequest } from './cors'
import {
  isRequestLike,
  requestUrl,
  SIMPLE_CONTENT_TYPE,
  toSimpleInnerTubeRequest,
} from './innertube'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'

/** Every header youtubei.js or YouTube's web clients may send, plus some a page must not. */
const PREFLIGHT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer secret',
  'X-Goog-Visitor-Id': 'CgtWaXNpdG9yRGF0YQ%3D%3D',
  'X-YouTube-Client-Name': '67',
  'X-YouTube-Client-Version': '1.20261020.01.00',
  'X-Goog-Api-Format-Version': '2',
  'X-Goog-AuthUser': '0',
  'X-Origin': 'https://music.youtube.com',
  'X-YouTube-Bootstrap-Logged-In': 'false',
  'X-Browser-Validation': 'abc',
  'X-Goog-Api-Key': 'AIza-not-a-real-key',
  'User-Agent': 'Mozilla/5.0 (Apple Vision Pro)',
  Origin: 'https://music.youtube.com',
  Referer: 'https://music.youtube.com/',
  Cookie: 'VISITOR_INFO1_LIVE=x',
  'Cache-Control': 'no-cache',
  Accept: '*/*',
  'Accept-Language': '*',
}

function payload(client: Record<string, unknown> = { clientName: 'WEB_REMIX' }) {
  return JSON.stringify({ context: { client }, query: 'radiohead creep' })
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('toSimpleInnerTubeRequest', () => {
  it('turns a youtubei.js-style request into a CORS-simple POST', async () => {
    const request = new Request(`${SEARCH}?alt=json#frag`, { method: 'GET' })
    const simple = await toSimpleInnerTubeRequest(request, {
      method: 'POST',
      headers: new Headers(PREFLIGHT_HEADERS),
      body: payload({ clientName: 'WEB_REMIX', hl: 'en' }),
      credentials: 'include',
    })

    expect(simple.url).toBe(`${SEARCH}?alt=json&prettyPrint=false`)
    expect(simple.init.method).toBe('POST')
    expect(simple.init.credentials).toBe('omit')
    expect(simple.init.headers).toEqual({ 'content-type': SIMPLE_CONTENT_TYPE })
    expect(isCorsSimpleRequest(simple.init.method, Object.entries(simple.init.headers))).toBe(true)
    expect(JSON.parse(simple.init.body)).toEqual({
      context: {
        client: {
          clientName: 'WEB_REMIX',
          hl: 'en',
          visitorData: 'CgtWaXNpdG9yRGF0YQ%3D%3D',
          clientVersion: '1.20261020.01.00',
        },
      },
      query: 'radiohead creep',
    })
  })

  it.each(Object.keys(PREFLIGHT_HEADERS))(
    'lets no %s header through, whatever form the headers take',
    async (name) => {
      const value = PREFLIGHT_HEADERS[name] as string
      for (const headers of [{ [name]: value }, [[name, value]], new Headers({ [name]: value })]) {
        const simple = await toSimpleInnerTubeRequest(SEARCH, {
          method: 'POST',
          headers: headers as HeadersInit,
          body: payload(),
        })
        expect(Object.keys(simple.init.headers)).toEqual(['content-type'])
        expect(isCorsSimpleRequest('POST', Object.entries(simple.init.headers))).toBe(true)
      }
    },
  )

  it('also strips the headers of a Request that carries everything itself', async () => {
    const request = new Request(SEARCH, {
      method: 'POST',
      headers: PREFLIGHT_HEADERS,
      body: payload(),
    })
    const simple = await toSimpleInnerTubeRequest(request)
    expect(simple.init.headers).toEqual({ 'content-type': SIMPLE_CONTENT_TYPE })
    expect(JSON.parse(simple.init.body).context.client.visitorData).toBe('CgtWaXNpdG9yRGF0YQ%3D%3D')
  })

  it('keeps the payload byte for byte when nothing has to move', async () => {
    const body =
      '{"context":{"client":{"clientName":"VISIONOS","visitorData":"v"}},"n":12345678901234567890}'
    const simple = await toSimpleInnerTubeRequest(SEARCH, {
      method: 'POST',
      headers: { 'X-Goog-Visitor-Id': 'from-header' },
      body,
    })
    expect(simple.init.body).toBe(body)
  })

  it('prefers what the payload says over the headers, but fills empty fields', async () => {
    const simple = await toSimpleInnerTubeRequest(SEARCH, {
      method: 'POST',
      headers: { 'X-Goog-Visitor-Id': 'header', 'X-YouTube-Client-Version': '2.0' },
      body: payload({ clientName: 'WEB_REMIX', visitorData: '', clientVersion: '1.0' }),
    })
    expect(JSON.parse(simple.init.body).context.client).toEqual({
      clientName: 'WEB_REMIX',
      visitorData: 'header',
      clientVersion: '1.0',
    })
  })

  it('creates context.client when the payload has none', async () => {
    const simple = await toSimpleInnerTubeRequest(SEARCH, {
      method: 'POST',
      headers: { 'x-goog-visitor-id': 'v' },
      body: '{"query":"x"}',
    })
    expect(JSON.parse(simple.init.body)).toEqual({
      query: 'x',
      context: { client: { visitorData: 'v' } },
    })
  })

  it('reads JSON bodies given as bytes, a Blob or a Request body', async () => {
    const bytes = new TextEncoder().encode(payload())
    const fromBytes = await toSimpleInnerTubeRequest(SEARCH, { method: 'POST', body: bytes })
    const fromBuffer = await toSimpleInnerTubeRequest(SEARCH, {
      method: 'POST',
      body: bytes.buffer as ArrayBuffer,
    })
    const fromBlob = await toSimpleInnerTubeRequest(SEARCH, {
      method: 'POST',
      body: new Blob([payload()]),
    })
    const fromRequest = await toSimpleInnerTubeRequest(
      new Request(SEARCH, { method: 'POST', body: payload() }),
    )
    for (const simple of [fromBytes, fromBuffer, fromBlob, fromRequest]) {
      expect(simple.init.body).toBe(payload())
    }
  })

  it('replaces the Request headers with init.headers, as fetch does', async () => {
    const request = new Request(SEARCH, {
      method: 'POST',
      headers: { 'X-Goog-Visitor-Id': 'from-request' },
      body: payload(),
    })
    const simple = await toSimpleInnerTubeRequest(request, {
      headers: { 'X-Goog-Visitor-Id': 'from-init' },
    })
    expect(JSON.parse(simple.init.body).context.client.visitorData).toBe('from-init')
  })

  it('keeps the caller’s abort signal', async () => {
    const controller = new AbortController()
    const fromInit = await toSimpleInnerTubeRequest(SEARCH, {
      method: 'POST',
      body: payload(),
      signal: controller.signal,
    })
    expect(fromInit.init.signal).toBe(controller.signal)
    const request = new Request(SEARCH, {
      method: 'POST',
      body: payload(),
      signal: controller.signal,
    })
    const fromRequest = await toSimpleInnerTubeRequest(request)
    controller.abort()
    expect(fromRequest.init.signal?.aborted).toBe(true)
    const withoutSignal = await toSimpleInnerTubeRequest(SEARCH, {
      method: 'POST',
      body: payload(),
    })
    expect('signal' in withoutSignal.init).toBe(false)
  })

  it('overrides any prettyPrint value and works on every InnerTube host', async () => {
    for (const host of ['www.youtube.com', 'music.youtube.com', 'youtubei.googleapis.com']) {
      const simple = await toSimpleInnerTubeRequest(
        new URL(`https://${host}/youtubei/v1/player?prettyPrint=true&key=k`),
        { method: 'POST', body: payload() },
      )
      expect(simple.url).toBe(`https://${host}/youtubei/v1/player?prettyPrint=false&key=k`)
    }
  })

  it.each([
    ['another host', 'https://example.com/youtubei/v1/search', payload()],
    ['a YouTube page that is not the API', 'https://www.youtube.com/sw.js_data', payload()],
    ['plain HTTP', 'http://music.youtube.com/youtubei/v1/search', payload()],
    ['a body that is not JSON', SEARCH, 'query=x'],
    ['a JSON array', SEARCH, '[1,2]'],
    ['a JSON string', SEARCH, '"x"'],
    ['a context that is not an object', SEARCH, '{"context":"x"}'],
  ])('refuses %s with Unsupported', async (_case, url, body) => {
    const error = await rejection(
      toSimpleInnerTubeRequest(url, {
        method: 'POST',
        headers: { 'X-Goog-Visitor-Id': 'v' },
        body,
      }),
    )
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })

  it('refuses requests without a JSON body, such as protobuf', async () => {
    const protobuf = new Uint8Array([0x0a, 0xff, 0xfe, 0x00])
    const cases: [RequestInfo | URL, RequestInit | undefined][] = [
      [SEARCH, undefined],
      [SEARCH, { method: 'POST' }],
      [new Request(SEARCH), undefined],
      [SEARCH, { method: 'POST', body: protobuf }],
      [SEARCH, { method: 'POST', body: new URLSearchParams({ a: 'b' }) }],
      [SEARCH, { method: 'POST', body: new FormData() }],
    ]
    for (const [input, init] of cases) {
      expect(
        isFxmError(await rejection(toSimpleInnerTubeRequest(input, init)), 'Unsupported'),
      ).toBe(true)
    }
  })
})

describe('request helpers', () => {
  it('tells Requests from URLs', () => {
    expect(isRequestLike(new Request(SEARCH))).toBe(true)
    expect(isRequestLike(new URL(SEARCH))).toBe(false)
    expect(isRequestLike(SEARCH)).toBe(false)
    expect(isRequestLike(null)).toBe(false)
    expect(isRequestLike({ url: SEARCH })).toBe(false)
  })

  it('reads the URL of any fetch input', () => {
    expect(requestUrl(SEARCH)).toBe(SEARCH)
    expect(requestUrl(new URL(SEARCH))).toBe(SEARCH)
    expect(requestUrl(new Request(SEARCH))).toBe(SEARCH)
  })
})
