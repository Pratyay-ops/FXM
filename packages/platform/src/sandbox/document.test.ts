import { describe, expect, it, vi } from 'vitest'
import { isCorsSafelistedRequestHeader } from '../cors'
import { HOST_RULES } from '../hosts'
import { createFakeClock, type FakeClock } from '../testing/fake-clock'
import { SANDBOX_INNERTUBE_PATHS as FAKE_SANDBOX_PATHS } from '../testing/fake-sandbox'
import {
  checkSandboxRequest,
  fxmOriginOf,
  INNERTUBE_DOCUMENT_POLICY,
  isSafelistedHeader,
  SANDBOX_INNERTUBE_HOSTS,
  SANDBOX_INNERTUBE_PATHS,
  SANDBOX_MARKER_ATTRIBUTE,
  SANDBOX_MESSAGE,
  SANDBOX_PROTOCOL,
  SANDBOX_TOKEN_PATTERN,
  type SandboxScope,
  sandboxTokenOf,
  startSandboxDocument,
  USER_HOST_DOCUMENT_POLICY,
} from './document'

const FXM = 'https://fxmusic.pages.dev'
/** The token the page put in the document's URL. */
const TOKEN = '0123456789abcdef0123456789abcdef'
const SEARCH = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false'
const BODY = '{"context":{"client":{"clientName":"WEB_REMIX"}},"query":"creep"}'
const TEXT = { 'content-type': 'text/plain;charset=UTF-8' }

describe('the allowlists', () => {
  it('are the InnerTube hosts of the host table and the paths the fake sandbox allows', () => {
    const innerTubeHosts = HOST_RULES.filter((rule) => rule.hostClass === 'innertube').map(
      (rule) => rule.host,
    )
    expect([...SANDBOX_INNERTUBE_HOSTS].sort()).toEqual([...innerTubeHosts].sort())
    expect([...SANDBOX_INNERTUBE_PATHS]).toEqual([...FAKE_SANDBOX_PATHS])
  })

  it('are frozen', () => {
    expect(Object.isFrozen(INNERTUBE_DOCUMENT_POLICY)).toBe(true)
    expect(Object.isFrozen(USER_HOST_DOCUMENT_POLICY)).toBe(true)
  })
})

