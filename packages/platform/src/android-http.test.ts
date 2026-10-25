import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  androidHttpIfAvailable,
  createAndroidHttp,
  decodeBase64,
  encodeBase64,
  FXM_HTTP_ERROR_CODES,
  FXM_HTTP_MAX_READ_BYTES,
  FXM_HTTP_READ_BYTES,
  type FxmHttpPlugin,
  findFxmHttpPlugin,
  fxmHttpErrorCode,
} from './android-http'
import { createRequestBudget } from './budget'
import { createCapacitorTransport } from './capacitor'
import { SIMPLE_CONTENT_TYPE } from './innertube'
import type { NativeRequestInit } from './native'
import { createPlatform } from './platform'
import { memoryStorage } from './storage'
import { createFakeFxmHttp, fxmHttpError } from './testing'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false'
const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'x' })
const AGENT = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0'

function init(overrides: Partial<NativeRequestInit> = {}): NativeRequestInit {
  return { method: 'GET', headers: { origin: '' }, ...overrides }
}

/** A body that sends `first`, then waits for `release()` before sending `rest`. */
function gatedBody(first: Uint8Array, rest: Uint8Array) {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(first)
      await released
      controller.enqueue(rest)
      controller.close()
    },
  })
  return { stream, release }
}

function bytesOf(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  let state = seed
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('findFxmHttpPlugin', () => {
  const plugin = createFakeFxmHttp()

  it('finds the plugin only in the Android app, with all its methods', () => {
    const native = { Capacitor: { isNativePlatform: () => true, Plugins: { FxmHttp: plugin } } }
    expect(findFxmHttpPlugin(native)).toBe(plugin)
    expect(androidHttpIfAvailable(native)).toBeTypeOf('function')
    expect(findFxmHttpPlugin({})).toBeUndefined()
    expect(androidHttpIfAvailable({})).toBeUndefined()
    const web = { Capacitor: { isNativePlatform: () => false, Plugins: { FxmHttp: plugin } } }
    expect(findFxmHttpPlugin(web)).toBeUndefined()
    const partial = {
      Capacitor: { isNativePlatform: () => true, Plugins: { FxmHttp: { request() {} } } },
    }
    expect(findFxmHttpPlugin(partial)).toBeUndefined()
    const none = { Capacitor: { isNativePlatform: () => true, Plugins: {} } }
    expect(findFxmHttpPlugin(none)).toBeUndefined()
  })

  it('makes createAndroidHttp refuse to start without it', () => {
    let error: unknown
    try {
      createAndroidHttp()
    } catch (caught) {
      error = caught
    }
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })
})

describe('createAndroidHttp', () => {
  it('sends exactly the headers it is given, text bodies as UTF-8', async () => {
    const plugin = createFakeFxmHttp()
    const http = createAndroidHttp({ plugin })
    const headers = { 'content-type': SIMPLE_CONTENT_TYPE, origin: '', 'user-agent': AGENT }
    await http(SEARCH, init({ method: 'POST', headers, body: BODY, redirect: 'manual' }))
    expect(plugin.requests).toHaveLength(1)
    const [request] = plugin.requests
    expect(request).toMatchObject({
      url: SEARCH,
      method: 'POST',
      headers,
      body: BODY,
      bodyEncoding: 'utf8',
      redirect: 'manual',
    })
    expect(request?.id).toMatch(/^[A-Za-z0-9._:-]{1,100}$/)
  })

  it('sends binary bodies as base64, byte for byte', async () => {
    const plugin = createFakeFxmHttp()
    const bytes = new Uint8Array(256).map((_, index) => index)
    await createAndroidHttp({ plugin })(
      'https://lrclib.net/x',
      init({ method: 'POST', body: bytes }),
    )
    const [request] = plugin.requests
    expect(request?.bodyEncoding).toBe('base64')
    expect([...decodeBase64(request?.body ?? '')]).toEqual([...bytes])
  })

  it('gives every request its own id', async () => {
    const plugin = createFakeFxmHttp()
    const http = createAndroidHttp({ plugin })
    await Promise.all([http(SEARCH, init()), http(SEARCH, init()), http(SEARCH, init())])
    expect(new Set(plugin.requests.map((request) => request.id)).size).toBe(3)
  })

  it('resolves at the headers and streams the body as it comes', async () => {
    const first = new TextEncoder().encode('first ')
    const rest = new TextEncoder().encode('and the rest')
    const { stream, release } = gatedBody(first, rest)
    const plugin = createFakeFxmHttp({
      respond: () =>
        new Response(stream, { status: 206, headers: { 'content-range': 'bytes 0-1/2' } }),
    })
    const response = await createAndroidHttp({ plugin })(SEARCH, init())
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-1/2')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first ')
    expect(plugin.reads).toHaveLength(1)
    release()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('and the rest')
    expect((await reader.read()).done).toBe(true)
    expect(plugin.open).toEqual([])
  })

  it('reads binary bodies byte for byte, in chunks of the size it asks for', async () => {
    const bytes = bytesOf(700_000)
    const plugin = createFakeFxmHttp({ respond: () => new Response(bytes) })
    const response = await createAndroidHttp({ plugin, readBytes: 100_000 })(SEARCH, init())
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(plugin.reads.every((read) => read.maxBytes === 100_000)).toBe(true)
  })

  it('keeps the read size within the plugin’s limit', async () => {
    const plugin = createFakeFxmHttp({ respond: () => new Response('x') })
    await (await createAndroidHttp({ plugin, readBytes: 1e9 })(SEARCH, init())).text()
    await (await createAndroidHttp({ plugin })(SEARCH, init())).text()
    expect(plugin.reads.map((read) => read.maxBytes)).toEqual([
      FXM_HTTP_MAX_READ_BYTES,
      FXM_HTTP_MAX_READ_BYTES,
      FXM_HTTP_READ_BYTES,
      FXM_HTTP_READ_BYTES,
    ])
  })

  it('has no body for HEAD and for 204, 205 and 304, and never reads one', async () => {
    const plugin = createFakeFxmHttp({
      respond: (request) =>
        new Response(request.url.endsWith('204') ? null : 'ignored', {
          status: request.url.endsWith('204') ? 204 : 200,
        }),
    })
    const http = createAndroidHttp({ plugin })
    const head = await http('https://lrclib.net/a', init({ method: 'HEAD' }))
    expect(head.body).toBeNull()
    const empty = await http('https://lrclib.net/204', init())
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
    expect(plugin.reads).toEqual([])
  })

  it('sets url and redirected from the plugin', async () => {
    const plugin: FxmHttpPlugin = {
      ...createFakeFxmHttp(),
      request: async (request) => ({
        id: request.id,
        status: 200,
        statusText: 'OK',
        url: 'https://rr5---sn-y.googlevideo.com/videoplayback',
        redirected: true,
        headers: [['content-type', 'audio/webm']],
        body: false,
      }),
    }
    const response = await createAndroidHttp({ plugin })(
      'https://rr1---sn-x.googlevideo.com/videoplayback',
      init(),
    )
    expect(response.url).toBe('https://rr5---sn-y.googlevideo.com/videoplayback')
    expect(response.redirected).toBe(true)
    expect(response.statusText).toBe('OK')
  })

  it('skips header values Headers refuses and survives an odd reason phrase', async () => {
    const plugin: FxmHttpPlugin = {
      ...createFakeFxmHttp(),
      request: async (request) => ({
        id: request.id,
        status: 200,
        statusText: 'Bad\nPhrase',
        url: request.url,
        redirected: false,
        headers: [
          ['x-ok', 'yes'],
          ['x-wide', 'naïve ☃'],
        ],
        body: false,
      }),
    }
    const response = await createAndroidHttp({ plugin })(SEARCH, init())
    expect(response.headers.get('x-ok')).toBe('yes')
    expect(response.headers.has('x-wide')).toBe(false)
    expect(response.statusText).toBe('')
  })

  it('rejects a status Response cannot carry and drops the native response', async () => {
    const plugin: FxmHttpPlugin = {
      ...createFakeFxmHttp(),
      request: async (request) => ({
        id: request.id,
        status: 101,
        statusText: '',
        url: request.url,
        redirected: false,
        headers: [],
        body: true,
      }),
      abort: vi.fn(async () => {}),
    }
    expect(await rejection(createAndroidHttp({ plugin })(SEARCH, init()))).toBeInstanceOf(TypeError)
    expect(plugin.abort).toHaveBeenCalledOnce()
  })
})

