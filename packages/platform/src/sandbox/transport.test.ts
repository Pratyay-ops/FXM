import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestBudget } from '../budget'
import { detectCapabilities } from '../capabilities'
import { isTransportError } from '../errors'
import { createLiteTier } from '../lite'
import { createFakeClock } from '../testing/fake-clock'
import { createWebTransport } from '../web'
import {
  INNERTUBE_DOCUMENT_POLICY,
  SANDBOX_MESSAGE,
  SANDBOX_PROTOCOL,
  SANDBOX_TOKEN_PATTERN,
  type SandboxScope,
} from './document'
import { isSandboxError } from './errors'
import {
  createFakePage,
  FAKE_FXM_ORIGIN,
  type FakeFrame,
  type FakePage,
  type FakePageOptions,
} from './testing'
import {
  createSandboxTransport,
  defaultSelfTestRequest,
  SANDBOX_LOAD_TIMEOUT_MS,
  SANDBOX_REPLY_MARGIN_MS,
  type SandboxTransportOptions,
} from './transport'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false'
const PLAYER = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const INSTANCE = 'https://invidious.example:8443/api/v1/stats'
const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'creep' })
const TEXT = { 'content-type': 'text/plain;charset=UTF-8' }
/** A token for documents framed by hand. */
const TOKEN = 'fedcba9876543210fedcba9876543210'
/** A token nobody gave out. */
const GUESS = '0'.repeat(32)

/** An InnerTube request in the simple shape, with changes. */
const simple = (
  url = SEARCH,
  init: Partial<{ method: string; headers: Record<string, string>; body: string }> = {},
  signal?: AbortSignal,
) =>
  ({
    url,
    init: {
      method: 'POST',
      headers: TEXT,
      body: BODY,
      credentials: 'omit',
      ...init,
      ...(signal === undefined ? {} : { signal }),
    },
  }) as Parameters<ReturnType<typeof createSandboxTransport>['innerTube']>[0]

/** The answer a browser hands over for a redirect fetched with `redirect: 'manual'`. */
const opaqueRedirect = () =>
  Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' })

/** A frame's URL without its fragment, and the token in the fragment. */
const urlOf = (frame: FakeFrame | undefined) => (frame?.src ?? '').split('#')[0]
const tokenOf = (frame: FakeFrame | undefined) => (frame?.src ?? '').split('#')[1]

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup(pageOptions: FakePageOptions = {}, options: SandboxTransportOptions = {}) {
  const page = createFakePage(pageOptions)
  const sandbox = createSandboxTransport({ window: page.window, ...options })
  cleanups.push(() => sandbox.dispose())
  return { page, sandbox }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

/** A request the network answers only when the test says so, or when it is cancelled. */
function heldNetwork() {
  const held: { url: string; init: RequestInit; release: (response: Response) => void }[] = []
  const network = (url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      held.push({ url, init, release: resolve })
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')),
      )
    })
  return { held, network }
}

/**
 * A hand-made document: it says hello with `hello`'s changes, and once it has the port it says
 * `ready` with `ready`'s token (the token from its URL by default, none when `ready` is `null`),
 * then hands every message on the port to `onPort`.
 */
function customDocument(
  options: {
    hello?: Record<string, unknown>
    ready?: string | null
    onPort?: (port: MessagePort, data: Record<string, unknown>) => void
  } = {},
): (scope: SandboxScope) => void {
  return (scope: SandboxScope) => {
    const { origin, hash } = new URL(scope.location?.href ?? '')
    const token = hash.slice(1)
    scope.addEventListener('message', (event) => {
      const port = event.ports[0]
      if (port === undefined) return
      port.addEventListener('message', (message) => options.onPort?.(port, message.data))
      port.start()
      if (options.ready !== null) {
        port.postMessage({ type: SANDBOX_MESSAGE.ready, token: options.ready ?? token })
      }
    })
    scope.parent?.postMessage(
      {
        type: SANDBOX_MESSAGE.hello,
        protocol: SANDBOX_PROTOCOL,
        document: 'innertube',
        token,
        ...options.hello,
      },
      origin,
    )
  }
}

/**
 * Connects to a fake page's document the way the transport does, but by hand, so tests can send
 * messages the transport would never send.
 */