describe('checkSandboxRequest for innertube.html', () => {
  const check = (request: Record<string, unknown>) =>
    checkSandboxRequest(INNERTUBE_DOCUMENT_POLICY, {
      url: SEARCH,
      method: 'POST',
      headers: TEXT,
      body: BODY,
      ...request,
    })?.code

  it('accepts CORS-simple POSTs to every allowed host and path', () => {
    for (const host of SANDBOX_INNERTUBE_HOSTS) {
      for (const path of SANDBOX_INNERTUBE_PATHS) {
        expect(check({ url: `https://${host}${path}?prettyPrint=false` })).toBeUndefined()
      }
    }
    expect(check({ headers: undefined })).toBeUndefined()
    expect(check({ headers: {} })).toBeUndefined()
    expect(check({ method: 'post' })).toBeUndefined()
    expect(check({ url: `${SEARCH}#fragment` })).toBeUndefined()
    expect(check({ headers: { Accept: '*/*', 'Accept-Language': 'en-GB,en;q=0.8' } })).toBe(
      undefined,
    )
  })

  it.each([
    ['another host', 'https://www.google.com/youtubei/v1/search', 'forbidden-host'],
    [
      'a look-alike host',
      'https://music.youtube.com.evil.example/youtubei/v1/search',
      'forbidden-host',
    ],
    ['a sub-domain', 'https://m.youtube.com/youtubei/v1/search', 'forbidden-host'],
    ['plain http', 'http://www.youtube.com/youtubei/v1/search', 'forbidden-host'],
    ['another port', 'https://www.youtube.com:8443/youtubei/v1/search', 'forbidden-host'],
    ['credentials', 'https://user:pass@www.youtube.com/youtubei/v1/search', 'forbidden-host'],
    ['another path', 'https://www.youtube.com/youtubei/v1/att/get', 'forbidden-path'],
    ['a path prefix', 'https://www.youtube.com/youtubei/v1/search/more', 'forbidden-path'],
    ['a page', 'https://www.youtube.com/watch?v=x', 'forbidden-path'],
    ['a relative URL', '/youtubei/v1/search', 'bad-request'],
    ['no URL', undefined, 'bad-request'],
    ['a long URL', `${SEARCH}&${'a'.repeat(9000)}`, 'bad-request'],
  ])('refuses %s', (_name, url, code) => {
    expect(check({ url })).toBe(code)
  })

  it('refuses preflighted shapes as such', () => {
    expect(check({ headers: { 'Content-Type': 'application/json' } })).toBe('preflight')
    expect(check({ headers: { 'X-Goog-Visitor-Id': 'v' } })).toBe('preflight')
    expect(check({ headers: { 'X-YouTube-Client-Version': '1' } })).toBe('preflight')
    expect(check({ headers: { Authorization: 'Bearer x' } })).toBe('preflight')
    expect(check({ headers: { 'User-Agent': 'FXM' } })).toBe('preflight')
    expect(check({ headers: { 'content-type': 'text/plain; x="a(b)"' } })).toBe('preflight')
    expect(check({ headers: { accept: 'a'.repeat(129) } })).toBe('preflight')
    const long = { accept: 'a'.repeat(128), 'accept-language': 'b'.repeat(128) }
    expect(check({ headers: { ...long, 'content-language': 'c'.repeat(128) } })).toBeUndefined()
    // Only names that differ in case can add up to more than the 1,024 safelisted bytes.
    const variants = ['accept', 'Accept', 'ACCEPT', 'aCcept', 'acCept', 'accEpt', 'accePt']
    const many = Object.fromEntries(
      [...variants, 'accepT', 'AccepT'].map((name) => [name, 'a'.repeat(120)]),
    )
    expect(check({ headers: many })).toBe('preflight')
    expect(check({ headers: Object.fromEntries(variants.map((name) => [name, 'a'])) })).toBe(
      undefined,
    )
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      expect(check({ method })).toBe('preflight')
    }
  })

  it('refuses other safelisted methods, and malformed requests', () => {
    expect(check({ method: 'GET' })).toBe('forbidden-method')
    expect(check({ method: 'HEAD' })).toBe('forbidden-method')
    expect(check({ method: undefined })).toBe('bad-request')
    expect(check({ headers: { accept: 1 } })).toBe('bad-request')
    expect(check({ headers: ['accept', 'x'] })).toBe('bad-request')
    expect(check({ body: undefined })).toBe('bad-request')
    expect(check({ body: new Uint8Array(2) })).toBe('bad-request')
  })

  it('caps request bodies at 1 MiB, in UTF-8 bytes', () => {
    expect(check({ body: 'a'.repeat(1024 * 1024) })).toBeUndefined()
    expect(check({ body: 'a'.repeat(1024 * 1024 + 1) })).toBe('request-too-large')
    expect(check({ body: 'é'.repeat(600 * 1024) })).toBe('request-too-large')
  })
})

describe('checkSandboxRequest for userhost.html', () => {
  const check = (request: Record<string, unknown>) =>
    checkSandboxRequest(USER_HOST_DOCUMENT_POLICY, {
      url: 'https://invidious.example/api/v1/stats',
      method: 'GET',
      ...request,
    })?.code

  it('accepts GET and HEAD to any HTTPS host and port, without headers or a body', () => {
    expect(check({})).toBeUndefined()
    expect(check({ method: 'HEAD' })).toBeUndefined()
    expect(check({ url: 'https://gist.githubusercontent.com/u/1/raw/s.json' })).toBeUndefined()
    expect(check({ url: 'https://192.168.1.5:3000/api/v1/stats' })).toBeUndefined()
    expect(check({ headers: {} })).toBeUndefined()
  })

  it('refuses every header, other methods, bodies and plain HTTP', () => {
    expect(check({ headers: { accept: 'application/json' } })).toBe('forbidden-header')
    expect(check({ headers: { 'x-api-key': 'k' } })).toBe('forbidden-header')
    expect(check({ method: 'POST' })).toBe('forbidden-method')
    expect(check({ method: 'PUT' })).toBe('preflight')
    expect(check({ body: 'x' })).toBe('bad-request')
    expect(check({ url: 'http://invidious.example/api/v1/stats' })).toBe('forbidden-host')
    expect(check({ url: 'ftp://invidious.example/' })).toBe('forbidden-host')
    expect(check({ url: 'https://u:p@invidious.example/' })).toBe('forbidden-host')
  })
})

