/**
 * Loads the built, unpacked Chromium extension into Playwright's Chromium (new headless mode)
 * and checks the DNR rules and the bridge against a local HTTPS mock that reproduces the
 * measured behaviour of InnerTube, googlevideo, Spotify and Last.fm.
 *
 * DNR rules match real host names, so --host-resolver-rules points every host used here
 * (fxmusic.pages.dev included) at the mock and everything else nowhere: the test never
 * touches the network. The mock uses a throwaway self-signed certificate, which
 * --ignore-certificate-errors accepts.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'
import { packageVersion } from '../src/manifest.ts'
import {
  CLIENTTOKEN_HOST,
  FXM_HOST,
  FXM_PREVIEW_HOST,
  GOOGLEVIDEO_HOST,
  GOOGLEVIDEO_OTHER_HOST,
  MEDIA,
  MOCK_HOSTS,
  type MockServer,
  OTHER_HOST,
  PARTNER_HOST,
  SPCLIENT_HOST,
  SPOTIFY_HOST,
  startMockServer,
  YOUTUBE_HOSTS,
} from './mock-server.ts'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const EXTENSION_DIR = join(PACKAGE_DIR, 'dist', 'chromium')
const VERSION = packageVersion(JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')))
const PORT = Number(process.env.FXM_CONNECT_E2E_PORT ?? 5240)
const FXM = `https://${FXM_HOST}`

/** Each InnerTube host, the Origin its requests get and the Origin its preflights get. */
const INNERTUBE = [
  ['www.youtube.com', 'https://www.youtube.com', 'https://music.youtube.com'],
  ['music.youtube.com', 'https://music.youtube.com', 'https://www.youtube.com'],
  ['youtubei.googleapis.com', 'https://www.youtube.com', 'https://www.youtube.com'],
] as const
/** Headers InnerTube web clients send. Each of them makes the browser send a preflight. */
const INNERTUBE_HEADERS = {
  'content-type': 'application/json',
  'x-goog-visitor-id': 'CgtWaXNpdG9yRGF0YQ%3D%3D',
  'x-youtube-client-name': '67',
  'x-youtube-client-version': '1.20261020.01.00',
}
/** The Access-Control-Request-Headers Chromium sends for INNERTUBE_HEADERS. */
const INNERTUBE_PREFLIGHT_HEADERS = Object.keys(INNERTUBE_HEADERS).sort().join(',')
const INNERTUBE_BODY = { context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.0' } } }
const FEATURES = ['youtube', 'googlevideo', 'spotify', 'lastfm', 'spotify-server-time']
const MEDIA_URL = `https://${GOOGLEVIDEO_HOST}/videoplayback?id=e2e&itag=251`
const TOKEN_PARAMS = {
  reason: 'init',
  productType: 'web-player',
  totp: '123456',
  totpServer: '123456',
  totpVer: '5',
}

/**
 * The user's own sessions. SameSite=None, so the browser would attach them to cross-site
 * requests from the FXM page; the rules must strip them.
 */
const SESSION_COOKIES = [
  { name: 'SID', value: 'yt-session', domain: 'www.youtube.com' },
  { name: 'sp_dc', value: 'sp-session', domain: SPOTIFY_HOST },
].map((cookie) => ({ ...cookie, path: '/', secure: true, sameSite: 'None' as const }))

/** Credentialed requests a malicious or buggy page could try with the user's cookies. */
async function credentialedRequests(page: Page): Promise<boolean[]> {
  const youtube = await pageFetch(page, 'https://www.youtube.com/youtubei/v1/next', {
    method: 'POST',
    body: '{}',
    credentials: 'include',
  })
  const spotify = await pageFetch(page, 'https://open.spotify.com/api/token', {
    credentials: 'include',
  })
  return [youtube.ok, spotify.ok]
}

/** Cookie headers the services received, and the cookie names now stored for them. */
async function cookieTrace(context: BrowserContext) {
  const sent = mock.log
    .filter((entry) => entry.host === 'www.youtube.com' || entry.host === SPOTIFY_HOST)
    .map((entry) => entry.cookie)
  const stored = await context.cookies(['https://www.youtube.com', `https://${SPOTIFY_HOST}`])
  return { sent, stored: stored.map((cookie) => cookie.name).sort() }
}

function selfSignedCertificate(dir: string): { key: string; cert: string } {
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2']
  args.push('-subj', '/CN=fxm-connect-e2e', '-keyout', key, '-out', cert)
  execFileSync('openssl', args, { stdio: 'ignore' })
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}

async function launch(withExtension: boolean): Promise<BrowserContext> {
  const resolverRules = [
    ...MOCK_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${PORT}`),
    'MAP * ~NOTFOUND',
  ].join(', ')
  return chromium.launchPersistentContext('', {
    // The full Chromium build in the new headless mode; the headless shell has no extensions.
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--host-resolver-rules=${resolverRules}`,
      '--ignore-certificate-errors',
      '--disable-quic',
      ...(withExtension
        ? [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
        : []),
    ],
  })
}