async function rawConnect(page: FakePage, path = '/sandbox/innertube.html') {
  const frame = page.window.document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.src = `${FAKE_FXM_ORIGIN}${path}#${TOKEN}`
  const hello = new Promise<MessageEvent>((resolve) => {
    page.window.addEventListener('message', resolve, { once: true })
  })
  page.window.document.body.appendChild(frame)
  const event = await hello
  const { port1, port2 } = new MessageChannel()
  const ready = new Promise<unknown>((resolve) => {
    port1.addEventListener('message', (message) => resolve(message.data), { once: true })
  })
  port1.start()
  frame.contentWindow?.postMessage(
    { type: SANDBOX_MESSAGE.connect, protocol: SANDBOX_PROTOCOL },
    '*',
    [port2],
  )
  expect(await ready).toEqual({ type: SANDBOX_MESSAGE.ready, token: TOKEN })
  cleanups.push(() => {
    port1.close()
    frame.remove()
  })
  const ask = (message: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      port1.addEventListener('message', (reply) => resolve(reply.data), { once: true })
      port1.postMessage({ type: SANDBOX_MESSAGE.request, id: String(Math.random()), ...message })
    })
  return { event, ask }
}

describe('createSandboxTransport', () => {
  it('needs a page', () => {
    const error = (() => {
      try {
        createSandboxTransport()
      } catch (caught) {
        return caught
      }
      return undefined
    })()
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })

  it('frames nothing until the first request, then innertube.html once, opaque, hidden and with a token', async () => {
    const { page, sandbox } = setup()
    expect(page.frames).toEqual([])
    await sandbox.innerTube(simple())
    await sandbox.innerTube(simple(PLAYER))
    expect(page.frames).toHaveLength(1)
    const [frame] = page.frames
    expect(urlOf(frame)).toBe(`${FAKE_FXM_ORIGIN}/sandbox/innertube.html`)
    expect(tokenOf(frame)).toMatch(SANDBOX_TOKEN_PATTERN)
    expect(frame?.hidden).toBe(true)
    expect(Object.fromEntries(frame?.attributes ?? [])).toMatchObject({
      sandbox: 'allow-scripts',
      'aria-hidden': 'true',
      tabindex: '-1',
      referrerpolicy: 'no-referrer',
    })
  })

  it('sends InnerTube calls through the document, as given, and returns its answers', async () => {
    const { page, sandbox } = setup({
      network: async (url) =>
        Response.json({ responseContext: {}, url }, { status: 200, headers: { 'x-mock': 'yes' } }),
    })
    const response = await sandbox.innerTube(simple())
    expect(response.status).toBe(200)
    expect(response.headers.get('x-mock')).toBe('yes')
    expect(response.redirected).toBe(false)
    expect(await response.json()).toEqual({ responseContext: {}, url: SEARCH })
    expect(page.requests).toHaveLength(1)
    const [request] = page.requests
    expect(request?.url).toBe(SEARCH)
    expect(request?.init).toMatchObject({
      method: 'POST',
      headers: TEXT,
      body: BODY,
      credentials: 'omit',
      mode: 'cors',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
    })
  })

  it('answers concurrent requests in any order', async () => {
    const { held, network } = heldNetwork()
    const { sandbox } = setup({ network })
    const first = sandbox.innerTube(simple(SEARCH))
    const second = sandbox.innerTube(simple(PLAYER))
    await vi.waitFor(() => expect(held).toHaveLength(2))
    held[1]?.release(Response.json({ which: 'player' }))
    held[0]?.release(Response.json({ which: 'search' }))
    expect(await (await first).json()).toEqual({ which: 'search' })
    expect(await (await second).json()).toEqual({ which: 'player' })
  })

  it('keeps statuses, status texts, the URL, and empty bodies', async () => {
    const answers = [
      () => new Response('nope', { status: 404, statusText: 'Not Found' }),
      () => new Response(null, { status: 204 }),
      () => {
        const response = Response.json({ ok: true })
        Object.defineProperty(response, 'url', { value: SEARCH })
        return response
      },
    ]
    const { sandbox } = setup({ network: async () => (answers.shift() as () => Response)() })
    const notFound = await sandbox.innerTube(simple())
    expect([notFound.status, notFound.statusText, await notFound.text()]).toEqual([
      404,
      'Not Found',
      'nope',
    ])
    const empty = await sandbox.innerTube(simple())
    expect([empty.status, empty.body]).toEqual([204, null])
    const withUrl = await sandbox.innerTube(simple())
    expect(withUrl.url).toBe(SEARCH)
  })

  it('refuses other hosts, paths and preflighted shapes at once as TransportErrors, framing nothing', async () => {
    const { page, sandbox } = setup()
    const cases: [ReturnType<typeof simple>, string][] = [
      [simple('https://www.google.com/youtubei/v1/search'), 'forbidden-host'],
      [simple('http://www.youtube.com/youtubei/v1/search'), 'forbidden-host'],
      [simple('https://www.youtube.com:8443/youtubei/v1/search'), 'forbidden-host'],
      [simple('https://www.youtube.com/youtubei/v1/att/get'), 'forbidden-path'],
      [simple(SEARCH, { headers: { 'content-type': 'application/json' } }), 'preflight'],
      [simple(SEARCH, { headers: { 'x-goog-visitor-id': 'v' } }), 'preflight'],
      [simple(SEARCH, { method: 'PUT' }), 'preflight'],
      [simple(SEARCH, { method: 'GET' }), 'forbidden-method'],
      [simple(SEARCH, { body: 'x'.repeat(1024 * 1024 + 1) }), 'request-too-large'],
    ]
    for (const [request, code] of cases) {
      const error = await rejection(sandbox.innerTube(request))
      expect([
        request.url.slice(0, 60),
        isSandboxError(error, code),
        isTransportError(error, 'bad-request'),
        isFxmError(error, 'Unsupported'),
      ]).toEqual([request.url.slice(0, 60), true, true, true])
    }
    expect(page.frames).toEqual([])
    expect(page.requests).toEqual([])
  })

  it('has the documents refuse the same requests when the page’s check is skipped', async () => {
    const page = createFakePage()
    const { event, ask } = await rawConnect(page)
    expect(event.data).toEqual({
      type: SANDBOX_MESSAGE.hello,
      protocol: SANDBOX_PROTOCOL,
      document: 'innertube',
      token: TOKEN,
    })
    expect(event.origin).toBe('null')
    const post = { method: 'POST', headers: TEXT, body: BODY }
    const codes = [
      await ask({ url: 'https://example.com/', ...post }),
      await ask({ url: 'https://www.youtube.com/youtubei/v1/att/get', ...post }),
      await ask({ url: SEARCH, ...post, headers: { 'content-type': 'application/json' } }),
      await ask({ url: SEARCH, ...post, headers: { 'x-goog-visitor-id': 'v' } }),
      await ask({ url: SEARCH, ...post, method: 'DELETE' }),
      await ask({ url: SEARCH, method: 'GET', headers: {} }),
      await ask({ url: SEARCH, ...post, body: 'x'.repeat(1024 * 1024 + 1) }),
    ].map((reply) => reply.code)
    expect(codes).toEqual([
      'forbidden-host',
      'forbidden-path',
      'preflight',
      'preflight',
      'preflight',
      'forbidden-method',
      'request-too-large',
    ])
    expect(page.requests).toEqual([])

    const userHost = await rawConnect(page, '/sandbox/userhost.html')
    expect(userHost.event.data).toMatchObject({ document: 'userhost', token: TOKEN })
    const refused = [
      await userHost.ask({ url: INSTANCE, method: 'POST', body: 'x' }),
      await userHost.ask({ url: INSTANCE, method: 'GET', headers: { accept: 'x' } }),
      await userHost.ask({ url: 'http://invidious.example/', method: 'GET' }),
    ].map((reply) => reply.code)
    expect(refused).toEqual(['forbidden-method', 'forbidden-header', 'forbidden-host'])
    expect(page.requests).toEqual([])
  })

  it('caps response bodies with a typed error', async () => {
    const { sandbox } = setup(
      { network: async () => new Response(new Uint8Array(4096)) },
      { innerTube: { maxResponseBytes: 1024 }, userHost: { maxResponseBytes: 8192 } },
    )
    const error = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(error, 'too-large') && isFxmError(error, 'Parse')).toBe(true)
    const response = await sandbox.userHost(INSTANCE, { method: 'GET' })
    expect((await response.arrayBuffer()).byteLength).toBe(4096)
  })

  it('times out with a typed error, at the limit the page asks for', async () => {
    const clock = createFakeClock(0)
    const { held, network } = heldNetwork()
    const { sandbox } = setup({ network, timers: clock }, { clock, innerTube: { timeoutMs: 1000 } })
    const request = sandbox.innerTube(simple())
    await vi.waitFor(() => expect(held).toHaveLength(1))
    clock.advance(1000)
    const error = await rejection(request)
    expect(isSandboxError(error, 'timeout') && isFxmError(error, 'Network')).toBe(true)
    expect(held[0]?.init.signal?.aborted).toBe(true)
  })

  it('gives a document that stops answering up, and frames a new one', async () => {
    const clock = createFakeClock(0)
    let loads = 0
    const { page, sandbox } = setup(
      {
        // The first document connects but never answers; the second is the real one.
        documents: () => {
          loads += 1
          return loads > 1 ? 'innertube' : customDocument()
        },
      },
      { clock, innerTube: { timeoutMs: 1000 } },
    )
    const request = sandbox.innerTube(simple())
    await page.settle()
    clock.advance(1000 + SANDBOX_REPLY_MARGIN_MS - 1)
    await page.settle()
    expect(page.frames[0]?.connected).toBe(true)
    clock.advance(1)
    const error = await rejection(request)
    expect(isSandboxError(error, 'timeout')).toBe(true)
    expect(page.frames[0]?.connected).toBe(false)
    const response = await sandbox.innerTube(simple())
    expect(response.status).toBe(200)
    expect(page.frames).toHaveLength(2)
  })

  it('gives up on a document that does not load, and frames a new one with a new token', async () => {
    const clock = createFakeClock(0)
    let silent = true
    const { page, sandbox } = setup(
      { documents: () => (silent ? 'silent' : 'innertube') },
      { clock },
    )
    const request = sandbox.innerTube(simple())
    const selfTest = sandbox.selfTest()
    await page.settle()
    clock.advance(SANDBOX_LOAD_TIMEOUT_MS)
    const error = await rejection(request)
    expect(isSandboxError(error, 'timeout') && isFxmError(error, 'Network')).toBe(true)
    expect(await selfTest).toBe('unreachable')
    expect(page.frames[0]?.connected).toBe(false)
    silent = false
    expect(await sandbox.selfTest()).toBe('pass')
    expect(page.frames).toHaveLength(2)
    expect(tokenOf(page.frames[1])).toMatch(SANDBOX_TOKEN_PATTERN)
    expect(tokenOf(page.frames[1])).not.toBe(tokenOf(page.frames[0]))
  })

  it('takes a hello only from its own frame, from an opaque origin, in its protocol', async () => {
    const clock = createFakeClock(0)
    const seen: unknown[] = []
    const { page, sandbox } = setup(
      {
        documents: () => (scope: SandboxScope) => {
          scope.addEventListener('message', (event) => seen.push(event.data))
        },
      },
      { clock, loadTimeoutMs: 5000 },
    )
    const request = sandbox.innerTube(simple())
    await page.settle()
    const frame = page.frames[0]
    const hello = {
      type: SANDBOX_MESSAGE.hello,
      protocol: SANDBOX_PROTOCOL,
      document: 'innertube',
      token: tokenOf(frame),
    }
    page.deliver(hello, { origin: 'null', source: {} })
    page.deliver(hello, { origin: FAKE_FXM_ORIGIN, source: frame?.window })
    page.deliver({ ...hello, type: 'fxm-sandbox:hi' }, { origin: 'null', source: frame?.window })
    page.deliver('hello', { origin: 'null', source: frame?.window })
    await page.settle()
    expect(seen).toEqual([])
    clock.advance(5000)
    expect(isSandboxError(await rejection(request), 'timeout')).toBe(true)

    // A document of another protocol, or the other document, is refused.
    for (const wrong of [{ protocol: 1 }, { document: 'userhost' }]) {
      const next = sandbox.innerTube(simple())
      await page.settle()
      const current = page.frames.at(-1)
      page.deliver(
        { ...hello, token: tokenOf(current), ...wrong },
        { origin: 'null', source: current?.window },
      )
      const error = await rejection(next)
      expect(isFxmError(error, 'Unsupported')).toBe(true)
      expect(current?.connected).toBe(false)
    }
    expect(seen).toEqual([])
  })

  it('refuses a hello without the frame’s token, and sends that document nothing', async () => {
    const seen: unknown[] = []
    const hellos = [{ token: undefined }, { token: GUESS }, { token: TOKEN.toUpperCase() }]
    let loads = 0
    const { page, sandbox } = setup({
      documents: () => {
        const hello = hellos[loads] ?? {}
        loads += 1
        return (scope: SandboxScope) => {
          scope.addEventListener('message', (event) => seen.push(event.data))
          customDocument({ hello })(scope)
        }
      },
    })
    for (let index = 0; index < hellos.length; index += 1) {
      const error = await rejection(sandbox.innerTube(simple()))
      expect(isSandboxError(error, 'network') && isFxmError(error, 'Network')).toBe(true)
      expect(String((error as Error).message)).toMatch(/did not frame/)
      expect(page.frames[index]?.connected).toBe(false)
    }
    // No connect, no port and no request ever reached those documents.
    expect(seen).toEqual([])
    expect(page.requests).toEqual([])
  })

  it('sends nothing on the port until the document’s token comes back on it', async () => {
    const clock = createFakeClock(0)
    // Each says hello with the frame's token, as the real document would, but the port reaches a
    // document that does not know the token, as if swapped into the frame after the hello.
    const variants: { readonly ready: string | null; readonly forge?: true }[] = [
      { ready: GUESS },
      { ready: null, forge: true },
      { ready: null },
    ]
    const onPort: unknown[] = []
    let loads = 0
    const { page, sandbox } = setup(
      {
        documents: () => {
          const variant = variants[loads] ?? { ready: null }
          loads += 1
          return (scope: SandboxScope) => {
            customDocument({
              ready: variant.ready,
              onPort: (_port, data) => onPort.push(data),
            })(scope)
            if (variant.forge) {
              scope.addEventListener('message', (event) => {
                event.ports[0]?.postMessage({
                  type: SANDBOX_MESSAGE.response,
                  id: 'forged',
                  status: 200,
                  body: new TextEncoder().encode('{"forged":true}').buffer,
                })
              })
            }
          }
        },
      },
      { clock, loadTimeoutMs: 1000 },
    )
    for (let index = 0; index < variants.length; index += 1) {
      const failure = rejection(sandbox.innerTube(simple()))
      await page.settle()
      // The silent one is given up when the load timer fires.
      clock.advance(1000)
      const error = await failure
      expect(isSandboxError(error) && isFxmError(error, 'Network')).toBe(true)
      expect(page.frames[index]?.connected).toBe(false)
    }
    expect(onPort).toEqual([])
    expect(page.requests).toEqual([])
  })

  it('ignores replies from anything but the document’s port, and malformed ones', async () => {
    const replies: ((port: MessagePort, request: Record<string, unknown>) => void)[] = [
      // A reply for another ID, then a malformed response, which fails the request.
      (port, request) => {
        port.postMessage({ type: SANDBOX_MESSAGE.response, id: 'other', status: 200, body: null })
        port.postMessage({ type: SANDBOX_MESSAGE.response, id: request.id, status: 0 })
      },
      (port, request) =>
        port.postMessage({
          type: SANDBOX_MESSAGE.response,
          id: request.id,
          status: 200,
          body: new ArrayBuffer(INNERTUBE_DOCUMENT_POLICY.maxResponseBytes + 1),
        }),
      (port, request) =>
        port.postMessage({
          type: SANDBOX_MESSAGE.response,
          id: request.id,
          status: 200,
          statusText: 'Ok\n',
          url: 7,
          redirected: 'yes',
          headers: [['x-ok', 'yes'], ['bad name', 'x'], ['x-number', 1], 'x', ['x-ok', 'twice']],
          body: new TextEncoder().encode('{}').buffer,
        }),
      (port, request) =>
        port.postMessage({
          type: SANDBOX_MESSAGE.response,
          id: request.id,
          status: 200,
          url: 'https://music.youtube.com/youtubei/v1/search',
          redirected: true,
          body: new ArrayBuffer(0),
        }),
      (port, request) => port.postMessage({ type: SANDBOX_MESSAGE.error, id: request.id, code: 7 }),
      (port, request) =>
        port.postMessage({ type: SANDBOX_MESSAGE.error, id: request.id, code: 'brand-new' }),
      (port, request) =>
        port.postMessage({ type: SANDBOX_MESSAGE.error, id: request.id, code: 'redirect' }),
    ]
    const { sandbox } = setup({
      documents: () =>
        customDocument({
          onPort: (port, data) => {
            if (data.type === SANDBOX_MESSAGE.request) replies.shift()?.(port, data)
          },
        }),
    })
    const malformed = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(malformed, 'network')).toBe(true)
    const tooBig = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(tooBig, 'network')).toBe(true)
    const odd = await sandbox.innerTube(simple())
    expect([odd.status, odd.statusText, odd.url, odd.redirected, odd.headers.get('x-ok')]).toEqual([
      200,
      '',
      '',
      false,
      'yes, twice',
    ])
    const redirected = await sandbox.innerTube(simple())
    expect([redirected.url, redirected.redirected]).toEqual([
      'https://music.youtube.com/youtubei/v1/search',
      true,
    ])
    const noCode = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(noCode, 'network')).toBe(true)
    const unknown = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(unknown, 'brand-new') && isFxmError(unknown, 'Network')).toBe(true)
    const redirect = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(redirect, 'redirect') && isTransportError(redirect, 'redirect')).toBe(
      true,
    )
  })

  it('passes cancellation on to the document', async () => {
    const { held, network } = heldNetwork()
    const { page, sandbox } = setup({ network })
    const already = await rejection(
      sandbox.innerTube(simple(SEARCH, {}, AbortSignal.abort(new Error('gone')))),
    )
    expect(already).toEqual(new Error('gone'))
    expect(page.frames).toEqual([])

    // Cancelled while the document loads.
    const loading = new AbortController()
    const early = sandbox.innerTube(simple(SEARCH, {}, loading.signal))
    loading.abort(new Error('early'))
    expect(await rejection(early)).toEqual(new Error('early'))

    // Cancelled in flight: the document cancels its request too.
    const controller = new AbortController()
    const request = sandbox.innerTube(simple(SEARCH, {}, controller.signal))
    await vi.waitFor(() => expect(held).toHaveLength(1))
    controller.abort(new Error('closed'))
    expect(await rejection(request)).toEqual(new Error('closed'))
    await vi.waitFor(() => expect(held[0]?.init.signal?.aborted).toBe(true))
  })

  it('fetches from user hosts through userhost.html: GET or HEAD, no headers, no redirects', async () => {
    const answers = [
      () => Response.json({ software: { name: 'invidious' } }),
      () => new Response(null, { status: 200 }),
      opaqueRedirect,
    ]
    const { page, sandbox } = setup({
      network: async () => (answers.shift() as () => Response)(),
    })
    const response = await sandbox.userHost(INSTANCE, { method: 'GET' })
    expect(await response.json()).toEqual({ software: { name: 'invidious' } })
    await sandbox.userHost(INSTANCE, { method: 'HEAD' })
    expect(page.frames).toHaveLength(1)
    expect(urlOf(page.frames[0])).toBe(`${FAKE_FXM_ORIGIN}/sandbox/userhost.html`)
    // A redirect is never followed, so the second host never hears of the request.
    const redirect = await rejection(sandbox.userHost(INSTANCE, { method: 'GET' }))
    expect(isSandboxError(redirect, 'redirect') && isTransportError(redirect, 'redirect')).toBe(
      true,
    )
    expect(page.requests.map(({ url, init }) => [url, init])).toMatchObject([
      [INSTANCE, { method: 'GET', headers: {}, credentials: 'omit', redirect: 'manual' }],
      [INSTANCE, { method: 'HEAD', headers: {}, credentials: 'omit', redirect: 'manual' }],
      [INSTANCE, { method: 'GET', headers: {}, credentials: 'omit', redirect: 'manual' }],
    ])
    expect(page.requests[0]?.init.body).toBeUndefined()
    const post = await rejection(sandbox.userHost(INSTANCE, { method: 'POST' as 'GET' }))
    expect(isSandboxError(post, 'forbidden-method')).toBe(true)
    const http = await rejection(sandbox.userHost('http://invidious.example/', { method: 'GET' }))
    expect(isSandboxError(http, 'forbidden-host')).toBe(true)
  })

  it('frames documents from the page’s own origin only', async () => {
    const page = createFakePage()
    const elsewhere = createSandboxTransport({
      window: page.window,
      innerTube: { url: 'https://elsewhere.example/sandbox/innertube.html' },
    })
    cleanups.push(() => elsewhere.dispose())
    expect(isFxmError(await rejection(elsewhere.innerTube(simple())), 'Unsupported')).toBe(true)
    expect(await elsewhere.selfTest()).toBe('refused')
    const relative = createSandboxTransport({
      window: page.window,
      innerTube: { url: '/preview/sandbox/innertube.html#old-fragment' },
    })
    cleanups.push(() => relative.dispose())
    void relative.innerTube(simple()).catch(() => undefined)
    await vi.waitFor(() => expect(page.frames).toHaveLength(1))
    expect(urlOf(page.frames[0])).toBe(`${FAKE_FXM_ORIGIN}/preview/sandbox/innertube.html`)
    expect(tokenOf(page.frames[0])).toMatch(SANDBOX_TOKEN_PATTERN)
  })

  it('removes its frames and refuses everything once disposed', async () => {
    const { held, network } = heldNetwork()
    const { page, sandbox } = setup({ network })
    const pending = sandbox.innerTube(simple())
    await vi.waitFor(() => expect(held).toHaveLength(1))
    sandbox.dispose()
    sandbox.dispose()
    expect(isFxmError(await rejection(pending), 'Unsupported')).toBe(true)
    expect(page.frames[0]?.connected).toBe(false)
    expect(isFxmError(await rejection(sandbox.innerTube(simple())), 'Unsupported')).toBe(true)
    expect(page.frames).toHaveLength(1)
  })

  it('rejects a request made just before dispose() on a connected document', async () => {
    const clock = createFakeClock(0)
    const { page, sandbox } = setup({}, { clock })
    expect((await sandbox.innerTube(simple())).status).toBe(200)
    const request = sandbox.innerTube(simple())
    sandbox.dispose()
    const settled = vi.fn()
    request.then(settled, settled)
    // Long past every timer: the request must have ended by then, not hang.
    clock.advance(120_000)
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(isFxmError(await rejection(request), 'Unsupported')).toBe(true)
    expect(page.requests).toHaveLength(1)
  })
})

