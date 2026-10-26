import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestBudget } from './budget'
import { isCorsSimpleRequest } from './cors'
import {
  createDesktopFetch,
  createDesktopUserHosts,
  DESKTOP_COMMANDS,
  DESKTOP_CONNECT_TIMEOUT_MS,
  decodeUserHostResponse,
  describeUrl,
  desktopBrowserUserAgent,
  desktopHeaders,
  FALLBACK_BROWSER_USER_AGENT,
  fxmUserAgent,
  isTauriRuntime,
  type PluginFetchInit,
  redactUrls,
  sendsBrowserAgent,
  siteOrigin,
  type TauriBindings,
} from './desktop'
import { isTransportError } from './errors'
import { HOST_RULES, type HostRule } from './hosts'
import { SIMPLE_CONTENT_TYPE } from './innertube'
import type { NativeRequestInit } from './native'
import { createPlatform } from './platform'
import { memoryStorage } from './storage'
import { createTauriTransport } from './tauri'

const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const APP = 'FXM/9.9.9 ( https://github.com/Pratyay-ops/FXM )'
const AGENTS = { browserAgent: BROWSER, appAgent: APP }

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const SW_JS_DATA = 'https://www.youtube.com/sw.js_data'
const MEDIA = 'https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback?itag=251&clen=3000000'
const TOKEN = 'https://open.spotify.com/api/token?reason=init&productType=web-player'
const LYRICS = 'https://lrclib.net/api/get?track_name=Creep&artist_name=Radiohead'
const INSTANCE = 'https://invidious.example.org/api/v1/stats'

const BODY = JSON.stringify({
  context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20261020.01.00' } },
  query: 'creep',
})

type Respond = (url: string, init: PluginFetchInit) => Response | Promise<Response>
type Answer = (command: string, args: Record<string, unknown> | undefined) => unknown

/** A fake of Tauri's bindings: the HTTP plugin's `fetch` and `invoke`, recording every call. */
function fakeTauri(respond: Respond = () => Response.json({ ok: true }), answer?: Answer) {
  const fetches: { url: string; init: PluginFetchInit }[] = []
  const invokes: { command: string; args: Record<string, unknown> | undefined }[] = []
  const tauri: TauriBindings = {
    fetch: async (url, init) => {
      fetches.push({ url, init })
      return respond(url, init)
    },
    invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      invokes.push({ command, args })
      return (await answer?.(command, args)) as T
    },
  }
  return { tauri, fetches, invokes }
}

/** A request as the native transport hands it over: by default a plain GET with no `Origin`. */
function nativeInit(init: Partial<NativeRequestInit> = {}): NativeRequestInit {
  return {
    method: 'GET',
    headers: {},
    origin: null,
    route: 'open',
    credentials: 'omit',
    redirect: 'manual',
    ...init,
  }
}

/** A `user_host_fetch` answer: the length of the JSON head, the head, then the body. */
function frame(
  head: { status: number; statusText: string; url: string; headers: [string, string][] },
  body: Uint8Array | string = '',
): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(head))
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const out = new Uint8Array(4 + json.byteLength + bytes.byteLength)
  new DataView(out.buffer).setUint32(0, json.byteLength)
  out.set(json, 4)
  out.set(bytes, 4 + json.byteLength)
  return out.buffer
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

/** The row of the host table for `host`. */
function rule(host: string): HostRule {
  const found = HOST_RULES.find((candidate) => candidate.host === host)
  if (found === undefined) throw new Error(`${host} is not in the host table`)
  return found
}

/**
 * A body like the plugin's: one chunk, then whatever `fail` errors it with. The plugin errors its
 * stream with the string 'Request cancelled' on abort, and with the IPC's rejection otherwise.
 */
function pluginBody() {
  let fail: (reason: unknown) => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      fail = (reason) => controller.error(reason)
    },
  })
  return { stream, fail: (reason: unknown) => fail(reason) }
}

describe('siteOrigin', () => {
  it('keeps the https origin of a real site', () => {
    expect(siteOrigin('https://open.spotify.com')).toBe('https://open.spotify.com')
    expect(siteOrigin('https://www.youtube.com')).toBe('https://www.youtube.com')
  })

  it.each([
    undefined,
    null,
    '',
    'null',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'http://localhost:5260',
    'https://localhost',
    'http://open.spotify.com',
    'https://open.spotify.com/',
    'https://user@open.spotify.com',
    'not an origin',
  ])('never lets a webview or malformed origin %j through', (origin) => {
    expect(siteOrigin(origin)).toBe('')
  })
})