async function extensionId(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  return new URL(worker.url()).host
}

interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  bodyBytes?: number[]
  credentials?: RequestCredentials
}

interface FetchResult {
  ok: boolean
  status?: number
  json?: unknown
  bytes?: number
  contentRange?: string | null
  error?: string
}

/** fetch() from the page, with credentials omitted unless asked for, as the web app does. */
function pageFetch(page: Page, url: string, init: FetchInit = {}): Promise<FetchResult> {
  return page.evaluate(
    async ({ url, init }) => {
      const { bodyBytes, ...rest } = init
      try {
        const response = await fetch(url, {
          credentials: 'omit',
          ...rest,
          ...(bodyBytes ? { body: new Uint8Array(bodyBytes) } : {}),
        })
        const buffer = await response.arrayBuffer()
        let json: unknown = null
        try {
          json = JSON.parse(new TextDecoder().decode(buffer))
        } catch {
          json = null
        }
        return {
          ok: true,
          status: response.status,
          json,
          bytes: buffer.byteLength,
          contentRange: response.headers.get('content-range'),
        }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    { url, init },
  )
}

/** Loads media into an <audio> element and reports the first outcome. */
function loadAudio(page: Page, src: string, crossOrigin: 'anonymous' | null): Promise<string> {
  return page.evaluate(
    ({ src, crossOrigin }) =>
      new Promise<string>((resolve) => {
        const audio = new Audio()
        if (crossOrigin) audio.crossOrigin = crossOrigin
        audio.addEventListener('loadedmetadata', () => resolve('loadedmetadata'), { once: true })
        audio.addEventListener('error', () => resolve('error'), { once: true })
        setTimeout(() => resolve('timeout'), 5000)
        audio.src = src
      }),
    { src, crossOrigin },
  )
}

/** Posts an FXM Connect message from the page and waits for its reply (null after 2 s). */
function send(page: Page, message: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    (message) =>
      new Promise((resolve) => {
        const done = (value: unknown) => {
          clearTimeout(timer)
          removeEventListener('message', onMessage)
          resolve(value)
        }
        const timer = setTimeout(() => done(null), 2000)
        function onMessage(event: MessageEvent) {
          const data = event.data as Record<string, unknown> | null
          if (event.source !== window || typeof data !== 'object' || data === null) return
          const pong = message.type === 'fxm-connect:ping' && data.type === 'fxm-connect:pong'
          const reply =
            'id' in message &&
            data.id === message.id &&
            (data.type === 'fxm-connect:response' || data.type === 'fxm-connect:error')
          if (pong || reply) done(data)
        }
        addEventListener('message', onMessage)
        postMessage(message, location.origin)
      }),
    message,
  )
}

/**
 * Runs `expression` in FXM Connect's content script world on the page, through the DevTools
 * protocol, as code in a compromised FXM page renderer could.
 */
async function inContentScript(page: Page, extension: string, expression: string) {
  const cdp = await page.context().newCDPSession(page)
  try {
    const worlds: { id: number; origin: string; auxData?: { type?: string } }[] = []
    cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context))
    await cdp.send('Runtime.enable')
    const world = worlds.find(
      (context) =>
        context.auxData?.type === 'isolated' &&
        context.origin === `chrome-extension://${extension}`,
    )
    if (!world) throw new Error('no FXM Connect content script world on the page')
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      contextId: world.id,
      awaitPromise: true,
      returnByValue: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.text)
    return result.value as unknown
  } finally {
    await cdp.detach()
  }
}

