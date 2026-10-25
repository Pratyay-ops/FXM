import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestBudget } from '../budget'
import { detectCapabilities } from '../capabilities'
import { createLiteTier } from '../lite'
import { createFakeClock } from '../testing/fake-clock'
import { createWebTransport } from '../web'
import {
  INNERTUBE_DOCUMENT_POLICY,
  SANDBOX_MESSAGE,
  SANDBOX_PROTOCOL,
  type SandboxScope,
  USER_HOST_DOCUMENT_POLICY,
} from './document'
import { isSandboxError } from './errors'
import { createFakePage, FAKE_FXM_ORIGIN, type FakePage, type FakePageOptions } from './testing'
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
 * Connects to a fake page's document the way the transport does, but by hand, so tests can send
 * messages the transport would never send.
 */
async function rawConnect(page: FakePage, path = '/sandbox/innertube.html') {
  const frame = page.window.document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.src = `${FAKE_FXM_ORIGIN}${path}`
  const hello = new Promise<MessageEvent>((resolve) => {
    page.window.addEventListener('message', resolve, { once: true })
  })
  page.window.document.body.appendChild(frame)
  const event = await hello
  const { port1, port2 } = new MessageChannel()
  frame.contentWindow?.postMessage(
    { type: SANDBOX_MESSAGE.connect, protocol: SANDBOX_PROTOCOL },
    '*',
    [port2],
  )
  port1.start()
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

  it('frames nothing until the first request, then innertube.html once, opaque and hidden', async () => {
    const { page, sandbox } = setup()
    expect(page.frames).toEqual([])
    await sandbox.innerTube(simple())
    await sandbox.innerTube(simple(PLAYER))
    expect(page.frames).toHaveLength(1)
    const [frame] = page.frames
    expect(frame?.src).toBe(`${FAKE_FXM_ORIGIN}/sandbox/innertube.html`)
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
      redirect: 'error',
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
    const redirected = await sandbox.innerTube(simple())
    expect(redirected.url).toBe(SEARCH)
  })

  it('refuses other hosts, paths and preflighted shapes at once, framing nothing', async () => {
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
    ]
    for (const [request, code] of cases) {
      const error = await rejection(sandbox.innerTube(request))
      expect([request.url, isSandboxError(error, code), isFxmError(error, 'Unsupported')]).toEqual([
        request.url,
        true,
        true,
      ])
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
      'too-large',
    ])
    expect(page.requests).toEqual([])

    const userHost = await rawConnect(page, '/sandbox/userhost.html')
    expect(userHost.event.data).toMatchObject({ document: 'userhost' })
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
        documents: (url) => {
          loads += 1
          if (loads > 1) return 'innertube'
          return (scope: SandboxScope) => {
            scope.parent?.postMessage(
              { type: SANDBOX_MESSAGE.hello, protocol: SANDBOX_PROTOCOL, document: 'innertube' },
              url.origin,
            )
          }
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

  it('gives up on a document that does not load, and tries again later', async () => {
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
    expect(await selfTest).toBe(false)
    expect(page.frames[0]?.connected).toBe(false)
    silent = false
    expect(await sandbox.selfTest()).toBe(true)
    expect(page.frames).toHaveLength(2)
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
    const hello = { type: SANDBOX_MESSAGE.hello, protocol: SANDBOX_PROTOCOL, document: 'innertube' }
    page.deliver(hello, { origin: 'null', source: {} })
    page.deliver(hello, { origin: FAKE_FXM_ORIGIN, source: frame?.window })
    page.deliver({ ...hello, type: 'fxm-sandbox:hi' }, { origin: 'null', source: frame?.window })
    page.deliver('hello', { origin: 'null', source: frame?.window })
    await page.settle()
    expect(seen).toEqual([])
    clock.advance(5000)
    expect(isSandboxError(await rejection(request), 'timeout')).toBe(true)

    // A document of another protocol, or the other document, is refused.
    for (const wrong of [
      { ...hello, protocol: 2 },
      { ...hello, document: 'userhost' },
    ]) {
      const next = sandbox.innerTube(simple())
      await page.settle()
      page.deliver(wrong, { origin: 'null', source: page.frames.at(-1)?.window })
      const error = await rejection(next)
      expect(isFxmError(error, 'Unsupported')).toBe(true)
      expect(page.frames.at(-1)?.connected).toBe(false)
    }
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
          headers: [['x-ok', 'yes'], ['bad name', 'x'], ['x-number', 1], 'x', ['x-ok', 'twice']],
          body: new TextEncoder().encode('{}').buffer,
        }),
      (port, request) => port.postMessage({ type: SANDBOX_MESSAGE.error, id: request.id, code: 7 }),
      (port, request) =>
        port.postMessage({ type: SANDBOX_MESSAGE.error, id: request.id, code: 'brand-new' }),
    ]
    const { sandbox } = setup({
      documents: (url) => (scope: SandboxScope) => {
        scope.addEventListener('message', (event) => {
          const port = event.ports[0]
          if (port === undefined) return
          port.addEventListener('message', (message) => replies.shift()?.(port, message.data))
          port.start()
        })
        scope.parent?.postMessage(
          { type: SANDBOX_MESSAGE.hello, protocol: SANDBOX_PROTOCOL, document: 'innertube' },
          url.origin,
        )
      },
    })
    const malformed = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(malformed, 'network')).toBe(true)
    const tooBig = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(tooBig, 'network')).toBe(true)
    const odd = await sandbox.innerTube(simple())
    expect([odd.status, odd.statusText, odd.url, odd.headers.get('x-ok')]).toEqual([
      200,
      '',
      '',
      'yes, twice',
    ])
    const noCode = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(noCode, 'network')).toBe(true)
    const unknown = await rejection(sandbox.innerTube(simple()))
    expect(isSandboxError(unknown, 'brand-new') && isFxmError(unknown, 'Network')).toBe(true)
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

  it('fetches from user hosts through userhost.html: GET or HEAD, no headers', async () => {
    const { page, sandbox } = setup({
      network: async () => Response.json({ software: { name: 'invidious' } }),
    })
    const response = await sandbox.userHost(INSTANCE, { method: 'GET' })
    expect(await response.json()).toEqual({ software: { name: 'invidious' } })
    await sandbox.userHost(INSTANCE, { method: 'HEAD' })
    expect(page.frames).toHaveLength(1)
    expect(page.frames[0]?.src).toBe(`${FAKE_FXM_ORIGIN}/sandbox/userhost.html`)
    expect(page.requests.map(({ init }) => init)).toMatchObject([
      { method: 'GET', headers: {}, credentials: 'omit', redirect: 'follow' },
      { method: 'HEAD', headers: {}, credentials: 'omit', redirect: 'follow' },
    ])
    expect(page.requests[0]?.init.body).toBeUndefined()
    const post = await rejection(sandbox.userHost(INSTANCE, { method: 'POST' as 'GET' }))
    expect(isSandboxError(post, 'forbidden-method')).toBe(true)
    const http = await rejection(sandbox.userHost('http://invidious.example/', { method: 'GET' }))
    expect(isSandboxError(http, 'forbidden-host')).toBe(true)
    expect(USER_HOST_DOCUMENT_POLICY.redirect).toBe('follow')
  })

  it('frames documents from the page’s own origin only', async () => {
    const page = createFakePage()
    const elsewhere = createSandboxTransport({
      window: page.window,
      innerTube: { url: 'https://elsewhere.example/sandbox/innertube.html' },
    })
    cleanups.push(() => elsewhere.dispose())
    expect(isFxmError(await rejection(elsewhere.innerTube(simple())), 'Unsupported')).toBe(true)
    expect(await elsewhere.selfTest()).toBe(false)
    const relative = createSandboxTransport({
      window: page.window,
      innerTube: { url: '/preview/sandbox/innertube.html' },
    })
    cleanups.push(() => relative.dispose())
    void relative.innerTube(simple()).catch(() => undefined)
    await vi.waitFor(() => expect(page.frames).toHaveLength(1))
    expect(page.frames[0]?.src).toBe(`${FAKE_FXM_ORIGIN}/preview/sandbox/innertube.html`)
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
})