describe('desktopBrowserUserAgent', () => {
  it('keeps a webview agent that reads as a browser: WebView2 and WebKitGTK', () => {
    const webView2 =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0'
    const webKitGtk =
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    expect(desktopBrowserUserAgent(webView2)).toBe(webView2)
    expect(desktopBrowserUserAgent(webKitGtk)).toBe(webKitGtk)
  })

  it('completes macOS WKWebView’s agent to Safari’s', () => {
    const wkWebView =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
    expect(desktopBrowserUserAgent(wkWebView)).toBe(`${wkWebView} Version/26.0 Safari/605.1.15`)
  })

  it.each([undefined, '', 'Node.js/22', 'Mozilla/5.0 (X11) Something/1'])(
    'falls back to a desktop Chrome for %j',
    (agent) => {
      expect(desktopBrowserUserAgent(agent)).toBe(FALLBACK_BROWSER_USER_AGENT)
    },
  )
})

describe('fxmUserAgent', () => {
  it('names FXM and where to find it, as MusicBrainz asks', () => {
    expect(fxmUserAgent('0.6.0')).toBe('FXM/0.6.0 ( https://github.com/Pratyay-ops/FXM )')
    expect(fxmUserAgent()).toBe('FXM ( https://github.com/Pratyay-ops/FXM )')
  })
})

describe('sendsBrowserAgent', () => {
  // Every host in the table, by the agent it gets. A host added to the table fails this test until
  // it is placed in one list or the other.
  const BROWSER_HOSTS = [
    'www.youtube.com',
    'music.youtube.com',
    'youtubei.googleapis.com',
    '*.googlevideo.com',
    'i.ytimg.com',
    '*.ggpht.com',
    'open.spotify.com',
    'clienttoken.spotify.com',
    'api-partner.spotify.com',
    'spclient.wg.spotify.com',
    'i.scdn.co',
    'www.last.fm',
  ]
  const APP_HOSTS = [
    'musicbrainz.org',
    'coverartarchive.org',
    'api.listenbrainz.org',
    'labs.api.listenbrainz.org',
    'ws.audioscrobbler.com',
    'lrclib.net',
    'archive.org',
    '*.archive.org',
    'api.jamendo.com',
    '*.jamendo.com',
    'itunes.apple.com',
    'sponsor.ajay.app',
  ]

  it('places every host in the table', () => {
    expect(HOST_RULES.map((row) => row.host).sort()).toEqual(
      [...BROWSER_HOSTS, ...APP_HOSTS].sort(),
    )
  })

  it.each(BROWSER_HOSTS)(
    'gives %s, run by YouTube, Spotify or Last.fm’s player, a browser agent',
    (host) => {
      expect(sendsBrowserAgent(rule(host))).toBe(true)
    },
  )

  it.each(APP_HOSTS)('gives %s, which asks apps to name themselves, FXM’s agent', (host) => {
    expect(sendsBrowserAgent(rule(host))).toBe(false)
  })
})

describe('desktopHeaders', () => {
  const none = { headers: {}, origin: null }

  it('sends no Origin and a browser agent to YouTube, and never a cookie or a Host', () => {
    expect(
      desktopHeaders(
        {
          headers: {
            'Content-Type': SIMPLE_CONTENT_TYPE,
            Cookie: 'VISITOR_INFO1_LIVE=x',
            Host: 'evil.example',
          },
          origin: null,
        },
        rule('music.youtube.com'),
        AGENTS,
      ),
    ).toEqual({ 'content-type': SIMPLE_CONTENT_TYPE, origin: '', 'user-agent': BROWSER })
  })

  it('replaces a webview origin, or a missing one, with none', () => {
    expect(
      desktopHeaders(
        { headers: {}, origin: 'tauri://localhost' },
        rule('music.youtube.com'),
        AGENTS,
      ).origin,
    ).toBe('')
    expect(desktopHeaders(none, rule('*.googlevideo.com'), AGENTS)).toEqual({
      origin: '',
      'user-agent': BROWSER,
    })
  })

  it('takes the Origin from init.origin only, never from the headers', () => {
    const headers = { Origin: 'https://open.spotify.com' }
    expect(desktopHeaders({ headers, origin: null }, rule('open.spotify.com'), AGENTS)).toEqual({
      origin: '',
      'user-agent': BROWSER,
    })
  })

  it('keeps Spotify’s own origin and gives it a browser agent', () => {
    expect(
      desktopHeaders(
        { headers: {}, origin: 'https://open.spotify.com' },
        rule('open.spotify.com'),
        AGENTS,
      ),
    ).toEqual({ origin: 'https://open.spotify.com', 'user-agent': BROWSER })
  })

  it('gives YouTube’s and Spotify’s images a browser agent, and other hosts FXM’s', () => {
    for (const host of ['i.ytimg.com', '*.ggpht.com', 'i.scdn.co', 'www.last.fm']) {
      expect(desktopHeaders(none, rule(host), AGENTS)['user-agent'], host).toBe(BROWSER)
    }
    for (const host of ['lrclib.net', 'musicbrainz.org', 'ws.audioscrobbler.com']) {
      expect(desktopHeaders(none, rule(host), AGENTS)['user-agent'], host).toBe(APP)
    }
  })

  it('keeps an agent the request names', () => {
    const headers = { 'User-Agent': 'FXM/1.0' }
    expect(
      desktopHeaders({ headers, origin: null }, rule('open.spotify.com'), AGENTS)['user-agent'],
    ).toBe('FXM/1.0')
  })
})

