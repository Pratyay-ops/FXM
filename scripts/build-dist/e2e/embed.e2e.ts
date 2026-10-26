/**
 * The live check behind the embed's release flags, the site's `AVAILABLE.embed`
 * (apps/site/src/config.ts) and the app's `RELEASED.embed` (apps/web/src/features/connect/
 * config.ts), which stay off until "a browser test shows the production embed playing in the Lite
 * tier inside a page on another origin".
 *
 * The test serves a page itself from http://127.0.0.1:6970, another origin and another site than
 * the deployment, which frames FXM_DEPLOY_URL/embed/track/ytm:zFYEYRcjK2g with the share dialog's
 * code (apps/web/src/features/share/embed-code.ts) and follows it with the embed's postMessage API
 * (apps/web/src/embed/README.md, protocol 1). The song is "Creep" by Radiohead, which Radiohead -
 * Topic publishes on YouTube Music: the song the YouTube fixtures recorded
 * (packages/sources/src/youtube/fixtures/next-creep-song.json and stream/fixtures/
 * visionos-song.json), so no request goes to finding it. Inside the player's frame:
 *
 * - its origin is the deployment's, and the page is its only ancestor;
 * - it is in the Lite tier: its controller's state says `lite` (the API's messages never name the
 *   tier), it carries no FXM Connect marker, it framed its sandbox document, and every InnerTube
 *   request came from that document, whose origin is opaque;
 * - nothing plays until a click on its play button, as a visitor starts it; the click is also the
 *   user gesture that autoplay asks for;
 * - one of its media elements plays the song from googlevideo, muted, its `currentTime` advancing
 *   at least 10 s;
 * - it posts `fxm-embed:ready`, then the `playing` state, to the page, as protocol 1 documents;
 * - no document (the page, the player, the player's sandbox) reports a Content-Security-Policy or
 *   Permissions-Policy violation.
 *
 * It reaches YouTube for real, so it runs only with FXM_LIVE=1 and FXM_DEPLOY_URL, from a
 * residential connection (YouTube meets datacenter addresses with bot checks), and stays within 10
 * requests to YouTube and googlevideo: thumbnails are answered here, `player` requests for any
 * other video (prefetches) are refused here, and every other request counts, so that one past the
 * budget is refused and fails the check. The browser is headless and muted, and so is every media
 * element. The run prints when and where it ran and the requests by endpoint, and records them as
 * annotations; the deploy README says how to run it (FXM_CONNECTION names the connection).
 */
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { arch, release, type } from 'node:os'
import { expect, type Frame, type Page, type Request, test } from '@playwright/test'

const live = process.env.FXM_LIVE === '1' && Boolean(process.env.FXM_DEPLOY_URL)
/** "Creep" by Radiohead, from YouTube Music (Radiohead - Topic): the YouTube fixtures' song. */
const SONG = { videoId: 'zFYEYRcjK2g', title: 'Creep', artist: 'Radiohead' } as const
/** The page that embeds the player, served by the test: another origin and site than FXM's. */
const EMBEDDER_PORT = 6970
const EMBEDDER = `http://127.0.0.1:${EMBEDDER_PORT}`
const YOUTUBE_API = /^https:\/\/(www\.youtube\.com|music\.youtube\.com|youtubei\.googleapis\.com)\//
const GOOGLEVIDEO = /^https:\/\/[^/]+\.googlevideo\.com\//
const IMAGES = /^https:\/\/([^/]+\.)?(ytimg\.com|ggpht\.com|googleusercontent\.com)\//
const SANDBOX_PATH = /^\/sandbox\/innertube(\.html)?$/
const BUDGET = 10
/** A 1×1 PNG for the thumbnails, which would cost a request each. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
/**
 * The embed's postMessage API as its README documents it (apps/web/src/embed/api.ts). The check
 * keeps its own copy, as a page on another site would, rather than importing the app's.
 */
const PROTOCOL = 1
const MESSAGE = {
  hello: 'fxm-embed:hello',
  ready: 'fxm-embed:ready',
  state: 'fxm-embed:state',
  error: 'fxm-embed:error',
} as const
/** The fields of `state`, as the README lists them. */
const STATE_FIELDS = [
  'buffering',
  'durationMs',
  'index',
  'muted',
  'positionMs',
  'status',
  'track',
  'trackCount',
  'volume',
]

/** The state the player reports to the page, as far as the check reads it. */
interface ApiState {
  readonly status: string
  readonly positionMs: number
  readonly track: { id: string; title: string; artists: string[] } | null
}