describe('selfTest', () => {
  it('sends one real request, by default a YouTube Music suggestion request', async () => {
    const { page, sandbox } = setup()
    expect(await sandbox.selfTest()).toBe('pass')
    expect(page.requests).toHaveLength(1)
    const expected = defaultSelfTestRequest()
    expect(page.requests[0]?.url).toBe(expected.url)
    expect(page.requests[0]?.init.body).toBe(expected.init.body)
    expect(JSON.parse(expected.init.body)).toMatchObject({
      context: { client: { clientName: 'WEB_REMIX' } },
    })
  })

  it.each([
    ['a usable answer', () => Response.json({ responseContext: {} }), 'pass'],
    ['403', () => Response.json({ responseContext: {} }, { status: 403 }), 'refused'],
    ['400', () => Response.json({ error: { code: 400 } }, { status: 400 }), 'refused'],
    ['404', () => new Response('Not Found', { status: 404 }), 'refused'],
    ['429', () => new Response('Too Many Requests', { status: 429 }), 'unreachable'],
    ['500', () => new Response('Internal Server Error', { status: 500 }), 'unreachable'],
    ['503', () => new Response('Service Unavailable', { status: 503 }), 'unreachable'],
    ['an error body', () => Response.json({ error: { code: 400 } }), 'refused'],
    ['HTML', () => new Response('<html>'), 'refused'],
    ['a JSON array', () => Response.json([]), 'refused'],
    ['a malformed context', () => Response.json({ responseContext: 'x' }), 'refused'],
  ])('reads %s as %s', async (_name, answer, verdict) => {
    const { sandbox } = setup({ network: async () => answer() })
    expect(await sandbox.selfTest()).toBe(verdict)
  })

  it('reads a network failure once the document loaded as refused, unless offline', async () => {
    const network = async () => {
      throw new TypeError('Failed to fetch')
    }
    expect(await setup({ network }).sandbox.selfTest()).toBe('refused')
    expect(await setup({ network, online: false }).sandbox.selfTest()).toBe('unreachable')
  })

  it('reads a document that did not load, a timeout and a redirect as unreachable', async () => {
    const clock = createFakeClock(0)
    const silent = setup({ documents: () => 'silent' }, { clock })
    const unloaded = silent.sandbox.selfTest()
    await silent.page.settle()
    clock.advance(SANDBOX_LOAD_TIMEOUT_MS)
    expect(await unloaded).toBe('unreachable')

    const { network } = heldNetwork()
    const slow = setup({ network, timers: clock }, { clock, innerTube: { timeoutMs: 1000 } })
    const timedOut = slow.sandbox.selfTest()
    await vi.waitFor(() => expect(slow.page.requests).toHaveLength(1))
    clock.advance(1000)
    expect(await timedOut).toBe('unreachable')

    expect(await setup({ network: async () => opaqueRedirect() }).sandbox.selfTest()).toBe(
      'unreachable',
    )
    // A document that is not the one framed says nothing about InnerTube.
    const swapped = setup({ documents: () => customDocument({ hello: { token: GUESS } }) })
    expect(await swapped.sandbox.selfTest()).toBe('unreachable')
  })

  it('reads definite failures as refused', async () => {
    const tooLarge = setup(
      { network: async () => new Response(new Uint8Array(64)) },
      { innerTube: { maxResponseBytes: 16 } },
    )
    expect(await tooLarge.sandbox.selfTest()).toBe('refused')
    const outsideTheAllowlist = setup({}, { selfTestRequest: simple('https://example.com/') })
    expect(await outsideTheAllowlist.sandbox.selfTest()).toBe('refused')
    expect(outsideTheAllowlist.page.frames).toEqual([])
    const otherProtocol = setup({ documents: () => customDocument({ hello: { protocol: 1 } }) })
    expect(await otherProtocol.sandbox.selfTest()).toBe('refused')
  })

  it('sends the request the app gives, and rejects only when cancelled', async () => {
    const request = simple(PLAYER)
    const { page, sandbox } = setup({}, { selfTestRequest: request })
    expect(await sandbox.selfTest()).toBe('pass')
    const built = setup({}, { selfTestRequest: async () => simple(SEARCH) })
    expect(await built.sandbox.selfTest()).toBe('pass')
    expect([page.requests[0]?.url, built.page.requests[0]?.url]).toEqual([PLAYER, SEARCH])
    const unbuilt = setup(
      {},
      {
        selfTestRequest: () => {
          throw new Error('No YouTube config yet')
        },
      },
    )
    expect(await unbuilt.sandbox.selfTest()).toBe('unreachable')
    const { held, network } = heldNetwork()
    const cancelled = setup({ network })
    const controller = new AbortController()
    const test = cancelled.sandbox.selfTest({ signal: controller.signal })
    await vi.waitFor(() => expect(held).toHaveLength(1))
    controller.abort(new Error('closed'))
    expect(await rejection(test)).toEqual(new Error('closed'))
  })
})