describe('describeUrl and redactUrls', () => {
  it('keep a URL’s scheme, host and path, never its credentials, query or fragment', () => {
    expect(describeUrl(`${MEDIA}&ip=203.0.113.7&sig=AB#t=1`)).toBe(
      'https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback',
    )
    expect(describeUrl('https://user:pass@inv.example.org:8443/a?b')).toBe(
      'https://inv.example.org:8443/a',
    )
    expect(describeUrl('not a url?x=1')).toBe('not a url')
  })

  it('shorten every URL in a message, and leave the rest of it', () => {
    expect(
      redactUrls(
        'error sending request for url (https://lrclib.net/api/get?track_name=Creep&artist_name=Radiohead): dns error',
      ),
    ).toBe('error sending request for url (https://lrclib.net/api/get): dns error')
    expect(redactUrls(`${MEDIA}&ip=203.0.113.7 then https://archive.org/x?y`)).toBe(
      'https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback then https://archive.org/x',
    )
  })
})

describe('createDesktopFetch through the HTTP plugin', () => {
  it('passes headers only as a plain init.headers object, with the request’s parts', async () => {
    const { tauri, fetches } = fakeTauri()
    const http = createDesktopFetch({ tauri, browserUserAgent: BROWSER, appUserAgent: APP })
    const signal = new AbortController().signal
    await http(
      SEARCH,
      nativeInit({
        method: 'POST',
        headers: { 'content-type': SIMPLE_CONTENT_TYPE },
        route: 'innertube',
        body: BODY,
        signal,
      }),
    )
    const [call] = fetches
    expect(call?.url).toBe(SEARCH)
    expect(call?.init.headers).toEqual({
      'content-type': SIMPLE_CONTENT_TYPE,
      origin: '',
      'user-agent': BROWSER,
    })
    expect(Object.getPrototypeOf(call?.init.headers)).toBe(Object.prototype)
    expect(call?.init).toMatchObject({ method: 'POST', body: BODY, signal })
    expect(call?.init.connectTimeout).toBe(DESKTOP_CONNECT_TIMEOUT_MS)
    expect(call?.init.maxRedirections).toBe(0)
  })

  it('sends InnerTube calls in the simple shape, with no Origin, drawing on the budget', async () => {
    const { tauri, fetches } = fakeTauri()
    const budget = createRequestBudget()
    const transport = createTauriTransport({
      http: createDesktopFetch({ tauri, browserUserAgent: BROWSER }),
      budget,
    })
    await transport.fetch(SEARCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Visitor-Id': 'CgtWaXNpdG9y',
        Origin: 'tauri://localhost',
      },
      body: BODY,
    })
    const [call] = fetches
    expect(call?.url).toBe(`${SEARCH}?prettyPrint=false`)
    const headers = call?.init.headers as Record<string, string>
    expect(headers).toEqual({
      'content-type': SIMPLE_CONTENT_TYPE,
      origin: '',
      'user-agent': BROWSER,
    })
    const rest = Object.entries(headers).filter(
      ([name]) => !['origin', 'user-agent'].includes(name),
    )
    expect(isCorsSimpleRequest('POST', rest)).toBe(true)
    expect(JSON.parse(String(call?.init.body)).context.client.visitorData).toBe('CgtWaXNpdG9y')
    expect(budget.snapshot().used).toBe(1)
  })

  it('reads sw.js_data with a browser agent, as YouTube’s own pages do', async () => {
    const { tauri, fetches } = fakeTauri(() => new Response(`)]}'\n[["x"]]`))
    const transport = createTauriTransport({
      http: createDesktopFetch({ tauri, browserUserAgent: BROWSER }),
      budget: createRequestBudget(),
    })
    const response = await transport.fetch(SW_JS_DATA)
    expect(await response.text()).toMatch(/^\)\]\}'/)
    expect(fetches[0]?.init.headers).toEqual({ origin: '', 'user-agent': BROWSER })
    expect(transport.budget.snapshot().used).toBe(1)
  })

  it('gives Spotify its own origin and a browser agent', async () => {
    const { tauri, fetches } = fakeTauri()
    const transport = createTauriTransport({
      http: createDesktopFetch({ tauri, browserUserAgent: BROWSER }),
      budget: createRequestBudget(),
    })
    await transport.fetch(TOKEN)
    expect(fetches[0]?.init.headers).toEqual({
      origin: 'https://open.spotify.com',
      'user-agent': BROWSER,
    })
  })

  it('probes the end of a googlevideo file and reads the bytes as they are', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const { tauri, fetches } = fakeTauri(
      () =>
        new Response(bytes, {
          status: 206,
          statusText: 'Partial Content',
          headers: { 'content-range': 'bytes 2934464-2999999/3000000' },
        }),
    )
    const transport = createTauriTransport({
      http: createDesktopFetch({ tauri, browserUserAgent: BROWSER }),
      budget: createRequestBudget(),
    })
    const response = await transport.fetch(MEDIA, {
      headers: { Range: 'bytes=2934464-2999999' },
    })
    expect(fetches[0]?.init.headers).toEqual({
      range: 'bytes=2934464-2999999',
      origin: '',
      'user-agent': BROWSER,
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2934464-2999999/3000000')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(transport.budget.snapshot().used).toBe(0)
  })

  it('gives CORS-friendly hosts FXM’s own agent', async () => {
    const { tauri, fetches } = fakeTauri()
    const transport = createTauriTransport({
      http: createDesktopFetch({ tauri, appUserAgent: APP }),
      budget: createRequestBudget(),
    })
    await transport.fetch(LYRICS)
    expect(fetches[0]?.init.headers).toEqual({ origin: '', 'user-agent': APP })
  })

  it('never hands Set-Cookie to the page, and keeps the status, headers and final URL', async () => {
    const response = new Response('{"ok":true}', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'x-kept': 'yes' },
    })
    Object.defineProperty(response, 'url', { value: `${SW_JS_DATA}?redirected=1` })
    // The plugin exposes Set-Cookie, which a constructed Response would drop.
    Object.defineProperty(response, 'headers', {
      value: new Headers([
        ['content-type', 'application/json'],
        ['x-kept', 'yes'],
        ['set-cookie', 'YSC=abc; Secure'],
      ]),
    })
    const { tauri } = fakeTauri(() => response)
    const page = await createDesktopFetch({ tauri })(SW_JS_DATA, nativeInit())
    expect(page.status).toBe(200)
    expect(page.statusText).toBe('OK')
    expect(page.headers.get('set-cookie')).toBeNull()
    expect(page.headers.get('x-kept')).toBe('yes')
    expect(page.url).toBe(`${SW_JS_DATA}?redirected=1`)
    const copy = page.clone()
    expect(copy.url).toBe(`${SW_JS_DATA}?redirected=1`)
    expect(copy.clone().url).toBe(`${SW_JS_DATA}?redirected=1`)
    expect(await copy.json()).toEqual({ ok: true })
    expect(await page.json()).toEqual({ ok: true })
  })

  it('falls back to the request URL when the plugin gives none, and keeps empty bodies empty', async () => {
    const { tauri } = fakeTauri(() => new Response(null, { status: 204 }))
    const page = await createDesktopFetch({ tauri })(LYRICS, nativeInit())
    expect(page.url).toBe(LYRICS)
    expect(page.status).toBe(204)
    expect(page.body).toBeNull()
  })

  it('hands every redirect back as it is, with its Location', async () => {
    const respond = () =>
      new Response(null, { status: 302, headers: { location: 'https://archive.org/x' } })
    const { tauri, fetches } = fakeTauri(respond)
    const response = await createDesktopFetch({ tauri })(LYRICS, nativeInit())
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://archive.org/x')
    expect(response.url).toBe(LYRICS)
    expect(fetches).toHaveLength(1)
    expect(fetches[0]?.init.maxRedirections).toBe(0)
  })

  it('lets the transport follow redirects hop by hop, within the host table', async () => {
    const DOWNLOAD = 'https://archive.org/download/bell/bell.mp3'
    const STORAGE = 'https://dn710102.ca.archive.org/0/items/bell/bell.mp3'
    const { tauri, fetches } = fakeTauri((url) =>
      url === DOWNLOAD
        ? new Response(null, { status: 302, headers: { location: STORAGE } })
        : new Response(new Uint8Array([1, 2]), { status: 206 }),
    )
    const transport = createTauriTransport({
      http: createDesktopFetch({ tauri, appUserAgent: APP }),
      budget: createRequestBudget(),
    })
    const response = await transport.fetch(DOWNLOAD, { headers: { Range: 'bytes=-65536' } })
    expect(response.status).toBe(206)
    expect(response.url).toBe(STORAGE)
    expect(fetches.map((call) => call.url)).toEqual([DOWNLOAD, STORAGE])
    for (const call of fetches) {
      expect(call.init.maxRedirections).toBe(0)
      expect(call.init.headers).toEqual({
        range: 'bytes=-65536',
        origin: '',
        'user-agent': APP,
      })
    }
  })

  it('never sends a redirect out of the host table', async () => {
    const { tauri, fetches } = fakeTauri(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    )
    const transport = createTauriTransport({
      http: createDesktopFetch({ tauri }),
      budget: createRequestBudget(),
    })
    const error = await rejection(transport.fetch(LYRICS))
    expect(isTransportError(error, 'redirect')).toBe(true)
    expect(fetches).toHaveLength(1)
  })

  it('reports an address the scope refuses as a TransportError (unknown-host)', async () => {
    const refusal = `url not allowed on the configured scope: ${MEDIA}&ip=203.0.113.7`
    const { tauri } = fakeTauri(() => {
      throw refusal
    })
    const error = await rejection(createDesktopFetch({ tauri })(MEDIA, nativeInit()))
    expect(isTransportError(error, 'unknown-host')).toBe(true)
    expect((error as Error).message).toBe(
      'The desktop app does not contact https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback',
    )
    expect((error as Error).cause).toBe(refusal)
  })

  it('rejects like fetch when the network fails, naming URLs without their query', async () => {
    const failure = 'error sending request for url (https://lrclib.net/api/get?track_name=Creep)'
    const { tauri } = fakeTauri(() => {
      throw failure
    })
    const error = await rejection(createDesktopFetch({ tauri })(LYRICS, nativeInit()))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe(
      'Network request failed: error sending request for url (https://lrclib.net/api/get)',
    )
    expect((error as Error).cause).toBe(failure)
    const own = new TypeError(`Failed to parse URL from ${MEDIA}`)
    const { tauri: throwing } = fakeTauri(() => {
      throw own
    })
    const wrapped = await rejection(createDesktopFetch({ tauri: throwing })(LYRICS, nativeInit()))
    expect(wrapped).toBeInstanceOf(TypeError)
    expect((wrapped as Error).message).not.toContain('itag')
    expect((wrapped as Error).cause).toBe(own)
  })

  it('rejects a body read with the signal’s reason when the request is aborted', async () => {
    const body = pluginBody()
    const aborter = new AbortController()
    // As the plugin does: an abort errors its body stream with a bare string.
    aborter.signal.addEventListener('abort', () => body.fail('Request cancelled'))
    const { tauri } = fakeTauri(() => new Response(body.stream, { status: 206 }))
    const response = await createDesktopFetch({ tauri })(
      MEDIA,
      nativeInit({ signal: aborter.signal }),
    )
    aborter.abort()
    const error = await rejection(response.arrayBuffer())
    expect(error).toBe(aborter.signal.reason)
    expect((error as DOMException).name).toBe('AbortError')
  })

  it('rejects a body read that fails with a TypeError, as fetch does', async () => {
    const body = pluginBody()
    const { tauri } = fakeTauri(() => new Response(body.stream))
    const response = await createDesktopFetch({ tauri })(MEDIA, nativeInit())
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]))
    const failure = `error decoding response body for url (${MEDIA}&ip=203.0.113.7)`
    body.fail(failure)
    const error = await rejection(reader.read())
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe(
      'Reading the response failed: error decoding response body for url (https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback)',
    )
    expect((error as Error).cause).toBe(failure)
  })

  it('cancels the plugin’s body when the page cancels the response’s', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const { tauri } = fakeTauri(() => new Response(stream))
    const response = await createDesktopFetch({ tauri })(MEDIA, nativeInit())
    await response.body?.cancel('done')
    expect(cancel).toHaveBeenCalledWith('done')
  })

  it('rejects with the signal’s reason when the request is aborted', async () => {
    const before = new AbortController()
    before.abort(new DOMException('gone', 'AbortError'))
    const loader = vi.fn(async () => fakeTauri().tauri)
    const early = await rejection(
      createDesktopFetch({ tauri: loader })(LYRICS, nativeInit({ signal: before.signal })),
    )
    expect(early).toBe(before.signal.reason)
    expect(loader).not.toHaveBeenCalled()

    const during = new AbortController()
    const { tauri } = fakeTauri(() => {
      during.abort()
      throw new Error('Request cancelled')
    })
    const late = await rejection(
      createDesktopFetch({ tauri })(LYRICS, nativeInit({ signal: during.signal })),
    )
    expect(late).toBe(during.signal.reason)
    expect((late as DOMException).name).toBe('AbortError')
  })

  it('loads Tauri’s bindings once, on the first request, and again after a failed load', async () => {
    const { tauri } = fakeTauri()
    const loader = vi
      .fn<() => Promise<TauriBindings>>()
      .mockRejectedValueOnce(new Error('not in Tauri'))
      .mockResolvedValue(tauri)
    const http = createDesktopFetch({ tauri: loader })
    expect(loader).not.toHaveBeenCalled()
    await expect(http(LYRICS, nativeInit())).rejects.toThrow('not in Tauri')
    await http(LYRICS, nativeInit())
    await http(LYRICS, nativeInit())
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('refuses a URL that is not absolute before anything else', async () => {
    const { tauri, fetches } = fakeTauri()
    const error = await rejection(createDesktopFetch({ tauri })('/relative', nativeInit()))
    expect(isTransportError(error, 'bad-request')).toBe(true)
    expect(fetches).toHaveLength(0)
  })
})