describe('isSafelistedHeader', () => {
  it('agrees with the CORS safelist in src/cors.ts', () => {
    const cases: [string, string][] = [
      ['accept', '*/*'],
      ['accept', 'text/html, application/json;q=0.9'],
      ['accept', 'a\u0001b'],
      ['accept', 'a\tb'],
      ['accept', 'a"b'],
      ['accept', 'x'.repeat(128)],
      ['accept', 'x'.repeat(129)],
      ['accept-language', 'en-GB,en;q=0.8'],
      ['accept-language', 'en_GB'],
      ['content-language', 'de'],
      ['content-language', 'de!'],
      ['content-type', 'text/plain'],
      ['content-type', 'text/plain;charset=UTF-8'],
      ['content-type', ' TEXT/PLAIN ; charset=utf-8'],
      ['content-type', 'application/x-www-form-urlencoded'],
      ['content-type', 'multipart/form-data; boundary=x'],
      ['content-type', 'application/json'],
      ['content-type', 'text/plain; a=(b)'],
      ['range', 'bytes=0-'],
      ['range', 'bytes=0-499'],
      ['range', 'bytes=500-499'],
      ['range', 'bytes=-500'],
      ['range', 'bytes=0-1,2-3'],
      ['x-goog-visitor-id', 'v'],
      ['authorization', 'Bearer x'],
      ['user-agent', 'Mozilla/5.0'],
      ['origin', 'https://fxmusic.pages.dev'],
    ]
    for (const [name, value] of cases) {
      expect([name, value, isSafelistedHeader(name, value)]).toEqual([
        name,
        value,
        isCorsSafelistedRequestHeader(name, value),
      ])
    }
  })
})

describe('fxmOriginOf', () => {
  it('is the origin of the document’s own URL', () => {
    expect(fxmOriginOf(`${FXM}/sandbox/innertube.html#${TOKEN}`)).toBe(FXM)
    expect(fxmOriginOf('https://develop.fxmusic.pages.dev/sandbox/innertube')).toBe(
      'https://develop.fxmusic.pages.dev',
    )
    expect(fxmOriginOf('http://localhost:5173/sandbox/innertube.html')).toBe(
      'http://localhost:5173',
    )
  })

  it('is undefined for URLs without a usable origin', () => {
    for (const href of ['about:srcdoc', 'about:blank', 'data:text/html,x', 'file:///x', 'x', 1]) {
      expect(fxmOriginOf(href)).toBeUndefined()
    }
  })
})

describe('sandboxTokenOf', () => {
  it('is the 128-bit token in the fragment of the document’s URL', () => {
    expect(sandboxTokenOf(`${FXM}/sandbox/innertube.html#${TOKEN}`)).toBe(TOKEN)
    expect(sandboxTokenOf(`${FXM}/sandbox/innertube.html?delay=1#${TOKEN}`)).toBe(TOKEN)
    expect(SANDBOX_TOKEN_PATTERN.test(TOKEN)).toBe(true)
  })

  it('is undefined without one, or for anything else in the fragment', () => {
    for (const href of [
      `${FXM}/sandbox/innertube.html`,
      `${FXM}/sandbox/innertube.html#`,
      `${FXM}/sandbox/innertube.html#${TOKEN.toUpperCase()}`,
      `${FXM}/sandbox/innertube.html#${TOKEN}0`,
      `${FXM}/sandbox/innertube.html#${TOKEN.slice(1)}`,
      `${FXM}/sandbox/innertube.html#token=${TOKEN}`,
      'x',
      7,
    ]) {
      expect([href, sandboxTokenOf(href)]).toEqual([href, undefined])
    }
  })
})