describe('selfTest', () => {
  it('sends one real request, by default a YouTube Music suggestion request', async () => {
    const { page, sandbox } = setup()
    expect(await sandbox.selfTest()).toBe(true)
    expect(page.requests).toHaveLength(1)
    const expected = defaultSelfTestRequest()
    expect(page.requests[0]?.url).toBe(expected.url)
    expect(page.requests[0]?.init.body).toBe(expected.init.body)
    expect(JSON.parse(expected.init.body)).toMatchObject({
      context: { client: { clientName: 'WEB_REMIX' } },
    })
  })

  it('passes only for a usable answer', async () => {
    const answers = [
      () => Response.json({ responseContext: {} }, { status: 403 }),
      () => Response.json({ error: { code: 400 } }),
      () => new Response('<html>'),
      () => Response.json([]),
    ]
    const { sandbox } = setup({ network: async () => (answers.shift() as () => Response)() })
    for (let index = 0; index < 4; index += 1) expect(await sandbox.selfTest()).toBe(false)
    const failing = setup({
      network: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(await failing.sandbox.selfTest()).toBe(false)
  })

  it('sends the request the app gives, and rejects only when cancelled', async () => {
    const request = simple(PLAYER)
    const { page, sandbox } = setup({}, { selfTestRequest: request })
    expect(await sandbox.selfTest()).toBe(true)
    const built = setup({}, { selfTestRequest: async () => simple(SEARCH) })
    expect(await built.sandbox.selfTest()).toBe(true)
    expect([page.requests[0]?.url, built.page.requests[0]?.url]).toEqual([PLAYER, SEARCH])
    const broken = setup({}, { selfTestRequest: simple('https://example.com/') })
    expect(await broken.sandbox.selfTest()).toBe(false)
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
    const transport = createWebTransport({ fetch: vi.fn() as unknown as typeof fetch, lite })
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

  it('reports no Lite when InnerTube stops answering the sandbox', async () => {
    const { sandbox } = setup({
      network: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const lite = createLiteTier({ sandbox })
    expect(await detectCapabilities({ platform: 'web', lite })).toMatchObject({ youtube: 'none' })
  })
})