describe('createDesktopFetch for hosts the user approved', () => {
  const head = {
    status: 200,
    statusText: 'OK',
    url: INSTANCE,
    headers: [
      ['content-type', 'application/json'],
      ['set-cookie', 'session=1'],
    ] as [string, string][],
  }

  it('sends any other host to the user_host_fetch command, GET only and without headers', async () => {
    const { tauri, fetches, invokes } = fakeTauri(undefined, () => frame(head, '{"version":"2"}'))
    const transport = createTauriTransport({
      http: createDesktopFetch({ tauri }),
      budget: createRequestBudget(),
      userHosts: () => ['invidious.example.org'],
    })
    const response = await transport.fetch(INSTANCE, { headers: { Authorization: 'x' } })
    expect(fetches).toHaveLength(0)
    expect(invokes).toEqual([
      {
        command: DESKTOP_COMMANDS.userHostFetch,
        args: { request: { url: INSTANCE, method: 'GET' } },
      },
    ])
    expect(response.status).toBe(200)
    expect(response.url).toBe(INSTANCE)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toEqual({ version: '2' })
  })

  it('sends a user route through the command, even to a host on the table', async () => {
    const { tauri, fetches, invokes } = fakeTauri(undefined, () => frame({ ...head, url: LYRICS }))
    await createDesktopFetch({ tauri })(LYRICS, nativeInit({ route: 'user' }))
    expect(fetches).toHaveLength(0)
    expect(invokes.map((call) => call.command)).toEqual([DESKTOP_COMMANDS.userHostFetch])
  })

  it('refuses other methods itself', async () => {
    const { tauri, invokes } = fakeTauri()
    const error = await rejection(
      createDesktopFetch({ tauri })(
        INSTANCE,
        nativeInit({ method: 'POST', body: 'x', route: 'user' }),
      ),
    )
    expect(isTransportError(error, 'bad-request')).toBe(true)
    expect(invokes).toHaveLength(0)
  })

  it.each([
    [{ code: 'not-approved', message: 'not approved' }, 'unknown-host'],
    [{ code: 'bad-request', message: 'only HTTPS' }, 'bad-request'],
  ] as const)('maps the command’s %j to a TransportError (%s)', async (failure, reason) => {
    const { tauri } = fakeTauri(undefined, () => Promise.reject(failure))
    const error = await rejection(
      createDesktopFetch({ tauri })(INSTANCE, nativeInit({ route: 'user' })),
    )
    expect(isTransportError(error, reason)).toBe(true)
    expect((error as Error).message).toBe(failure.message)
    expect((error as Error).cause).toBe(failure)
  })

  it.each([
    [{ code: 'forbidden-address', message: 'private address' }, 'Unsupported'],
    [{ code: 'proxy-configured', message: 'a proxy is set' }, 'Unsupported'],
    [{ code: 'too-large', message: 'over 8 MiB' }, 'Parse'],
  ] as const)('maps the command’s %j to a %s FxmError', async (failure, code) => {
    const { tauri } = fakeTauri(undefined, () => Promise.reject(failure))
    const error = await rejection(
      createDesktopFetch({ tauri })(INSTANCE, nativeInit({ route: 'user' })),
    )
    expect(isFxmError(error, code)).toBe(true)
    expect(isTransportError(error)).toBe(false)
    expect((error as Error).message).toBe(failure.message)
  })

  it('hands a redirect back, which the transport follows on the same host only', async () => {
    const MOVED = 'https://invidious.example.org/api/v1/stats/'
    const OTHER = 'https://gist.example.org/raw'
    const redirect = (location: string) =>
      frame({
        status: 301,
        statusText: 'Moved Permanently',
        url: INSTANCE,
        headers: [['location', location]],
      })
    const { tauri, invokes } = fakeTauri(undefined, (_, args) => {
      const { url } = (args?.request ?? {}) as { url?: string }
      if (url === INSTANCE) return redirect(MOVED)
      if (url === MOVED) return redirect(OTHER)
      return frame(head)
    })
    const http = createDesktopFetch({ tauri })
    const raw = await http(INSTANCE, nativeInit({ route: 'user' }))
    expect(raw.status).toBe(301)
    expect(raw.headers.get('location')).toBe(MOVED)

    const transport = createTauriTransport({
      http,
      budget: createRequestBudget(),
      userHosts: () => ['invidious.example.org', 'gist.example.org'],
    })
    const error = await rejection(transport.fetch(INSTANCE))
    expect(isTransportError(error, 'redirect')).toBe(true)
    const urls = invokes.map(({ args }) => (args?.request as { url?: string } | undefined)?.url)
    expect(urls).toEqual([INSTANCE, INSTANCE, MOVED])
  })

  it('rejects like fetch when the command’s network request fails, or the command does', async () => {
    const network = fakeTauri(undefined, () =>
      Promise.reject({ code: 'network', message: 'timed out' }),
    )
    const error = await rejection(
      createDesktopFetch({ tauri: network.tauri })(INSTANCE, nativeInit({ route: 'user' })),
    )
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe('timed out')
    const broken = fakeTauri(undefined, () => Promise.reject('command user_host_fetch not found'))
    expect(
      await rejection(
        createDesktopFetch({ tauri: broken.tauri })(INSTANCE, nativeInit({ route: 'user' })),
      ),
    ).toBeInstanceOf(TypeError)
  })

  it('hands header bytes over as browsers do: one character per byte', async () => {
    // Rust sends each byte of a header value as one character (U+0000 to U+00FF), so the UTF-8
    // bytes of 日本 arrive as six characters, and Headers accepts every value.
    const latin1 = String.fromCharCode(...new TextEncoder().encode('日本.mp3'))
    const { tauri } = fakeTauri(undefined, () =>
      frame({
        ...head,
        headers: [['content-disposition', `attachment; filename="${latin1}"`]],
      }),
    )
    const response = await createDesktopFetch({ tauri })(INSTANCE, nativeInit({ route: 'user' }))
    const value = response.headers.get('content-disposition') ?? ''
    const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe('attachment; filename="日本.mp3"')
  })

  it('stops waiting for the command when the request is aborted', async () => {
    const early = new AbortController()
    const first = fakeTauri(undefined, () => new Promise(() => {}))
    const before = createDesktopFetch({ tauri: first.tauri })(
      INSTANCE,
      nativeInit({ signal: early.signal, route: 'user' }),
    )
    early.abort()
    expect(await rejection(before)).toBe(early.signal.reason)
    expect(first.invokes).toHaveLength(0)

    const late = new AbortController()
    const second = fakeTauri(undefined, () => new Promise(() => {}))
    const during = createDesktopFetch({ tauri: second.tauri })(
      INSTANCE,
      nativeInit({ signal: late.signal, route: 'user' }),
    )
    await vi.waitFor(() => expect(second.invokes).toHaveLength(1))
    late.abort()
    expect(await rejection(during)).toBe(late.signal.reason)
  })
})