/** A message the player posted to the page. */
interface PlayerMessage {
  readonly type: string
  readonly protocol?: unknown
  readonly code?: string
  readonly embed?: { kind: string; id: string; title: string | null; trackCount: number }
  readonly state?: ApiState
}

/** What the page that embeds the player keeps: each message from the player, as it came. */
interface EmbedderRecord {
  fxmMessages: PlayerMessage[]
}

/** What the init script keeps in every document: the page's, the player's and its sandbox's. */
interface DocumentRecord {
  /** Every media element the document played: the player's are never in the DOM. */
  fxmMedia: Set<HTMLMediaElement>
  /** The Content-Security-Policy and Permissions-Policy violations the document saw. */
  fxmViolations: string[]
}

/** The embed controller's state, as far as the check reads it (`EmbedState` in controller.ts). */
interface EmbedState {
  readonly phase?: string | undefined
  readonly tier?: string | undefined
  readonly problem?: string | undefined
  readonly notice?: string | undefined
}

/** The parts of a React fiber the check reads: its props and its parent. */
interface Fiber {
  readonly memoizedProps?: { readonly controller?: { readonly getState?: unknown } } | null
  readonly return?: Fiber | null
}

/** What the frame's playing media element reports, or `null` while none plays. */
interface Playing {
  readonly currentTime: number
  readonly muted: boolean
  readonly host: string
}

/** A request to YouTube or googlevideo. */
interface YouTubeRequest {
  /** Its method, host and path, e.g. `POST music.youtube.com/youtubei/v1/next`. */
  readonly endpoint: string
  /** The document that sent it, as host and path. */
  readonly from: string
  readonly request: Request
}

test.skip(!live, 'a live check: set FXM_LIVE=1 and FXM_DEPLOY_URL, from a residential connection')
// Headless and silent: the browser plays to no audio device, and every media element is muted.
test.use({ headless: true, serviceWorkers: 'block', launchOptions: { args: ['--mute-audio'] } })
// Each run costs YouTube requests from the owner's connection: never again on its own.
test.describe.configure({ retries: 0 })

/** `text` for an HTML attribute value in double quotes, escaped as the share dialog does. */
function attribute(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * The share dialog's code for the song in the default options (`embedCode` in
 * apps/web/src/features/share/embed-code.ts): the page's width, the track card's 232 px,
 * `allow="autoplay"` and `loading="lazy"`.
 */
function shareCode(src: string): string {
  return [
    '<iframe',
    `title="${attribute(`FXM player: ${SONG.title}`)}"`,
    `src="${attribute(src)}"`,
    'width="100%"',
    'height="232"',
    'style="border:0;border-radius:12px"',
    'allow="autoplay"',
    'loading="lazy"></iframe>',
  ].join(' ')
}

/**
 * The page on another site: the share code, and the README's script, which says hello once the
 * player's frame has loaded and keeps every message from the player's window and FXM's origin.
 */