describe('aborts', () => {
  it('reject at once, without asking the plugin, when the signal is already aborted', async () => {
    const plugin = createFakeFxmHttp()
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const error = await rejection(
      createAndroidHttp({ plugin })(SEARCH, init({ signal: controller.signal })),
    )
    expect((error as Error).message).toBe('stop')
    expect(plugin.requests).toEqual([])
  })

  it('reject a pending request with the signal’s reason and cancel the native call', async () => {
    let answer = (_: Response) => {}
    const plugin = createFakeFxmHttp({
      respond: () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        }),
    })
    const controller = new AbortController()
    const pending = createAndroidHttp({ plugin })(SEARCH, init({ signal: controller.signal }))
    await vi.waitFor(() => expect(plugin.requests).toHaveLength(1))
    controller.abort()
    const error = await rejection(pending)
    expect((error as DOMException).name).toBe('AbortError')
    expect(plugin.aborts).toEqual([plugin.requests[0]?.id])
    answer(new Response('late')) // The plugin's late rejection is handled, not unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('error a streaming body with the reason and drop the native response', async () => {
    const { stream } = gatedBody(new Uint8Array([1]), new Uint8Array([2]))
    const plugin = createFakeFxmHttp({ respond: () => new Response(stream) })
    const controller = new AbortController()
    const response = await createAndroidHttp({ plugin })(
      SEARCH,
      init({ signal: controller.signal }),
    )
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1]))
    controller.abort(new Error('user left'))
    expect(((await rejection(reader.read())) as Error).message).toBe('user left')
    expect(plugin.aborts).toHaveLength(1)
    expect(plugin.open).toEqual([])
  })

  it('cancelling the body drops the native response', async () => {
    const { stream } = gatedBody(new Uint8Array([1]), new Uint8Array([2]))
    const plugin = createFakeFxmHttp({ respond: () => new Response(stream) })
    const response = await createAndroidHttp({ plugin })(SEARCH, init())
    await response.body?.cancel()
    expect(plugin.aborts).toHaveLength(1)
    expect(plugin.open).toEqual([])
  })
})