describe('decodeUserHostResponse', () => {
  const head = { status: 404, statusText: 'Not Found', url: '', headers: [] }

  it('reads the head and the body, from bytes however they arrive', async () => {
    const raw = frame(head, new Uint8Array([7, 8, 9]))
    for (const form of [raw, new Uint8Array(raw), [...new Uint8Array(raw)]]) {
      const response = decodeUserHostResponse(form, INSTANCE)
      expect(response.status).toBe(404)
      expect(response.statusText).toBe('Not Found')
      expect(response.url).toBe(INSTANCE)
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8, 9])
    }
    const padded = new Uint8Array(raw.byteLength + 3)
    padded.set(new Uint8Array(raw), 3)
    expect(decodeUserHostResponse(padded.subarray(3), INSTANCE).status).toBe(404)
  })

  it.each([
    ['nothing', new ArrayBuffer(2)],
    ['a length past the end', new Uint8Array([0, 0, 1, 0, 123]).buffer],
    ['a head that is not JSON', new Uint8Array([0, 0, 0, 1, 123]).buffer],
    ['a head without a status', frame({ ...head, status: 0 })],
    ['malformed headers', frame({ ...head, headers: [['x']] as unknown as [string, string][] })],
    ['a header value beyond U+00FF', frame({ ...head, headers: [['x-name', '日本']] })],
    ['a header value with a line break', frame({ ...head, headers: [['x-name', 'a\r\nb']] })],
    ['a header name that is not a token', frame({ ...head, headers: [['x name', 'a']] })],
    ['something other than bytes', 'text'],
  ])('refuses %s with its own error', (_, raw) => {
    expect(() => decodeUserHostResponse(raw, INSTANCE)).toThrow(
      /^The desktop app answered with (a malformed response|something other than bytes)$/,
    )
  })
})