/** A document's global scope, with the page as its parent. */
function documentScope(
  options: {
    href?: string
    topLevel?: boolean
    fetch?: SandboxScope['fetch']
    clock?: FakeClock
  } = {},
) {
  const listeners = new Set<(event: MessageEvent) => void>()
  const posted: { message: unknown; targetOrigin: string }[] = []
  const parent = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin })
    },
  }
  const fetch = vi.fn(
    options.fetch ?? (async () => Response.json({ responseContext: {} }, { status: 200 })),
  )
  const attributes = new Map<string, string>()
  const scope: SandboxScope = {
    location: { href: options.href ?? `${FXM}/sandbox/innertube.html#${TOKEN}` },
    document: {
      documentElement: {
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: (name) => attributes.delete(name),
      },
    },
    parent,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    fetch,
    setTimeout: options.clock?.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimeout:
      options.clock?.clearTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  }
  // At top level a window is its own parent.
  if (options.topLevel) (scope as { parent: unknown }).parent = scope
  /** Delivers a window message, as `source` at `origin` would post it. */
  const deliver = (data: unknown, origin: string, source: unknown, ports: MessagePort[] = []) => {
    const event = { data, origin, source, ports } as unknown as MessageEvent
    for (const listener of [...listeners]) listener(event)
  }
  return { scope, parent, posted, listeners, fetch, deliver, attributes }
}

/** Waits for the next message on a port. */
function nextMessage(port: MessagePort): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    port.addEventListener('message', (event) => resolve(event.data), { once: true })
    port.start()
  })
}

/**
 * Connects to a document as its page does, checks that its first message on the port is `ready`
 * with the token, and returns the page's end of the port.
 */
async function connectTo(
  deliver: (data: unknown, origin: string, source: unknown, ports?: MessagePort[]) => void,
  parent: unknown,
): Promise<MessagePort> {
  const { port1, port2 } = new MessageChannel()
  const ready = nextMessage(port1)
  deliver({ type: SANDBOX_MESSAGE.connect, protocol: SANDBOX_PROTOCOL }, FXM, parent, [port2])
  expect(await ready).toEqual({ type: SANDBOX_MESSAGE.ready, token: TOKEN })
  return port1
}

const request = (id: string, fields: Record<string, unknown> = {}) => ({
  type: SANDBOX_MESSAGE.request,
  id,
  url: SEARCH,
  method: 'POST',
  headers: TEXT,
  body: BODY,
  ...fields,
})