function embedderPage(fxm: string, src: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>A page on another site</title></head>
  <body>
    <h1>A post with a song</h1>
    ${shareCode(src)}
    <script>
      const frame = document.querySelector('iframe')
      const player = frame.contentWindow
      const FXM = ${JSON.stringify(fxm)}
      window.fxmMessages = []
      addEventListener('message', (event) => {
        if (event.origin !== FXM || event.source !== player) return
        window.fxmMessages.push(event.data)
      })
      frame.addEventListener('load', () => {
        player.postMessage({ type: ${JSON.stringify(MESSAGE.hello)}, protocol: ${PROTOCOL} }, FXM)
      })
    </script>
  </body>
</html>
`
}

/** Serves `html` at EMBEDDER; the port is strict, so a busy one fails before any request. */
async function serve(html: string): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(EMBEDDER_PORT, '127.0.0.1', resolve)
  })
  return server
}

/**
 * Runs in every document before its own scripts: keeps the policy violations it sees, and every
 * media element it plays, muted. Muted stays on whatever the player sets.
 */
function recordEveryDocument(): void {
  const record = window as unknown as DocumentRecord
  record.fxmMedia = new Set()
  record.fxmViolations = []
  document.addEventListener('securitypolicyviolation', (event) => {
    record.fxmViolations.push(
      `Content-Security-Policy: ${event.effectiveDirective} blocked ${event.blockedURI || 'inline code'}`,
    )
  })
  if (typeof ReportingObserver === 'function') {
    new ReportingObserver(
      (reports) => {
        for (const report of reports) {
          if (!report.type?.includes('permissions-policy')) continue
          record.fxmViolations.push(`${report.type}: ${JSON.stringify(report.body)}`)
        }
      },
      { buffered: true },
    ).observe()
  }
  const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted')
  const get = muted?.get
  const set = muted?.set
  if (get !== undefined && set !== undefined) {
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
      configurable: true,
      enumerable: muted?.enumerable ?? true,
      get() {
        return get.call(this)
      },
      set() {
        set.call(this, true)
      },
    })
  }
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    this.muted = true
    record.fxmMedia.add(this)
    return play.call(this)
  }
}

/** A document's address as host and path, without its query and fragment. */
function documentOf(address: string): string {
  const url = new URL(address)
  return `${url.host}${url.pathname}`
}

/** A host as the record shows it: googlevideo's without its cache node's name (`sn-…`). */
function hostOf(host: string): string {
  return host.replace(/\bsn-[a-z0-9-]+(?=\.googlevideo\.com$)/, 'sn-…')
}

/** A request's method, host and path. */
function endpointOf(request: Request): string {
  const url = new URL(request.url())
  return `${request.method()} ${hostOf(url.host)}${url.pathname}`
}

/** The document that sent a request, as host and path. */
function senderOf(request: Request): string {
  try {
    return documentOf(request.frame().url())
  } catch {
    return 'an unknown document'
  }
}

/** The video a `player` request asks for. */
function videoIdOf(request: Request): string | undefined {
  try {
    const body: unknown = JSON.parse(request.postData() ?? '')
    if (typeof body !== 'object' || body === null || !('videoId' in body)) return undefined
    return typeof body.videoId === 'string' ? body.videoId : undefined
  } catch {
    return undefined
  }
}

/** The `Origin` a request was sent with, or `unknown` if the browser hasn't said within 5 s. */
async function originOf(request: Request): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), 5_000)
  })
  try {
    return await Promise.race([
      request.headerValue('origin').then((origin) => origin ?? 'none'),
      late,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** `requests`, counted by endpoint, the most frequent first, with the documents that sent them. */
function byEndpoint(requests: readonly YouTubeRequest[]): string {
  const counts = new Map<string, { count: number; from: Set<string> }>()
  for (const { endpoint, from } of requests) {
    const entry = counts.get(endpoint) ?? { count: 0, from: new Set<string>() }
    entry.count += 1
    entry.from.add(from)
    counts.set(endpoint, entry)
  }
  const lines = [...counts]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([endpoint, { count, from }]) => `${count} × ${endpoint} (from ${[...from].join(', ')})`)
  return lines.length === 0 ? 'none' : lines.join('; ')
}

/** Every message the player posted to the page so far. */
function received(page: Page): Promise<PlayerMessage[]> {
  return page.evaluate(() => (window as unknown as EmbedderRecord).fxmMessages)
}

/** Waits for the newest message from the player that `match` accepts, and returns it. */
async function waitForMessage(
  page: Page,
  match: (message: PlayerMessage) => boolean,
  timeout: number,
  what: string,
): Promise<PlayerMessage> {
  let found: PlayerMessage | undefined
  await expect
    .poll(
      async () => {
        found = (await received(page)).findLast(match)
        return found !== undefined
      },
      { timeout, message: what },
    )
    .toBe(true)
  return found as PlayerMessage
}

/** The player's frame, once the page has it. */
async function playerFrame(page: Page, fxm: string): Promise<Frame> {
  const find = () => page.frames().find((frame) => frame.url().startsWith(`${fxm}/embed/`))
  await expect.poll(() => find() !== undefined, { message: "the player's frame" }).toBe(true)
  const frame = find() as Frame
  await frame.waitForLoadState('domcontentloaded')
  return frame
}

/**
 * The embed's own state, read from its controller, which the root component of its React tree
 * holds (`EmbedApp` in apps/web/src/embed/embed-app.tsx): the API's messages never name the tier.
 */
function embedState(frame: Frame): Promise<EmbedState | null> {
  return frame.evaluate(() => {
    const main = document.querySelector('main')
    if (main === null) return null
    const key = Object.keys(main).find((name) => name.startsWith('__reactFiber$'))
    let fiber: Fiber | null | undefined =
      key === undefined ? undefined : (main as unknown as Record<string, Fiber>)[key]
    while (fiber) {
      const getState = fiber.memoizedProps?.controller?.getState
      if (typeof getState === 'function') {
        const { phase, tier, problem, notice } = getState() as EmbedState
        return { phase, tier, problem, notice }
      }
      fiber = fiber.return
    }
    return null
  })
}

/** The media element the frame plays from the network, or `null` while none plays. */
function playing(frame: Frame): Promise<Playing | null> {
  return frame.evaluate(() => {
    const media = [...(window as unknown as DocumentRecord).fxmMedia].find(
      (element) =>
        !element.paused && element.currentTime > 0 && /^https?:/.test(element.currentSrc),
    )
    return media === undefined
      ? null
      : { currentTime: media.currentTime, muted: media.muted, host: new URL(media.currentSrc).host }
  })
}

/** The violations a document recorded, each with its name; `undefined` once it is gone. */
async function violationsIn(frame: Frame | undefined, name: string): Promise<string[] | undefined> {
  if (frame === undefined || frame.isDetached()) return undefined
  const violations = await frame.evaluate(
    () => (window as unknown as DocumentRecord).fxmViolations ?? [],
  )
  return violations.map((violation) => `${name}: ${violation}`)
}

/** Where and how the check runs: the browser, Playwright, the OS and the connection. */
function environment(browserVersion: string, headless: boolean, playwright: string): string {
  let os = `${type()} ${release()} ${arch()}`
  if (process.platform === 'darwin') {
    try {
      os = `macOS ${execFileSync('sw_vers', ['-productVersion']).toString().trim()} (${os})`
    } catch {
      // The kernel's name and release say enough.
    }
  }
  const connection = process.env.FXM_CONNECTION ?? 'not stated (set FXM_CONNECTION)'
  const mode = headless ? 'headless' : 'headed'
  return `Chromium ${browserVersion} (${mode}, --mute-audio, a temporary profile, no extension, service workers blocked), Playwright ${playwright}, ${os}, connection: ${connection}`
}

test('the production embed plays in Lite inside a page on another site', async ({
  page,
  context,
  browser,
  headless,
}) => {
  test.setTimeout(180_000)
  const fxm = new URL(process.env.FXM_DEPLOY_URL as string).origin
  const src = new URL(`/embed/track/ytm:${encodeURIComponent(SONG.videoId)}`, fxm).href
  const startedAt = new Date()
  /** Every request to YouTube and googlevideo the documents made, but the refused prefetches. */
  const attempted: YouTubeRequest[] = []
  /** `player` requests for other videos, refused before they reach YouTube. */
  const prefetches: YouTubeRequest[] = []
  const consoleViolations: string[] = []
  const pageErrors: string[] = []
  /** The hosts the documents sent requests to, and those whose thumbnails were answered here. */
  const hosts = new Set<string>()
  const answered = new Set<string>()
  /** What the check saw, for the run output and the `result` annotation. */
  const seen: string[] = []

  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (IMAGES.test(url.href)) {
      answered.add(url.host)
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
    }
    hosts.add(hostOf(url.host))
    const youtube = YOUTUBE_API.test(url.href)
    if (!youtube && !GOOGLEVIDEO.test(url.href)) return route.fallback()
    const entry = { endpoint: endpointOf(request), from: senderOf(request), request }
    if (youtube && url.pathname.endsWith('/player') && videoIdOf(request) !== SONG.videoId) {
      prefetches.push(entry)
      return route.abort('blockedbyclient')
    }
    attempted.push(entry)
    // Past the budget: refused, and the check fails below.
    if (attempted.length > BUDGET) return route.abort('blockedbyclient')
    return route.fallback()
  })
  await page.addInitScript(recordEveryDocument)
  page.on('console', (message) => {
    const text = message.text()
    if (/Content[- ]Security[- ]Policy|Permissions[- ]Policy/i.test(text)) {
      consoleViolations.push(`${message.location().url || 'a document'}: ${text}`)
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const where = environment(browser.version(), headless, test.info().config.version)
  console.log(`[embed live check] started ${startedAt.toISOString()}: ${where}`)
  console.log(
    `[embed live check] ${EMBEDDER}/ frames ${src}, "${SONG.title}" by ${SONG.artist} on YouTube Music`,
  )

  const server = await serve(embedderPage(fxm, src))
  let player: Frame | undefined
  let sandbox: Frame | undefined
  try {
    await page.goto(`${EMBEDDER}/`)
    expect(await page.evaluate(() => location.origin)).toBe(EMBEDDER)
    // Another site too: schemeful same-site would need the deployment on http://127.0.0.1.
    const deployment = new URL(fxm)
    expect(
      deployment.protocol === 'http:' && deployment.hostname === '127.0.0.1',
      'the deployment is on the same site as the page',
    ).toBe(false)

    // The player's frame is the deployment's document, framed by the page.
    const frame = await playerFrame(page, fxm)
    player = frame
    const inside = await frame.evaluate(() => ({
      origin: location.origin,
      ancestors: Array.from(location.ancestorOrigins),
      framed: window.self !== window.top,
      secure: isSecureContext,
    }))
    expect(inside).toMatchObject({ origin: fxm, ancestors: [EMBEDDER], framed: true })
    seen.push(
      `the frame's origin is ${inside.origin}, its ancestor ${inside.ancestors.join(', ')}${inside.secure ? ', a secure context' : ''}`,
    )

    // It loads the song and tells the page it is ready, with nothing playing yet.
    const ready = await waitForMessage(
      page,
      (message) => message.type === MESSAGE.ready,
      90_000,
      'fxm-embed:ready',
    )
    const title = ready.embed?.title ?? null
    expect(ready.protocol).toBe(PROTOCOL)
    expect(ready.embed, JSON.stringify(ready)).toMatchObject({
      kind: 'track',
      id: `ytm:track:${SONG.videoId}`,
      trackCount: 1,
    })
    expect(title, JSON.stringify(ready)).toContain(SONG.title)
    expect(ready.state?.status).toBe('idle')
    seen.push(`ready: ${JSON.stringify(ready.embed)}, status ${ready.state?.status}`)

    // The Lite tier: the player's own state says so, it has no FXM Connect, its sandbox document
    // runs in an opaque origin, and the free-sources fallback's install hint is not there.
    const state = await embedState(frame)
    expect(state, "the embed controller's state").toMatchObject({ phase: 'ready', tier: 'lite' })
    const connect = await frame.evaluate(() =>
      document.documentElement.hasAttribute('data-fxm-connect'),
    )
    expect(connect, 'the FXM Connect marker').toBe(false)
    const lite = frame
      .childFrames()
      .find((child) => SANDBOX_PATH.test(new URL(child.url()).pathname))
    if (lite === undefined) throw new Error('The player framed no Lite sandbox document')
    sandbox = lite
    const isolated = await lite.evaluate(() => ({
      origin: self.origin,
      listening: document.documentElement.getAttribute('data-fxm-sandbox'),
    }))
    expect(isolated).toEqual({ origin: 'null', listening: 'listening' })
    const view = page.frameLocator('iframe')
    await expect(view.getByText("FXM can't reach YouTube Music", { exact: false })).toHaveCount(0)
    seen.push(
      `the embed's state ${JSON.stringify(state)}, no FXM Connect marker, its sandbox document ${documentOf(lite.url())} in origin ${isolated.origin}`,
    )
    expect(await playing(frame), 'a media element playing before the click').toBeNull()

    // A visitor's click on the play button, inside the frame, starts the song.
    await view.getByRole('button', { name: `Play ${title}`, exact: true }).click()
    const started = await waitForMessage(
      page,
      (message) => message.type === MESSAGE.state && message.state?.status === 'playing',
      60_000,
      'the playing state',
    )
    expect(started.state?.track?.id).toBe(`ytm:track:${SONG.videoId}`)
    expect(started.state?.track?.artists).toContain(SONG.artist)

    // A media element of the frame plays it from googlevideo, muted, for at least 10 s.
    await expect
      .poll(() => playing(frame), { timeout: 30_000, message: 'a playing media element' })
      .not.toBeNull()
    const first = await playing(frame)
    if (first === null) throw new Error('The song stopped right after it started to play')
    const from = Date.now()
    await expect
      .poll(async () => ((await playing(frame))?.currentTime ?? 0) - first.currentTime, {
        timeout: 40_000,
        intervals: [1_000],
        message: "the media element's currentTime advancing 10 s",
      })
      .toBeGreaterThanOrEqual(10)
    const last = await playing(frame)
    if (last === null) throw new Error('The song stopped playing')
    expect(last.muted).toBe(true)
    expect(last.host).toMatch(/\.googlevideo\.com$/)
    const advanced = last.currentTime - first.currentTime
    const seconds = (Date.now() - from) / 1000
    seen.push(
      `a media element played from ${hostOf(last.host)}, muted, its currentTime going from ${first.currentTime.toFixed(1)} s to ${last.currentTime.toFixed(1)} s (${advanced.toFixed(1)} s in ${seconds.toFixed(1)} s)`,
    )

    // The page follows it: the position it reports moves on, and every message is protocol 1.
    const position = async () =>
      (await received(page)).findLast((message) => message.state !== undefined)?.state
        ?.positionMs ?? 0
    await expect
      .poll(position, { timeout: 10_000, message: 'the position the page sees' })
      .toBeGreaterThanOrEqual(10_000)
    const messages = await received(page)
    expect(messages.filter((message) => message.protocol !== PROTOCOL)).toEqual([])
    expect(messages.filter((message) => message.type === MESSAGE.error)).toEqual([])
    for (const message of messages) {
      if (message.state !== undefined)
        expect(Object.keys(message.state).sort()).toEqual(STATE_FIELDS)
    }
    const statuses = messages
      .map((message) => message.state?.status)
      .filter((status, index, all) => status !== undefined && status !== all[index - 1])
    const readies = messages.filter((message) => message.type === MESSAGE.ready).length
    seen.push(
      `the page got ${messages.length} messages, ${readies} of them ready, statuses ${statuses.join(' → ')}, the last position ${await position()} ms`,
    )

    // Every InnerTube request came from the sandbox document, none with a named origin.
    const innerTube = attempted.filter(({ request }) => YOUTUBE_API.test(request.url()))
    expect(innerTube.length).toBeGreaterThan(0)
    const elsewhere = innerTube.filter(({ from }) => !SANDBOX_PATH.test(from.replace(/^[^/]*/, '')))
    expect(elsewhere.map(({ endpoint, from }) => `${endpoint} from ${from}`)).toEqual([])
    const origins = await Promise.all(innerTube.map(({ request }) => originOf(request)))
    expect(origins.filter((origin) => origin.startsWith('http'))).toEqual([])
    seen.push(`InnerTube requests sent with Origin ${[...new Set(origins)].join(', ')}`)

    // No policy violation in the page, the player or its sandbox.
    const documents = [
      await violationsIn(page.mainFrame(), 'the page'),
      await violationsIn(frame, 'the player'),
      await violationsIn(sandbox, 'the sandbox'),
    ]
    expect(documents.flatMap((violations) => violations ?? [])).toEqual([])
    expect(consoleViolations).toEqual([])
    const read = ['the page', 'the player', 'the sandbox'].filter(
      (_, i) => documents[i] !== undefined,
    )
    seen.push(`no policy violation in ${read.join(', ')}`)

    expect(attempted.length, `YouTube requests: ${byEndpoint(attempted)}`).toBeLessThanOrEqual(
      BUDGET,
    )
  } finally {
    server.closeAllConnections()
    server.close()
    const finishedAt = new Date()
    const sent = attempted.slice(0, BUDGET)
    const past = attempted.slice(BUDGET)
    const over =
      past.length > 0 ? `; ${past.length} more refused past the budget (${byEndpoint(past)})` : ''
    const refused = prefetches.length > 0 ? ` (${byEndpoint(prefetches)})` : ''
    const requests = `${sent.length} sent, at most ${BUDGET}: ${byEndpoint(sent)}${over}; ${prefetches.length} prefetch(es) refused${refused}`
    const timing = `${startedAt.toISOString()} to ${finishedAt.toISOString()}`
    const contacted = `${[...hosts].join(', ')}; thumbnails answered here: ${[...answered].join(', ') || 'none'}`
    seen.push(`hosts the documents sent requests to: ${contacted}`)
    console.log(`[embed live check] YouTube requests: ${requests}`)
    for (const line of seen) console.log(`[embed live check] seen: ${line}`)
    // How it ended, which says why when a step above failed.
    try {
      const end = player === undefined ? null : await embedState(player)
      const messages = await received(page)
      const said = messages.map((message) => message.state?.status ?? message.code ?? message.type)
      console.log(
        `[embed live check] at the end: the embed's state ${JSON.stringify(end)}; the page got ${said.filter((status, index) => status !== said[index - 1]).join(' → ') || 'no message'}`,
      )
    } catch (error) {
      console.log(`[embed live check] at the end: the documents could not be read (${error})`)
    }
    if (consoleViolations.length > 0) {
      console.log(`[embed live check] policy messages: ${consoleViolations.join(' | ')}`)
    }
    if (pageErrors.length > 0) {
      console.log(`[embed live check] page errors: ${pageErrors.join(' | ')}`)
    }
    console.log(`[embed live check] ran ${timing}`)
    test
      .info()
      .annotations.push(
        { type: 'environment', description: `${timing}, ${where}` },
        { type: 'youtube-requests', description: requests },
        { type: 'result', description: seen.join('; ') },
      )
  }
})