describe('createDesktopUserHosts', () => {
  function hostsApp(initial: string[] = []) {
    let hosts = [...initial]
    return fakeTauri(undefined, (command, args) => {
      const host = String(args?.host)
      if (command === DESKTOP_COMMANDS.userHosts) return hosts
      if (command === DESKTOP_COMMANDS.approveUserHost) {
        if (host === 'nope.example.org') return null
        if (host === '127.0.0.1') {
          return Promise.reject({ code: 'invalid-host', message: 'not a public domain name' })
        }
        hosts.push(host.toLowerCase())
        return host.toLowerCase()
      }
      if (command === DESKTOP_COMMANDS.revokeUserHost) hosts = hosts.filter((h) => h !== host)
      return undefined
    })
  }

  it('loads the approved hosts', async () => {
    const { tauri } = hostsApp(['invidious.example.org'])
    const hosts = createDesktopUserHosts({ tauri })
    expect(hosts.current()).toEqual([])
    expect(await hosts.refresh()).toEqual(['invidious.example.org'])
    expect(hosts.current()).toEqual(['invidious.example.org'])
    expect(Object.isFrozen(hosts.current())).toBe(true)
  })

  it('approves through the native dialog, and revokes', async () => {
    const { tauri, invokes } = hostsApp()
    const hosts = createDesktopUserHosts({ tauri })
    expect(await hosts.approve('Gist.Example.ORG')).toBe('gist.example.org')
    expect(invokes[0]).toEqual({
      command: DESKTOP_COMMANDS.approveUserHost,
      args: { host: 'Gist.Example.ORG' },
    })
    expect(hosts.current()).toEqual(['gist.example.org'])
    expect(await hosts.approve('nope.example.org')).toBeUndefined()
    expect(hosts.current()).toEqual(['gist.example.org'])
    await hosts.revoke('gist.example.org')
    expect(hosts.current()).toEqual([])
  })

  it('reports a host FXM can’t contact as Unsupported, and a malformed list', async () => {
    const hosts = createDesktopUserHosts({ tauri: hostsApp().tauri })
    const error = await rejection(hosts.approve('127.0.0.1'))
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    expect((error as Error).message).toBe('not a public domain name')
    const broken = createDesktopUserHosts({ tauri: fakeTauri(undefined, () => [1, 2]).tauri })
    expect(await rejection(broken.refresh())).toBeInstanceOf(TypeError)
  })
})