describe('errors', () => {
  it('turn refusals by FXM’s network rules into Unsupported FxmErrors', async () => {
    for (const code of ['HOST_NOT_ALLOWED', 'HEADER_NOT_ALLOWED', 'METHOD_NOT_ALLOWED'] as const) {
      const plugin = createFakeFxmHttp({
        respond: () => {
          throw fxmHttpError(code, `refused: ${code}`)
        },
      })
      const error = await rejection(createAndroidHttp({ plugin })(SEARCH, init()))
      expect(isFxmError(error, 'Unsupported')).toBe(true)
      expect((error as Error).message).toBe(`refused: ${code}`)
    }
  })

  it('turn everything else into TypeErrors, as fetch does, keeping the cause', async () => {
    for (const code of ['NETWORK', 'TIMEOUT', 'BAD_REQUEST', 'REDIRECT', 'BUSY'] as const) {
      const cause = fxmHttpError(code, 'Could not reach music.youtube.com')
      const plugin = createFakeFxmHttp({
        respond: () => {
          throw cause
        },
      })
      const error = await rejection(createAndroidHttp({ plugin })(SEARCH, init()))
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).cause).toBe(cause)
      expect(fxmHttpErrorCode((error as Error).cause)).toBe(code)
    }
    const plain = createFakeFxmHttp({
      respond: () => {
        throw new Error('')
      },
    })
    expect(await rejection(createAndroidHttp({ plugin: plain })(SEARCH, init()))).toBeInstanceOf(
      TypeError,
    )
  })

  it('error the body when it breaks off', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
      },
      pull(controller) {
        controller.error(new Error('reset'))
      },
    })
    const plugin = createFakeFxmHttp({ respond: () => new Response(stream) })
    const response = await createAndroidHttp({ plugin })(SEARCH, init())
    const error = await rejection(response.arrayBuffer())
    expect(error).toBeInstanceOf(TypeError)
    expect(fxmHttpErrorCode((error as Error).cause)).toBe('NETWORK')
  })

  it('error the body and drop the native response when a chunk cannot be decoded', async () => {
    const fake = createFakeFxmHttp({ respond: () => new Response('x') })
    const plugin: FxmHttpPlugin = { ...fake, read: async () => ({ data: '%%%', done: false }) }
    const response = await createAndroidHttp({ plugin })(SEARCH, init())
    expect(await rejection(response.text())).toBeInstanceOf(TypeError)
    expect(fake.aborts).toHaveLength(1)
  })

  it('know every code the native plugin uses', () => {
    expect(fxmHttpErrorCode({ code: 'HOST_NOT_APPROVED' })).toBe('HOST_NOT_APPROVED')
    expect(fxmHttpErrorCode({ code: 'SOMETHING_ELSE' })).toBeUndefined()
    expect(fxmHttpErrorCode(null)).toBeUndefined()
    expect(new Set(FXM_HTTP_ERROR_CODES).size).toBe(FXM_HTTP_ERROR_CODES.length)
  })
})