describe('with the Lite tier and the web transport', () => {
  it('draws one budget slot per InnerTube call, the self-test included', async () => {
    const clock = createFakeClock(Date.UTC(2026, 9, 26))
    const budget = createRequestBudget({ clock })
    const { page, sandbox } = setup({
      network: async (url) =>
        url.includes('invidious')
          ? Response.json({ ok: 1 })
          : Response.json({ responseContext: {} }),
    })
    const lite = createLiteTier({ sandbox, budget })
    const transport = createWebTransport({
      fetch: vi.fn() as unknown as typeof fetch,
      lite,
      budget,
      userHosts: () => ['invidious.example:8443'],
    })
    expect(await lite.check()).toBe(true)
    expect(budget.snapshot().used).toBe(1)
    const response = await transport.fetch('https://music.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Visitor-Id': 'visitor',
        'X-YouTube-Client-Version': '1.2',
      },
      body: BODY,
    })
    expect(response.status).toBe(200)
    expect(budget.snapshot().used).toBe(2)
    const sent = page.requests[1]
    expect(sent?.url).toBe(SEARCH)
    expect(sent?.init.headers).toEqual(TEXT)
    expect(JSON.parse(String(sent?.init.body))).toMatchObject({
      context: { client: { visitorData: 'visitor', clientVersion: '1.2' } },
    })
    // A user host is not YouTube: it draws nothing.
    await transport.fetch(INSTANCE)
    expect(budget.snapshot().used).toBe(2)
    expect(page.requests[2]?.url).toBe(INSTANCE)
  })

  it('reports Lite only after the self-test passed, and never while the kill switch is on', async () => {
    let killed = true
    const { page, sandbox } = setup()
    const lite = createLiteTier({ sandbox, killSwitches: () => ({ lite: killed }) })
    const transport = createWebTransport({
      fetch: vi.fn() as unknown as typeof fetch,
      lite,
      budget: createRequestBudget(),
    })
    expect(await detectCapabilities({ platform: 'web', lite })).toMatchObject({ youtube: 'none' })
    expect(page.frames).toEqual([])
    expect(
      isFxmError(
        await rejection(transport.fetch(SEARCH, { method: 'POST', body: BODY })),
        'Unsupported',
      ),
    ).toBe(true)
    killed = false
    expect(await detectCapabilities({ platform: 'web', lite })).toMatchObject({ youtube: 'simple' })
    expect(page.requests).toHaveLength(1)
    await transport.fetch(SEARCH, { method: 'POST', body: BODY })
    expect(page.requests).toHaveLength(2)
    killed = true
    expect(lite.ready).toBe(false)
    expect(
      isFxmError(
        await rejection(transport.fetch(SEARCH, { method: 'POST', body: BODY })),
        'Unsupported',
      ),
    ).toBe(true)
    expect(page.requests).toHaveLength(2)
  })

  it('reports no Lite when InnerTube stops answering the sandbox, for the session', async () => {
    const { sandbox } = setup({
      network: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const lite = createLiteTier({ sandbox })
    expect(await detectCapabilities({ platform: 'web', lite })).toMatchObject({ youtube: 'none' })
    expect(lite.state).toBe('refused')
  })

  it('refuses a user host’s redirect as a TransportError, reaching no second host', async () => {
    const { page, sandbox } = setup({ network: async () => opaqueRedirect() })
    const transport = createWebTransport({
      fetch: vi.fn() as unknown as typeof fetch,
      lite: createLiteTier({ sandbox }),
      budget: createRequestBudget(),
      userHosts: () => ['invidious.example:8443'],
    })
    const error = await rejection(transport.fetch(INSTANCE))
    expect(isTransportError(error, 'redirect') && isSandboxError(error, 'redirect')).toBe(true)
    expect(page.requests.map(({ url }) => url)).toEqual([INSTANCE])
  })
})