/** What a compromised renderer would try: switch the Spotify login on behind the user's back. */
const FORGE_SPOTIFY_LOGIN = `(async () => {
  const attempts = {}
  try {
    await chrome.storage.local.set({ spotifyLogin: true })
    attempts.storageLocal = 'written'
  } catch (error) {
    attempts.storageLocal = String(error)
  }
  try {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('fxm-connect', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('settings')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('settings', 'readwrite')
        transaction.objectStore('settings').put(true, 'spotifyLogin')
        transaction.oncomplete = () => resolve(db.close())
        transaction.onerror = () => reject(transaction.error)
      }
    })
    attempts.indexedDb = 'written'
  } catch (error) {
    attempts.indexedDb = String(error)
  }
  return attempts
})()`

let mock: MockServer
let certDir = ''

test.beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'fxm-connect-e2e-'))
  mock = await startMockServer({ port: PORT, ...selfSignedCertificate(certDir) })
})

test.afterAll(async () => {
  await mock?.close()
  rmSync(certDir, { recursive: true, force: true })
})

test.beforeEach(() => {
  mock.clearLog()
})

test.describe('with FXM Connect loaded', () => {
  let context: BrowserContext
  let page: Page

  test.beforeAll(async () => {
    context = await launch(true)
    await extensionId(context)
    page = await context.newPage()
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test('marks the FXM page and answers ping with the version and features', async () => {
    await page.goto(`${FXM}/`)
    await expect(page.locator('html')).toHaveAttribute('data-fxm-connect', VERSION)
    expect(await send(page, { type: 'fxm-connect:ping' })).toEqual({
      type: 'fxm-connect:pong',
      version: VERSION,
      features: FEATURES,
    })
  })

  test('lets the FXM page send preflighted InnerTube requests with the usual headers', async () => {
    await page.goto(`${FXM}/`)
    for (const [host, origin, preflightOrigin] of INNERTUBE) {
      mock.clearLog()
      const result = await pageFetch(page, `https://${host}/youtubei/v1/player?prettyPrint=false`, {
        method: 'POST',
        headers: INNERTUBE_HEADERS,
        body: JSON.stringify(INNERTUBE_BODY),
      })
      expect(result, host).toMatchObject({
        ok: true,
        status: 200,
        json: { host, seenOrigin: origin, seenReferer: `${origin}/`, body: INNERTUBE_BODY },
      })
      // InnerTube answers a preflight with its own origin with 400, so the preflight carries
      // the other YouTube origin and the POST the host's own.
      expect(mock.requests(host), host).toEqual([
        expect.objectContaining({
          method: 'OPTIONS',
          origin: preflightOrigin,
          referer: `${preflightOrigin}/`,
          requestHeaders: INNERTUBE_PREFLIGHT_HEADERS,
          status: 200,
        }),
        expect.objectContaining({
          method: 'POST',
          origin,
          referer: `${origin}/`,
          contentType: 'application/json',
          status: 200,
        }),
      ])
    }
  })

  test('lets the FXM page POST a JSON body to InnerTube as a CORS-simple request', async () => {
    await page.goto(`${FXM}/`)
    for (const [host, origin] of INNERTUBE) {
      const body = { ...INNERTUBE_BODY, q: 1 }
      const result = await pageFetch(page, `https://${host}/youtubei/v1/search?prettyPrint=false`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(result, host).toMatchObject({
        ok: true,
        status: 200,
        json: { host, seenOrigin: origin, seenReferer: `${origin}/`, sawCookie: false, body },
      })
    }
    // No preflight: a string body is sent as text/plain, which InnerTube parses as JSON.
    const innertube = mock.log.filter((entry) => YOUTUBE_HOSTS.includes(entry.host))
    expect(innertube.map((entry) => [entry.method, entry.contentType])).toEqual([
      ['POST', 'text/plain;charset=UTF-8'],
      ['POST', 'text/plain;charset=UTF-8'],
      ['POST', 'text/plain;charset=UTF-8'],
    ])
  })

  test('makes googlevideo media readable, with a YouTube Origin on preflights only', async () => {
    await page.goto(`${FXM}/`)
    const ranged = await pageFetch(page, MEDIA_URL, { headers: { range: 'bytes=0-1023' } })
    expect(ranged).toMatchObject({
      ok: true,
      status: 206,
      bytes: 1024,
      contentRange: `bytes 0-1023/${MEDIA.length}`,
    })
    expect(mock.requests(GOOGLEVIDEO_HOST).filter((entry) => entry.method === 'GET')).toEqual([
      expect.objectContaining({ origin: FXM, status: 206 }),
    ])

    mock.clearLog()
    const post = await pageFetch(page, MEDIA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      bodyBytes: [8, 1, 16, 2],
    })
    expect(post).toMatchObject({ ok: true, status: 200, bytes: MEDIA.length })
    expect(
      mock.requests(GOOGLEVIDEO_HOST).map(({ method, origin, status }) => [method, origin, status]),
    ).toEqual([
      ['OPTIONS', 'https://www.youtube.com', 204],
      ['POST', FXM, 200],
    ])
  })

  test('cannot make googlevideo media readable after a redirect to another host', async () => {
    await page.goto(`${FXM}/`)
    // A redirect within the host keeps the page's Origin, so the rule's exact ACAO matches.
    expect(await pageFetch(page, `${MEDIA_URL}&redirect=same`)).toMatchObject({
      ok: true,
      status: 200,
      bytes: MEDIA.length,
    })
    mock.clearLog()
    // After a redirect to another host the browser sends Origin: null and wants
    // Access-Control-Allow-Origin: null, which no rule can give without breaking the requests
    // above. The web app treats this failure as retryable (README).
    expect(await pageFetch(page, `${MEDIA_URL}&redirect=cross`)).toMatchObject({ ok: false })
    expect(
      mock.log.map(({ host, method, origin, status }) => [host, method, origin, status]),
    ).toEqual([
      [GOOGLEVIDEO_HOST, 'GET', FXM, 302],
      [GOOGLEVIDEO_OTHER_HOST, 'GET', 'null', 200],
    ])
    // Without CORS, a plain <audio src> follows the redirect and plays; CORS mode fails too.
    expect(await loadAudio(page, `${MEDIA_URL}&redirect=cross&n=plain`, null)).toBe(
      'loadedmetadata',
    )
    expect(await loadAudio(page, `${MEDIA_URL}&redirect=cross&n=cors`, 'anonymous')).toBe('error')
  })

  test('lets <audio crossorigin> load googlevideo media, so Web Audio can use it', async () => {
    await page.goto(`${FXM}/`)
    expect(await loadAudio(page, `${MEDIA_URL}&n=cors`, 'anonymous')).toBe('loadedmetadata')
  })

  test('makes the Spotify token endpoints and Last.fm stations readable', async () => {
    await page.goto(`${FXM}/`)
    expect(await pageFetch(page, 'https://open.spotify.com/api/server-time')).toMatchObject({
      ok: true,
      status: 200,
      json: { serverTime: 1_800_000_000 },
    })
    const token = await pageFetch(page, 'https://open.spotify.com/api/token?reason=init', {
      headers: { 'app-platform': 'WebPlayer', 'spotify-app-version': '1.2.3' },
    })
    expect(token).toMatchObject({ ok: true, status: 200, json: { isAnonymous: true } })
    expect(
      mock
        .requests(SPOTIFY_HOST, '/api/token')
        .map(({ method, origin, referer }) => [method, origin, referer]),
    ).toEqual([
      ['OPTIONS', 'https://open.spotify.com', 'https://open.spotify.com/'],
      ['GET', 'https://open.spotify.com', 'https://open.spotify.com/'],
    ])
    expect(
      await pageFetch(page, 'https://www.last.fm/player/station/music/Mock+Artist?ajax=1'),
    ).toMatchObject({ ok: true, status: 200, json: { playlist: [{ name: 'Mock song' }] } })
  })

  test('makes Spotify clienttoken, pathfinder and spclient responses readable', async () => {
    await page.goto(`${FXM}/`)
    const clientToken = await pageFetch(page, `https://${CLIENTTOKEN_HOST}/v1/clienttoken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{"client_data":{}}',
    })
    expect(clientToken).toMatchObject({
      ok: true,
      status: 200,
      json: { granted_token: { token: 'mock-client-token' } },
    })
    // clienttoken only answers CORS for open.spotify.com, so the rule makes requests look so.
    expect(
      mock
        .requests(CLIENTTOKEN_HOST)
        .map(({ method, origin, referer, status }) => [method, origin, referer, status]),
    ).toEqual([
      ['OPTIONS', 'https://open.spotify.com', 'https://open.spotify.com/', 200],
      ['POST', 'https://open.spotify.com', 'https://open.spotify.com/', 200],
    ])

    // The web player's headers; each of them needs a preflight.
    const headers = {
      authorization: 'Bearer mock-token',
      'client-token': 'mock-client-token',
      'app-platform': 'WebPlayer',
      'content-type': 'application/json;charset=UTF-8',
    }
    const query = await pageFetch(page, `https://${PARTNER_HOST}/pathfinder/v2/query`, {
      method: 'POST',
      headers,
      body: '{"operationName":"searchDesktop"}',
    })
    expect(query).toMatchObject({ ok: true, status: 200, json: { host: PARTNER_HOST } })
    const lyrics = await pageFetch(
      page,
      `https://${SPCLIENT_HOST}/color-lyrics/v2/track/mock?format=json`,
      { headers },
    )
    expect(lyrics).toMatchObject({ ok: true, status: 200, json: { host: SPCLIENT_HOST } })
    // These hosts keep the page's own Origin; the rules only pin the CORS answer.
    for (const host of [PARTNER_HOST, SPCLIENT_HOST]) {
      expect(mock.requests(host).map(({ method, origin }) => [method, origin])).toEqual([
        ['OPTIONS', FXM],
        [host === PARTNER_HOST ? 'POST' : 'GET', FXM],
      ])
    }
  })

  test('never lets the page send or change the user’s cookies', async () => {
    await context.addCookies(SESSION_COOKIES)
    await page.goto(`${FXM}/`)
    mock.clearLog()
    // Credentialed reads fail (the rules strip Access-Control-Allow-Credentials), the requests
    // leave without the user's cookies, and the responses' Set-Cookie is dropped. The control
    // in the test without the extension shows the browser would do both otherwise.
    expect(await credentialedRequests(page)).toEqual([false, false])
    expect(await cookieTrace(context)).toEqual({
      sent: [undefined, undefined],
      stored: ['SID', 'sp_dc'],
    })
    await context.clearCookies()
  })

  test('keeps pages on other origins out', async () => {
    const other = await context.newPage()
    try {
      await other.goto(`https://${OTHER_HOST}/`)
      expect(await other.locator('html').getAttribute('data-fxm-connect')).toBeNull()
      expect(await send(other, { type: 'fxm-connect:ping' })).toBeNull()
      const result = await pageFetch(other, 'https://www.youtube.com/youtubei/v1/search', {
        method: 'POST',
        body: '{}',
      })
      expect(result.ok).toBe(false)
      const preflighted = await pageFetch(other, 'https://www.youtube.com/youtubei/v1/next', {
        method: 'POST',
        headers: INNERTUBE_HEADERS,
        body: '{}',
      })
      expect(preflighted.ok).toBe(false)
      expect(await pageFetch(other, MEDIA_URL, { headers: { range: 'bytes=0-15' } })).toMatchObject(
        { ok: false },
      )
      // No rule touched the requests: InnerTube saw the real Origin and refused it.
      expect(mock.requests('www.youtube.com')).toEqual([
        expect.objectContaining({ method: 'POST', origin: `https://${OTHER_HOST}`, status: 403 }),
        expect.objectContaining({
          method: 'OPTIONS',
          origin: `https://${OTHER_HOST}`,
          status: 403,
        }),
      ])
    } finally {
      await other.close()
    }
  })

  test('ignores preview deployments on sub-domains of the FXM host', async () => {
    const preview = await context.newPage()
    try {
      await preview.goto(`https://${FXM_PREVIEW_HOST}/`)
      expect(await preview.locator('html').getAttribute('data-fxm-connect')).toBeNull()
      const result = await pageFetch(preview, 'https://www.youtube.com/youtubei/v1/search', {
        method: 'POST',
        body: '{}',
      })
      expect(result.ok).toBe(false)
      // initiatorDomains matches sub-domains, but DNR also needs host access to the initiator,
      // which FXM Connect has for the exact FXM host only: the request kept its real Origin.
      expect(mock.requests('www.youtube.com')).toEqual([
        expect.objectContaining({
          method: 'POST',
          origin: `https://${FXM_PREVIEW_HOST}`,
          status: 403,
        }),
      ])
    } finally {
      await preview.close()
    }
  })

  test('lets FXM Connect itself connect to open.spotify.com only (its CSP)', async () => {
    await page.goto(`${FXM}/`)
    // A ping makes the content script ask the background, so its service worker is running.
    await send(page, { type: 'fxm-connect:ping' })
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    const fetchFromBackground = (url: string) =>
      worker.evaluate(
        (url) =>
          fetch(url, { credentials: 'omit' }).then(
            (response) => `status ${response.status}`,
            (error) => String(error),
          ),
        url,
      )
    expect(await fetchFromBackground('https://open.spotify.com/api/server-time')).toBe('status 200')
    expect(await fetchFromBackground('https://www.youtube.com/youtubei/v1/search')).toMatch(
      /TypeError/,
    )
    expect(mock.requests('www.youtube.com')).toEqual([])
  })

  test('keeps the Spotify login switch out of reach of a compromised FXM page', async () => {
    await page.goto(`${FXM}/`)
    // Both writes succeed, but neither reaches the setting: it lives in IndexedDB in the
    // extension's own origin, while the content script's indexedDB is the page's.
    expect(await inContentScript(page, await extensionId(context), FORGE_SPOTIFY_LOGIN)).toEqual({
      storageLocal: 'written',
      indexedDb: 'written',
    })
    expect(
      await send(page, { type: 'fxm-connect:spotify-token', id: 'forged', params: TOKEN_PARAMS }),
    ).toEqual({ type: 'fxm-connect:error', id: 'forged', code: 'login-disabled' })
    expect(await send(page, { type: 'fxm-connect:ping' })).toMatchObject({ features: FEATURES })
    expect(mock.requests(SPOTIFY_HOST, '/api/token')).toEqual([])
  })

  test('relays a Spotify token with the browser session only after the user opts in', async () => {
    await page.goto(`${FXM}/`)
    expect(
      await send(page, { type: 'fxm-connect:spotify-token', id: 'off', params: TOKEN_PARAMS }),
    ).toEqual({ type: 'fxm-connect:error', id: 'off', code: 'login-disabled' })
    expect(await send(page, { type: 'fxm-connect:spotify-server-time', id: 'time' })).toEqual({
      type: 'fxm-connect:response',
      id: 'time',
      status: 200,
      json: { serverTime: 1_800_000_000 },
    })
    expect(mock.requests(SPOTIFY_HOST, '/api/token')).toEqual([])

    // Opt in on the options page.
    const options = await context.newPage()
    await options.goto(`chrome-extension://${await extensionId(context)}/options.html`)
    await expect(options.locator('#version')).toHaveText(VERSION)
    // The page's own stylesheet loads under the extension's CSP.
    await expect(options.locator('main')).toHaveCSS('max-width', '672px')
    // The release build shows no development warning and no localhost toggle.
    await expect(options.locator('#dev-warning')).toBeHidden()
    await expect(options.locator('#localhost-login')).toBeHidden()
    await expect(options.locator('#origins')).toHaveText(FXM)
    const toggle = options.getByLabel('Use my Spotify login from this browser')
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    await toggle.check()
    await expect(options.getByRole('status')).toHaveText(/^Saved\./)
    await options.close()

    expect(await send(page, { type: 'fxm-connect:ping' })).toMatchObject({
      features: [...FEATURES, 'spotify-login'],
    })

    // SameSite=Lax is enough: the browser treats the extension's own request to a host it has
    // permission for as same-site, so the user's open.spotify.com session goes along.
    await context.addCookies([
      {
        name: 'sp_dc',
        value: 'spotify-session',
        domain: SPOTIFY_HOST,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
    mock.clearLog()
    const reply = await send(page, {
      type: 'fxm-connect:spotify-token',
      id: 'on',
      params: TOKEN_PARAMS,
    })
    expect(reply).toEqual({
      type: 'fxm-connect:response',
      id: 'on',
      status: 200,
      json: { accessToken: 'user-token', isAnonymous: false, clientId: 'mock' },
    })
    expect(JSON.stringify(reply)).not.toContain('spotify-session')
    const requests = mock.requests(SPOTIFY_HOST, '/api/token')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'GET',
      path: '/api/token?reason=init&productType=web-player&totp=123456&totpServer=123456&totpVer=5',
      cookie: 'sp_dc=spotify-session',
    })

    expect(
      await send(page, {
        type: 'fxm-connect:spotify-token',
        id: 'bad',
        params: { reason: 'init', url: 'https://evil.example/' },
      }),
    ).toEqual({ type: 'fxm-connect:error', id: 'bad', code: 'bad-request' })
    expect(mock.requests(SPOTIFY_HOST, '/api/token')).toHaveLength(1)
  })
})

test('without FXM Connect the FXM page can reach neither InnerTube nor googlevideo', async () => {
  const context = await launch(false)
  try {
    const page = await context.newPage()
    await page.goto(`${FXM}/`)
    expect(await page.locator('html').getAttribute('data-fxm-connect')).toBeNull()
    const result = await pageFetch(page, 'https://www.youtube.com/youtubei/v1/search', {
      method: 'POST',
      body: '{}',
    })
    expect(result.ok).toBe(false)
    const preflighted = await pageFetch(page, 'https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: INNERTUBE_HEADERS,
      body: '{}',
    })
    expect(preflighted.ok).toBe(false)
    expect(mock.requests('www.youtube.com')).toEqual([
      expect.objectContaining({ method: 'POST', origin: FXM, status: 403 }),
      expect.objectContaining({ method: 'OPTIONS', origin: FXM, status: 403 }),
    ])
    expect(await pageFetch(page, MEDIA_URL, { headers: { range: 'bytes=0-15' } })).toMatchObject({
      ok: false,
    })
    expect(
      await pageFetch(page, `https://${CLIENTTOKEN_HOST}/v1/clienttoken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ).toMatchObject({ ok: false })
    // A plain <audio src> plays without the extension (Cross-Origin-Resource-Policy:
    // cross-origin); CORS mode, which Web Audio needs, does not.
    expect(await loadAudio(page, `${MEDIA_URL}&n=plain`, null)).toBe('loadedmetadata')
    expect(await loadAudio(page, `${MEDIA_URL}&n=cors`, 'anonymous')).toBe('error')

    // Control for the cookie test: without the extension the browser attaches the session
    // cookies to cross-site requests and stores cookies the responses set.
    await context.addCookies(SESSION_COOKIES)
    mock.clearLog()
    expect(await credentialedRequests(page)).toEqual([false, false])
    expect(await cookieTrace(context)).toEqual({
      sent: ['SID=yt-session', 'sp_dc=sp-session'],
      stored: ['SID', 'sp_dc', 'sp_t'],
    })
  } finally {
    await context.close()
  }
})