describe('startSandboxDocument', () => {
  it('says hello with its token to its parent, addressed to the origin it is served from only', () => {
    const { scope, posted, attributes } = documentScope()
    const document = startSandboxDocument(scope, INNERTUBE_DOCUMENT_POLICY)
    expect(document.listening).toBe(true)
    expect(posted).toEqual([
      {
        message: {
          type: SANDBOX_MESSAGE.hello,
          protocol: SANDBOX_PROTOCOL,
          document: 'innertube',
          token: TOKEN,
        },
        targetOrigin: FXM,
      },
    ])
    expect(attributes.get(SANDBOX_MARKER_ATTRIBUTE)).toBe('listening')
    document.stop()
    expect(document.listening).toBe(false)
    expect(attributes.has(SANDBOX_MARKER_ATTRIBUTE)).toBe(false)
    // A document without an element to mark still works.
    const bare = documentScope()
    const unmarked = startSandboxDocument(
      { ...bare.scope, document: { documentElement: null } },
      USER_HOST_DOCUMENT_POLICY,
    )
    expect(unmarked.listening).toBe(true)
    unmarked.stop()
  })

  it('does nothing at top level, without an origin to trust, or without a token', () => {
    for (const options of [
      { topLevel: true },
      { href: 'about:srcdoc' },
      { href: `${FXM}/sandbox/innertube.html` },
      { href: `${FXM}/sandbox/innertube.html#not-a-token` },
    ]) {
      const { scope, posted, listeners, attributes } = documentScope(options)
      const document = startSandboxDocument(scope, INNERTUBE_DOCUMENT_POLICY)
      expect(document.listening).toBe(false)
      expect(posted).toEqual([])
      expect(listeners.size).toBe(0)
      expect(attributes.size).toBe(0)
      document.stop()
    }
    const { scope } = documentScope()
    expect(
      startSandboxDocument({ ...scope, parent: null }, USER_HOST_DOCUMENT_POLICY).listening,
    ).toBe(false)
  })

  it('takes a port only from its parent at the FXM origin, once, says ready on it and serves it', async () => {
    const { scope, parent, deliver, fetch } = documentScope()
    const document = startSandboxDocument(scope, INNERTUBE_DOCUMENT_POLICY)
    const connect = { type: SANDBOX_MESSAGE.connect, protocol: SANDBOX_PROTOCOL }
    const strangers: MessageChannel[] = []
    const heard: unknown[] = []
    const offer = (origin: string, source: unknown, data: unknown = connect) => {
      const channel = new MessageChannel()
      strangers.push(channel)
      channel.port1.addEventListener('message', (event) => heard.push(event.data))
      channel.port1.start()
      deliver(data, origin, source, [channel.port2])
      channel.port1.postMessage(request('stranger'))
    }
    offer('https://evil.example', parent)
    offer('null', parent)
    offer(FXM, {})
    offer(FXM, scope)
    offer(FXM, parent, { ...connect, protocol: 1 })
    offer(FXM, parent, { type: 'fxm-sandbox:other', protocol: SANDBOX_PROTOCOL })
    offer(FXM, parent, 'connect')
    deliver(connect, FXM, parent, [])

    const port = await connectTo(deliver, parent)
    const second = new MessageChannel()
    second.port1.addEventListener('message', (event) => heard.push(event.data))
    second.port1.start()
    deliver(connect, FXM, parent, [second.port2])
    second.port1.postMessage(request('second'))

    const reply = nextMessage(port)
    port.postMessage(request('mine'))
    expect(await reply).toMatchObject({ type: SANDBOX_MESSAGE.response, id: 'mine', status: 200 })
    expect(fetch).toHaveBeenCalledOnce()
    // Neither the token nor an answer went to any other port.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(heard).toEqual([])
    document.stop()
    for (const channel of [...strangers, second]) channel.port1.close()
    port.close()
  })

  it('sends the request as given, without credentials, a referrer or redirects, and transfers the body', async () => {
    const { scope, parent, deliver, fetch } = documentScope({
      fetch: async () =>
        new Response('{"ok":true}', {
          status: 201,
          statusText: 'Created',
          headers: { 'content-type': 'application/json' },
        }),
    })
    const document = startSandboxDocument(scope, INNERTUBE_DOCUMENT_POLICY)
    const port = await connectTo(deliver, parent)
    const reply = nextMessage(port)
    port.postMessage(request('a'))
    const response = await reply
    expect(response).toMatchObject({
      type: SANDBOX_MESSAGE.response,
      id: 'a',
      status: 201,
      statusText: 'Created',
      redirected: false,
      headers: [['content-type', 'application/json']],
    })
    expect(new TextDecoder().decode(response.body as ArrayBuffer)).toBe('{"ok":true}')
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(SEARCH)
    expect(init).toMatchObject({
      method: 'POST',
      headers: TEXT,
      body: BODY,
      credentials: 'omit',
      mode: 'cors',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    document.stop()
    port.close()
  })

  it('never follows a redirect: it fails the request with `redirect`', async () => {
    const answers: (() => Response)[] = [
      // What a browser hands over for `redirect: 'manual'`: an opaque redirect.
      () =>
        Object.defineProperty(new Response(null, { status: 200 }), 'type', {
          value: 'opaqueredirect',
        }),
      // A runtime that returns the redirect as it is.
      () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
      () => new Response(null, { status: 304 }),
    ]
    const { scope, parent, deliver, fetch } = documentScope({
      fetch: async () => (answers.shift() as () => Response)(),
    })
    const document = startSandboxDocument(scope, USER_HOST_DOCUMENT_POLICY)
    const port = await connectTo(deliver, parent)
    const replies: Record<string, unknown>[] = []
    for (const id of ['opaque', 'plain', 'not-modified']) {
      const reply = nextMessage(port)
      port.postMessage({
        type: SANDBOX_MESSAGE.request,
        id,
        url: 'https://invidious.example/api/v1/stats',
        method: 'GET',
      })
      replies.push(await reply)
    }
    expect(replies.map(({ id, code, status }) => ({ id, code, status }))).toEqual([
      { id: 'opaque', code: 'redirect', status: undefined },
      { id: 'plain', code: 'redirect', status: undefined },
      { id: 'not-modified', code: undefined, status: 304 },
    ])
    expect(fetch.mock.calls.map(([, init]) => init.redirect)).toEqual([
      'manual',
      'manual',
      'manual',
    ])
    document.stop()
    port.close()
  })

  it('refuses requests outside its policy, with the reason', async () => {
    const { scope, parent, deliver, fetch } = documentScope()
    const document = startSandboxDocument(scope, INNERTUBE_DOCUMENT_POLICY)
    const port = await connectTo(deliver, parent)
    const ask = async (fields: Record<string, unknown>) => {
      const reply = nextMessage(port)
      port.postMessage(request('r', fields))
      return reply
    }
    expect(await ask({ url: 'https://example.com/' })).toMatchObject({
      type: SANDBOX_MESSAGE.error,
      id: 'r',
      code: 'forbidden-host',
    })
    expect(await ask({ url: 'https://www.youtube.com/youtubei/v1/att/get' })).toMatchObject({
      code: 'forbidden-path',
    })
    expect(await ask({ headers: { 'content-type': 'application/json' } })).toMatchObject({
      code: 'preflight',
    })
    expect(await ask({ method: 'GET', body: undefined })).toMatchObject({
      code: 'forbidden-method',
    })
    expect(await ask({ body: 'x'.repeat(1024 * 1024 + 1) })).toMatchObject({
      code: 'request-too-large',
    })
    expect(fetch).not.toHaveBeenCalled()
    document.stop()
    port.close()
  })

  it('ignores messages it cannot answer, and repeated IDs', async () => {
    let release: () => void = () => undefined
    const { scope, parent, deliver, fetch } = documentScope({
      fetch: () =>
        new Promise((resolve) => {
          release = () => resolve(Response.json({}))
        }),
    })
    const document = startSandboxDocument(scope, INNERTUBE_DOCUMENT_POLICY)
    const port = await connectTo(deliver, parent)
    const replies: unknown[] = []
    port.addEventListener('message', (event) => replies.push(event.data))
    for (const message of [
      'request',
      { type: 'fxm-sandbox:unknown', id: 'u' },
      request(''),
      request('x'.repeat(129)),
      { ...request('n'), id: 7 },
      { type: SANDBOX_MESSAGE.abort, id: 9 },
    ]) {
      port.postMessage(message)
    }
    port.postMessage(request('same'))
    port.postMessage(request('same'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    release()
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toMatchObject({ id: 'same', status: 200 })
    document.stop()
    port.close()
  })

  it('caps response bodies, by Content-Length or as they stream', async () => {
    const big = new Uint8Array(2048)
    const { scope, parent, deliver } = documentScope({
      fetch: async (url) =>
        url.includes('declared')
          ? new Response(big, { headers: { 'content-length': '2048' } })
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(big.subarray(0, 1000))
                  controller.enqueue(big.subarray(1000))
                  controller.close()
                },
              }),
            ),
    })
    const document = startSandboxDocument(scope, USER_HOST_DOCUMENT_POLICY)
    const port = await connectTo(deliver, parent)
    const ask = async (url: string, maxResponseBytes?: number) => {
      const reply = nextMessage(port)
      port.postMessage({
        type: SANDBOX_MESSAGE.request,
        id: url,
        url,
        method: 'GET',
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
      })
      return reply
    }
    expect(await ask('https://a.example/declared', 1024)).toMatchObject({ code: 'too-large' })
    expect(await ask('https://a.example/streamed', 1024)).toMatchObject({ code: 'too-large' })
    const whole = await ask('https://a.example/streamed', 2048)
    expect((whole.body as ArrayBuffer).byteLength).toBe(2048)
    // A request can't raise the document's own cap.
    const capped = await ask('https://a.example/streamed', 10 * 1024 * 1024)
    expect(capped).toMatchObject({ status: 200 })
    document.stop()
    port.close()
  })

  it('times out, fails on network errors and stops on cancellation', async () => {
    const clock = createFakeClock(0)
    const { scope, parent, deliver, fetch } = documentScope({
      clock,
      fetch: (url, init) =>
        new Promise((_resolve, reject) => {
          if (url.includes('fails')) reject(new TypeError('Failed to fetch'))
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    })
    const document = startSandboxDocument(scope, USER_HOST_DOCUMENT_POLICY)
    const port = await connectTo(deliver, parent)
    const replies: Record<string, unknown>[] = []
    port.addEventListener('message', (event) => replies.push(event.data))
    const get = (id: string, url: string, extra: Record<string, unknown> = {}) =>
      port.postMessage({ type: SANDBOX_MESSAGE.request, id, url, method: 'GET', ...extra })
    const signal = (index: number) => fetch.mock.calls[index]?.[1].signal

    get('slow', 'https://a.example/slow', { timeoutMs: 1000 })
    get('cancelled', 'https://a.example/cancelled')
    get('fails', 'https://a.example/fails')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    port.postMessage({ type: SANDBOX_MESSAGE.abort, id: 'cancelled' })
    port.postMessage({ type: SANDBOX_MESSAGE.abort, id: 'unknown' })
    await vi.waitFor(() => expect(signal(1)?.aborted).toBe(true))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toMatchObject({ id: 'fails', code: 'network' })
    expect(String(replies[0]?.message)).toContain('TypeError: Failed to fetch')
    clock.advance(999)
    expect(signal(0)?.aborted).toBe(false)
    clock.advance(1)
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies[1]).toMatchObject({ id: 'slow', code: 'timeout' })

    // A request may not ask for more time than the document allows.
    get('long', 'https://a.example/long', { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    clock.advance(USER_HOST_DOCUMENT_POLICY.timeoutMs)
    await vi.waitFor(() => expect(replies).toHaveLength(3))
    expect(replies[2]).toMatchObject({ id: 'long', code: 'timeout' })

    // Stopping cancels what is in flight, and nothing answers any more.
    get('last', 'https://a.example/last')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5))
    document.stop()
    document.stop()
    expect(signal(4)?.aborted).toBe(true)
    get('after', 'https://a.example/after')
    clock.advance(100_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(replies).toHaveLength(3)
    port.close()
  })

  it('describes failures from any realm, and odd values', async () => {
    const failures: unknown[] = [{ name: 'TypeError', message: 'NetworkError' }, 'boom', null]
    const { scope, parent, deliver } = documentScope({
      fetch: async () => {
        throw failures.shift()
      },
    })
    const document = startSandboxDocument(scope, USER_HOST_DOCUMENT_POLICY)
    const port = await connectTo(deliver, parent)
    const messages: unknown[] = []
    for (const id of ['a', 'b', 'c']) {
      const reply = nextMessage(port)
      port.postMessage({
        type: SANDBOX_MESSAGE.request,
        id,
        url: 'https://a.example/',
        method: 'GET',
      })
      messages.push((await reply).message)
    }
    expect(messages).toEqual([
      'TypeError: NetworkError',
      'The request failed',
      'The request failed',
    ])
    document.stop()
    port.close()
  })
})