/** What `@tauri-apps/plugin-http` sends to Rust with `plugin:http|fetch`. */
interface ClientConfig {
  readonly method: string
  readonly url: string
  readonly headers: readonly (readonly [string, string])[]
  readonly data: readonly number[] | null
  readonly connectTimeout?: number
  readonly maxRedirections?: number
}

/**
 * A fake of Tauri's IPC (`window.__TAURI_INTERNALS__`) that answers the HTTP plugin's commands
 * the way its Rust side does, so the plugin's real JavaScript runs on top of it.
 */
function fakeIpc(responseBody: string) {
  const configs: ClientConfig[] = []
  const commands: string[] = []
  const body = [...new TextEncoder().encode(responseBody)]
  let reads = 0
  const internals = {
    invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      commands.push(command)
      switch (command) {
        case 'plugin:http|fetch':
          configs.push(args.clientConfig as ClientConfig)
          return 1
        case 'plugin:http|fetch_send':
          return {
            status: 200,
            statusText: 'OK',
            url: configs.at(-1)?.url,
            headers: [
              ['content-type', 'application/json'],
              ['set-cookie', 'YSC=abc; Secure'],
            ],
            rid: 2,
          }
        case 'plugin:http|fetch_read_body':
          // A chunk ends with 0; a lone 1 marks the end of the body.
          reads += 1
          return reads === 1 ? [...body, 0] : [1]
        default:
          return undefined
      }
    },
  }
  return { internals, configs, commands }
}