describe('hosts the user added', () => {
  const INVIDIOUS = 'https://invidious.example.org/api/v1/stats'

  it('ask the user once, then retry the request', async () => {
    const plugin = createFakeFxmHttp()
    const http = createAndroidHttp({ plugin })
    const [first, second] = await Promise.all([http(INVIDIOUS, init()), http(INVIDIOUS, init())])
    expect([first.status, second.status]).toEqual([200, 200])
    expect(plugin.questions).toEqual([['invidious.example.org']])
    expect(plugin.requests).toHaveLength(4)
    await http(INVIDIOUS, init())
    expect(plugin.questions).toHaveLength(1)
  })

  it('fail with Unsupported when the user does not allow the host', async () => {
    const plugin = createFakeFxmHttp({ answer: () => false })
    const error = await rejection(createAndroidHttp({ plugin })(INVIDIOUS, init()))
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    expect((error as Error).message).toContain('invidious.example.org')
  })

  it('fail with Unsupported when the user cannot be asked', async () => {
    const plugin: FxmHttpPlugin = {
      ...createFakeFxmHttp(),
      approveHosts: async () => {
        throw fxmHttpError('NO_ACTIVITY')
      },
    }
    expect(
      isFxmError(await rejection(createAndroidHttp({ plugin })(INVIDIOUS, init())), 'Unsupported'),
    ).toBe(true)
  })

  it('are not asked about when asking is off', async () => {
    const plugin = createFakeFxmHttp()
    const error = await rejection(
      createAndroidHttp({ plugin, askToApproveHosts: false })(INVIDIOUS, init()),
    )
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    expect(plugin.questions).toEqual([])
  })

  it('stop waiting for the answer when the request is aborted', async () => {
    const plugin = createFakeFxmHttp({ answer: () => new Promise<boolean>(() => {}) })
    const controller = new AbortController()
    const pending = createAndroidHttp({ plugin })(INVIDIOUS, init({ signal: controller.signal }))
    await vi.waitFor(() => expect(plugin.questions).toHaveLength(1))
    controller.abort()
    expect(((await rejection(pending)) as DOMException).name).toBe('AbortError')
  })

  it('can be approved, listed and revoked for Settings', async () => {
    const plugin = createFakeFxmHttp({ approved: ['known.example.org'] })
    const http = createAndroidHttp({ plugin })
    expect(await http.approveHosts(['known.example.org', 'new.example.org'])).toEqual([
      'known.example.org',
      'new.example.org',
    ])
    expect(plugin.questions).toEqual([['new.example.org']])
    expect(await http.approvedHosts()).toEqual(['known.example.org', 'new.example.org'])
    expect(await http.revokeHosts(new Set(['known.example.org']))).toEqual(['new.example.org'])
  })
})

describe('base64', () => {
  it('round-trips every byte value and large bodies', () => {
    const every = new Uint8Array(256).map((_, index) => index)
    expect(decodeBase64(encodeBase64(every))).toEqual(every)
    const large = bytesOf(200_000, 7)
    expect(decodeBase64(encodeBase64(large))).toEqual(large)
    expect(encodeBase64(new Uint8Array([0xff, 0xfe, 0x00]))).toBe('//4A')
  })
})

describe('the Android transport over the plugin', () => {
  it('keeps the InnerTube shape and the native header policy, and draws from the budget', async () => {
    const plugin = createFakeFxmHttp()
    const budget = createRequestBudget()
    const transport = createCapacitorTransport({
      http: createAndroidHttp({ plugin }),
      budget,
      userAgent: AGENT,
    })
    await transport.fetch('https://music.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Visitor-Id': 'v',
        Origin: 'https://localhost',
      },
      body: BODY,
    })
    await transport.fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: '{}',
    })
    const [innerTube, spotify] = plugin.requests
    expect(innerTube?.url).toBe(SEARCH)
    expect(innerTube?.headers).toEqual({
      'content-type': SIMPLE_CONTENT_TYPE,
      origin: '',
      'user-agent': AGENT,
    })
    expect(JSON.parse(innerTube?.body ?? '{}').context.client.visitorData).toBe('v')
    expect(spotify?.headers).toEqual({
      authorization: 'Bearer t',
      'content-type': 'application/json',
      origin: 'https://open.spotify.com',
      'user-agent': AGENT,
    })
    expect(budget.snapshot().used).toBe(1)
  })

  it('still reports a LOGIN_REQUIRED player response to the budget from a streamed body', async () => {
    const plugin = createFakeFxmHttp({
      respond: () => Response.json({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }),
    })
    const budget = createRequestBudget()
    const report = vi.spyOn(budget, 'reportBotCheck')
    const transport = createCapacitorTransport({ http: createAndroidHttp({ plugin }), budget })
    const response = await transport.fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      body: BODY,
    })
    expect(report).toHaveBeenCalledWith('login-required')
    expect((await response.json()).playabilityStatus.status).toBe('LOGIN_REQUIRED')
  })
})

describe('createPlatform in the Android app', () => {
  it('uses the FxmHttp plugin when the app has it: full access', async () => {
    const plugin = createFakeFxmHttp()
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, Plugins: { FxmHttp: plugin } })
    const platform = await createPlatform({ environment: 'capacitor', storage: memoryStorage() })
    expect(platform.capabilities.current).toEqual({
      youtube: 'full',
      mediaBytes: true,
      spotify: 'anonymous',
      fileSystem: true,
    })
    await platform.transport.fetch('https://music.youtube.com/youtubei/v1/search', {
      method: 'POST',
      body: BODY,
    })
    expect(plugin.requests).toHaveLength(1)
    platform.dispose()
  })

  it('prefers the native HTTP it is given', async () => {
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => true,
      Plugins: { FxmHttp: createFakeFxmHttp() },
    })
    const http = vi.fn(async () => Response.json({}))
    const platform = await createPlatform({
      environment: 'capacitor',
      nativeHttp: http,
      storage: memoryStorage(),
    })
    await platform.transport.fetch('https://lrclib.net/api/get')
    expect(http).toHaveBeenCalledOnce()
    platform.dispose()
  })
})