describe('in the desktop app', () => {
  const global = globalThis as { __TAURI_INTERNALS__?: unknown; window?: unknown }

  afterEach(() => {
    delete global.__TAURI_INTERNALS__
    delete global.window
  })

  it('recognizes Tauri’s runtime', () => {
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true)
    expect(isTauriRuntime({ __TAURI_INTERNALS__: null })).toBe(false)
    expect(isTauriRuntime({})).toBe(false)
  })

  it('createPlatform brings the desktop fetch, so YouTube and Spotify are reachable', async () => {
    global.__TAURI_INTERNALS__ = {}
    const platform = await createPlatform({ storage: memoryStorage() })
    expect(platform.environment).toBe('tauri')
    expect(platform.capabilities.current).toEqual({
      youtube: 'full',
      mediaBytes: true,
      spotify: 'anonymous',
      fileSystem: true,
    })
    platform.dispose()
  })

  it('createPlatform sends requests through the real HTTP plugin, with the header policy', async () => {
    const ipc = fakeIpc('{"contents":{}}')
    // `@tauri-apps/api` calls `window.__TAURI_INTERNALS__.invoke`.
    global.__TAURI_INTERNALS__ = ipc.internals
    global.window = { __TAURI_INTERNALS__: ipc.internals }
    const platform = await createPlatform({ storage: memoryStorage() })
    const response = await platform.transport.fetch(SEARCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'SID=secret',
        Origin: 'tauri://localhost',
      },
      body: BODY,
    })
    platform.dispose()

    expect(ipc.commands.slice(0, 2)).toEqual(['plugin:http|fetch', 'plugin:http|fetch_send'])
    const [config] = ipc.configs
    expect(config?.method).toBe('POST')
    expect(config?.url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(config?.headers).toContainEqual(['origin', ''])
    expect(config?.headers).toContainEqual(['content-type', SIMPLE_CONTENT_TYPE])
    // Node's own agent reads as no browser's, so the fallback desktop Chrome goes out.
    expect(config?.headers).toContainEqual(['user-agent', FALLBACK_BROWSER_USER_AGENT])
    expect(config?.headers.map(([name]) => name.toLowerCase())).not.toContain('cookie')
    expect(config?.connectTimeout).toBe(DESKTOP_CONNECT_TIMEOUT_MS)
    expect(config?.maxRedirections).toBe(0)
    expect(new TextDecoder().decode(Uint8Array.from(config?.data ?? []))).toBe(BODY)

    expect(response.status).toBe(200)
    expect(response.url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toEqual({ contents: {} })
    expect(platform.budget.snapshot().used).toBe(1)
  })
})
