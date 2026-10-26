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
 *   tier), it framed its sandbox document, whose origin is opaque, and every InnerTube request,
 *   refused ones too, came from that document with `Origin: null`. The browser has no extension,
 *   so FXM Connect can't answer;
 * - nothing plays until a click on its play button, as a visitor starts it: the player starts no
 *   element with a source before the click, and starts the song's after it, with the frame
 *   activated and the player asking for sound. Every element is muted here, and Chromium lets muted
 *   media play without a gesture; Playwright's own evaluations in the frame count as user gestures
 *   too (it sends them with `userGesture: true`), so the frame is activated before the click as
 *   well. The check therefore shows that the player waits for the click and what Chromium's
 *   autoplay policy looks at when the song starts (activation, a request for sound, a frame with
 *   `allow="autoplay"`), not that the click's activation alone let it start with sound;
 * - one of its media elements plays the song from googlevideo, muted: the same element throughout,
 *   its `currentTime` advancing at least 10 s in at least 10 s of the frame's clock, at
 *   `playbackRate` 1, its `played` ranges adding up to at least 10 s, and its decoded audio
 *   growing, which a stream without sound (video only) would not do;
 * - it posts `fxm-embed:ready`, then the `playing` state, to the page, as protocol 1 documents;
 * - no document (the page, the player, the player's sandbox) reports a Content-Security-Policy or
 *   Permissions-Policy violation, and the recorder that would see one ran in all three;
 * - the documents send requests only to the page's server, the deployment, FXM's site, InnerTube's
 *   three hosts and googlevideo (thumbnails are answered here).
 *
 * It reaches YouTube for real, so it runs only with FXM_LIVE=1 and FXM_DEPLOY_URL, from a
 * residential connection (YouTube meets datacenter addresses with bot checks), and stays within 10
 * requests to YouTube and googlevideo: thumbnails are answered here, `player` requests for any
 * other video (prefetches) are refused here, and every other request counts. The route counts
 * what it sees, and `request` events count the redirect hops, which never reach a route
 * (Playwright sends them on itself): once the count reaches the budget, the route refuses every
 * further request, but a hop can't be refused, so one past the budget goes out and then fails the
 * check. The run closes the page before it counts, so nothing sent late is missed. The browser is
 * headless and muted, and so is every media element. Playwright turns third-party storage
 * partitioning off, which Chrome has on; the check turns it back on, and a probe shows it before
 * the player loads. The run prints when and where it ran, the build the player loaded (its hashed
 * file names), the requests by endpoint and what googlevideo answered, and records them as
 * annotations; the deploy README says how to run it (FXM_CONNECTION names the connection).
 */
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { arch, release, type } from 'node:os'
import {
  type BrowserContext,
  expect,
  type Frame,
  type Page,
  type Request,
  test,
} from '@playwright/test'

const live = process.env.FXM_LIVE === '1' && Boolean(process.env.FXM_DEPLOY_URL)
/** "Creep" by Radiohead, from YouTube Music (Radiohead - Topic): the YouTube fixtures' song. */
const SONG = { videoId: 'zFYEYRcjK2g', title: 'Creep', artist: 'Radiohead' } as const
/** The page that embeds the player, served by the test: another origin and site than FXM's. */
const EMBEDDER_PORT = 6970
const EMBEDDER = `http://127.0.0.1:${EMBEDDER_PORT}`
/** The same server under another site's name, for the storage probe. */
const OTHER_SITE = `http://localhost:${EMBEDDER_PORT}`
/** FXM's site, whatever the deployment under test: the embed may reach its own project's host. */
const FXM_SITE = 'fxmusic.pages.dev'
const INNERTUBE_HOSTS = ['www.youtube.com', 'music.youtube.com', 'youtubei.googleapis.com']
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
 * The Chromium features Playwright 1.64 turns off (`disabledFeatures` in its
 * chromiumSwitches.ts). ThirdPartyStoragePartitioning is one, which Chrome has had on by default
 * since version 115, so the check passes the same list without it. Chromium reads the last
 * `--disable-features`, so this one wins over Playwright's, which `ignoreDefaultArgs` also drops
 * while Playwright's list is unchanged; the storage probe shows the outcome either way.
 */
const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
]
const DISABLED_FEATURES = PLAYWRIGHT_DISABLED_FEATURES.filter(
  (feature) => feature !== 'ThirdPartyStoragePartitioning',
)
/** What the storage probe stores as a first party, and looks for as a third party. */
const PROBE_KEY = 'fxm-storage-probe'
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
  /** Every `play()` call, with what Chromium's autoplay policy looks at. */
  fxmPlays: PlayCall[]
}

/** A `play()` call, as the init script saw it. */
interface PlayCall {
  /** The element's place in `fxmMedia`: the order in which the document first played them. */
  readonly index: number
  /** Whether it had a source: the calls that unlock elements, inside the click, have none. */
  readonly source: boolean
  /**
   * Whether the frame had been activated (`navigator.userActivation.hasBeenActive`): by a user,
   * or by one of Playwright's evaluations, which it sends as user gestures.
   */
  readonly activated: boolean | null
  /** Whether the player asked for sound: the last `muted` it set, or the attribute, was false. */
  readonly sound: boolean
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

/** One of the frame's media elements, read at one moment in the frame. */
interface MediaReading {
  /** Its place in `fxmMedia`, and how many elements the frame has played. */
  readonly index: number
  readonly of: number
  /** The frame's `performance.now()` at the reading, in milliseconds. */
  readonly at: number
  readonly paused: boolean
  readonly currentTime: number
  readonly playbackRate: number
  /** Its `played` ranges added up, in seconds. */
  readonly played: number
  /** `webkitAudioDecodedByteCount`: the audio it decoded, in bytes; `null` without it. */
  readonly audioBytes: number | null
  readonly muted: boolean
  readonly host: string
  /** The stream's `itag` and `mime` parameters, the only ones of its URL that the record keeps. */
  readonly itag: string | null
  readonly mime: string | null
}

/** A request to YouTube or googlevideo. */
interface YouTubeRequest {
  /** Its method, host and path, e.g. `POST music.youtube.com/youtubei/v1/next`. */
  readonly endpoint: string
  /** The document that sent it, as host and path. */
  readonly from: string
  readonly request: Request
  /** Whether it is a redirect hop, which Playwright sends on without the route. */
  readonly hop: boolean
}

test.skip(!live, 'a live check: set FXM_LIVE=1 and FXM_DEPLOY_URL, from a residential connection')
// Headless and silent: the browser plays to no audio device, and every media element is muted.
// Third-party storage is partitioned, as in Chrome (PLAYWRIGHT_DISABLED_FEATURES).
test.use({
  headless: true,
  serviceWorkers: 'block',
  launchOptions: {
    args: ['--mute-audio', `--disable-features=${DISABLED_FEATURES.join(',')}`],
    ignoreDefaultArgs: [`--disable-features=${PLAYWRIGHT_DISABLED_FEATURES.join(',')}`],
  },
})
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

/**
 * The storage probe's pages, all local: OTHER_SITE stores a value as a first party, then a page
 * of EMBEDDER frames OTHER_SITE, a third party there, which finds the value only if storage is
 * not partitioned.
 */
function storagePages(): [string, string][] {
  const key = JSON.stringify(PROBE_KEY)
  return [
    [
      '/storage/set',
      `<!doctype html><title>First party</title><script>localStorage.setItem(${key}, 'first party')</script>`,
    ],
    [
      '/storage/probe',
      `<!doctype html><title>Probe</title><iframe src="${OTHER_SITE}/storage/read"></iframe>`,
    ],
    ['/storage/read', '<!doctype html><title>Third party</title>'],
  ]
}

/**
 * Serves `pages` by path at EMBEDDER (and OTHER_SITE, its other name); the port is strict, so a
 * busy one fails before any request.
 */
async function serve(pages: ReadonlyMap<string, string>): Promise<Server> {
  const server = createServer((request, response) => {
    const html = pages.get(request.url ?? '')
    if (html === undefined) {
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
 * Runs in every document before its own scripts: keeps the policy violations it sees, every media
 * element it plays, muted, and every `play()` call with what the autoplay policy looks at: whether
 * the frame had been activated, and whether the player asked for sound. Muted stays on whatever
 * the player sets; the setting it asked for is kept for the record.
 */
function recordEveryDocument(): void {
  const record = window as unknown as DocumentRecord
  record.fxmMedia = new Set()
  record.fxmViolations = []
  record.fxmPlays = []
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
  /** The `muted` the player last set on each element. */
  const asked = new WeakMap<HTMLMediaElement, boolean>()
  const mute = (element: HTMLMediaElement) => {
    if (set === undefined) element.muted = true
    else set.call(element, true)
  }
  if (get !== undefined && set !== undefined) {
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
      configurable: true,
      enumerable: muted?.enumerable ?? true,
      get() {
        return get.call(this)
      },
      set(this: HTMLMediaElement, value: unknown) {
        asked.set(this, Boolean(value))
        set.call(this, true)
      },
    })
  }
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    mute(this)
    try {
      record.fxmMedia.add(this)
      record.fxmPlays.push({
        index: [...record.fxmMedia].indexOf(this),
        source: this.hasAttribute('src') || this.srcObject !== null,
        activated: navigator.userActivation?.hasBeenActive ?? null,
        sound: !(asked.get(this) ?? this.defaultMuted),
      })
    } catch {
      // Keeping the record never stops the player.
    }
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

/** The video a `player` request asks for, or `undefined` if its body can't be read. */
function videoIdOf(request: Request): string | undefined {
  try {
    const body: unknown = JSON.parse(request.postData() ?? '')
    if (typeof body !== 'object' || body === null || !('videoId' in body)) return undefined
    return typeof body.videoId === 'string' ? body.videoId : undefined
  } catch {
    return undefined
  }
}

/**
 * The `Origin` a request was sent with: `none` without one, `unknown` if the browser hasn't said
 * within 5 s.
 */
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

/**
 * What googlevideo answered `request`: its status and content type from `answers`, the stream's
 * `itag` and `mime`, and where a redirect sent it. Never the whole URL, which carries the address
 * of the connection that asked for it.
 */
function answerOf(request: Request, answers: ReadonlyMap<Request, string>): string {
  const url = new URL(request.url())
  const stream = `itag ${url.searchParams.get('itag') ?? 'unknown'}, ${url.searchParams.get('mime') ?? 'no mime'}`
  const answer = answers.get(request) ?? `no answer (${request.failure()?.errorText ?? 'none yet'})`
  const next = request.redirectedTo()
  const onward = next === null ? '' : `, redirected to ${hostOf(new URL(next.url()).host)}`
  return `${hostOf(url.host)}${url.pathname} (${stream}): ${answer}${onward}`
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

/** Whether `frame` is the player's Lite sandbox document. */
function isSandbox(frame: Frame): boolean {
  try {
    return SANDBOX_PATH.test(new URL(frame.url()).pathname)
  } catch {
    return false
  }
}

/**
 * The embed's own state, read from its controller, which the root component of its React tree
 * holds (`EmbedApp` in apps/web/src/embed/embed-app.tsx): the API's messages never name the tier.
 * `null` when the check can't find it there.
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

/**
 * Reads the frame's media element at `index`, in the order the frame first played them, or with
 * `index` -1 the first one that plays from the network; `null` if there is none.
 */
function readMedia(frame: Frame, index: number): Promise<MediaReading | null> {
  return frame.evaluate((wanted: number): MediaReading | null => {
    const media = [...(window as unknown as DocumentRecord).fxmMedia]
    const at =
      wanted >= 0
        ? wanted
        : media.findIndex(
            (element) =>
              !element.paused && element.currentTime > 0 && /^https?:/.test(element.currentSrc),
          )
    const element = media[at]
    if (element === undefined) return null
    const now = performance.now()
    let played = 0
    for (let range = 0; range < element.played.length; range += 1) {
      played += element.played.end(range) - element.played.start(range)
    }
    const decoded = (element as HTMLMediaElement & { webkitAudioDecodedByteCount?: unknown })
      .webkitAudioDecodedByteCount
    const source = /^https?:/.test(element.currentSrc) ? new URL(element.currentSrc) : undefined
    return {
      index: at,
      of: media.length,
      at: now,
      paused: element.paused,
      currentTime: element.currentTime,
      playbackRate: element.playbackRate,
      played,
      audioBytes: typeof decoded === 'number' ? decoded : null,
      muted: element.muted,
      host: source?.host ?? '',
      itag: source?.searchParams.get('itag') ?? null,
      mime: source?.searchParams.get('mime') ?? null,
    }
  }, index)
}

/**
 * The violations a document's recorder kept, each with the document's name; `recorder` is false
 * when the init script never ran there, which would make "no violation" mean nothing.
 */
async function violationsIn(
  frame: Frame,
  name: string,
): Promise<{ recorder: boolean; violations: string[] }> {
  const kept = await frame.evaluate(() => {
    const violations = (window as unknown as Partial<DocumentRecord>).fxmViolations
    return Array.isArray(violations) ? violations : null
  })
  return {
    recorder: kept !== null,
    violations: (kept ?? []).map((violation) => `${name}: ${violation}`),
  }
}

/**
 * The build the player's document runs: its module scripts, and the names of the asset files it
 * fetched, which Vite derives from their content.
 */
function buildOf(frame: Frame): Promise<{ modules: string[]; assets: string[] }> {
  return frame.evaluate(() => {
    const modules = Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'),
      (script) => new URL(script.src).pathname,
    )
    const assets = performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name))
      .filter((url) => url.origin === location.origin && url.pathname.includes('/assets/'))
      .map((url) => url.pathname.slice(url.pathname.lastIndexOf('/') + 1))
    return { modules, assets: [...new Set(assets)].sort() }
  })
}

/**
 * Whether the browser partitions third-party storage, as Chrome does: OTHER_SITE stores a value
 * as a first party, then a frame of it under EMBEDDER looks for that value. Local pages only, in
 * a page of their own.
 */
async function storagePartitioned(context: BrowserContext): Promise<boolean> {
  const probe = await context.newPage()
  try {
    await probe.goto(`${OTHER_SITE}/storage/set`)
    await probe.goto(`${EMBEDDER}/storage/probe`)
    const frame = probe.frames().find((child) => child.url() === `${OTHER_SITE}/storage/read`)
    if (frame === undefined) throw new Error('The storage probe framed no document')
    return (await frame.evaluate((key) => localStorage.getItem(key), PROBE_KEY)) === null
  } finally {
    await probe.close()
  }
}

/**
 * Whether the documents may send requests to `host`: the page's server under either name, the
 * deployment, FXM's site, InnerTube's three hosts and googlevideo.
 */
function allowedHost(host: string, deployment: string): boolean {
  const known = [new URL(EMBEDDER).host, new URL(OTHER_SITE).host, deployment, FXM_SITE]
  return [...known, ...INNERTUBE_HOSTS].includes(host) || host.endsWith('.googlevideo.com')
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
  return `Chromium ${browserVersion} (${mode}, --mute-audio, third-party storage partitioning on, a temporary profile, no extension, service workers blocked), Playwright ${playwright}, ${os}, connection: ${connection}`
}

test('the production embed plays in Lite inside a page on another site', async ({
  page,
  context,
  browser,
  headless,
}) => {
  test.setTimeout(180_000)
  const fxm = new URL(process.env.FXM_DEPLOY_URL as string).origin
  const deployment = new URL(fxm).host
  const src = new URL(`/embed/track/ytm:${encodeURIComponent(SONG.videoId)}`, fxm).href
  const startedAt = new Date()
  /** Requests to YouTube and googlevideo that went out: those the route let by, and the hops. */
  const sent: YouTubeRequest[] = []
  /** Requests the route refused at the budget. */
  const refused: YouTubeRequest[] = []
  /** `player` requests for other videos, refused before they reach YouTube. */
  const prefetches: YouTubeRequest[] = []
  /** `player` requests whose body the route couldn't read: let by, and counted, as the song's. */
  const unreadable: string[] = []
  /** What googlevideo answered each request: the status and the content type. */
  const answers = new Map<Request, string>()
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
    const youtube = YOUTUBE_API.test(url.href)
    if (!youtube && !GOOGLEVIDEO.test(url.href)) return route.fallback()
    const entry = { endpoint: endpointOf(request), from: senderOf(request), request, hop: false }
    if (youtube && url.pathname.endsWith('/player')) {
      const videoId = videoIdOf(request)
      if (videoId === undefined) {
        unreadable.push(entry.endpoint)
      } else if (videoId !== SONG.videoId) {
        prefetches.push(entry)
        return route.abort('blockedbyclient')
      }
    }
    // At the budget, which redirect hops count towards too: refused, and the check fails below.
    if (sent.length >= BUDGET) {
      refused.push(entry)
      return route.abort('blockedbyclient')
    }
    sent.push(entry)
    return route.fallback()
  })
  // Redirect hops never reach the route: Playwright sends them on itself. They count here, and
  // every request's host is noted, hops' too.
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    const previous = request.redirectedFrom()
    // Thumbnails are answered here and never leave the browser; a hop always does.
    if (previous === null && IMAGES.test(url.href)) return
    hosts.add(hostOf(url.host))
    if (previous === null || (!YOUTUBE_API.test(url.href) && !GOOGLEVIDEO.test(url.href))) return
    const endpoint = `${endpointOf(request)}, redirected from ${hostOf(new URL(previous.url()).host)}`
    sent.push({ endpoint, from: senderOf(request), request, hop: true })
  })
  context.on('response', (response) => {
    if (!GOOGLEVIDEO.test(response.url())) return
    const contentType = response.headers()['content-type'] ?? 'without a content type'
    answers.set(response.request(), `${response.status()} ${contentType}`)
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

  const server = await serve(new Map([['/', embedderPage(fxm, src)], ...storagePages()]))
  let player: Frame | undefined
  try {
    // Storage is partitioned as in Chrome, shown before anything reaches FXM or YouTube.
    expect(await storagePartitioned(context), 'third-party storage partitioned').toBe(true)
    seen.push(
      `third-party storage partitioned: a frame of ${new URL(OTHER_SITE).host} under ${new URL(EMBEDDER).host} did not find what that site had stored as a first party`,
    )

    await page.goto(`${EMBEDDER}/`)
    expect(await page.evaluate(() => location.origin)).toBe(EMBEDDER)
    // Another site too: schemeful same-site would need the deployment on http://127.0.0.1.
    const target = new URL(fxm)
    expect(
      target.protocol === 'http:' && target.hostname === '127.0.0.1',
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

    // The Lite tier: the player's own state says so, its sandbox document runs in an opaque
    // origin, and the free-sources fallback's hint for YouTube is not there, in its wording since
    // v0.2.0 or before. No extension is loaded, so FXM Connect can't answer.
    const state = await embedState(frame)
    if (state === null) {
      throw new Error(
        "The check could not read the embed controller's state: EmbedApp's <main>, or React's __reactFiber$ key, has changed",
      )
    }
    expect(state, "the embed controller's state").toMatchObject({ phase: 'ready', tier: 'lite' })
    const lite = frame.childFrames().find(isSandbox)
    if (lite === undefined) throw new Error('The player framed no Lite sandbox document')
    const isolated = await lite.evaluate(() => ({
      origin: self.origin,
      listening: document.documentElement.getAttribute('data-fxm-sandbox'),
    }))
    expect(isolated).toEqual({ origin: 'null', listening: 'listening' })
    const view = page.frameLocator('iframe')
    await expect(
      view.getByText(/YouTube Music can't play in this player|FXM can't reach YouTube Music/),
    ).toHaveCount(0)
    seen.push(
      `the embed's state ${JSON.stringify(state)}, its sandbox document ${documentOf(lite.url())} in origin ${isolated.origin}`,
    )

    // Before the click nothing plays, and the player has started no element with a source (it may
    // unlock elements without one). The frame counts as activated already: Playwright sends its
    // evaluations, this one too, as user gestures.
    expect(await readMedia(frame, -1), 'a media element playing before the click').toBeNull()
    const before = await frame.evaluate(() => {
      const plays = (window as unknown as DocumentRecord).fxmPlays
      return {
        activated: navigator.userActivation?.hasBeenActive ?? null,
        plays: plays.length,
        starts: plays.filter((call) => call.source).length,
      }
    })
    expect(before.starts, 'play() calls on an element with a source before the click').toBe(0)

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

    // A media element of the frame plays it from googlevideo, muted, for at least 10 s: the same
    // element throughout, at speed 1, through 10 s of the frame's clock, with no seek making up
    // the time (its played ranges), decoding audio as it goes.
    await expect
      .poll(async () => (await readMedia(frame, -1)) !== null, {
        timeout: 30_000,
        message: 'a playing media element',
      })
      .toBe(true)
    const first = await readMedia(frame, -1)
    if (first === null) throw new Error('The song stopped right after it started to play')
    let latest = first
    await expect
      .poll(
        async () => {
          const now = await readMedia(frame, first.index)
          if (now === null || now.paused) return 0
          latest = now
          return Math.min(now.currentTime - first.currentTime, (now.at - first.at) / 1000)
        },
        {
          timeout: 40_000,
          intervals: [1_000],
          message: "the media element's currentTime and the frame's clock advancing 10 s",
        },
      )
      .toBeGreaterThanOrEqual(10)
    const last = latest
    expect(last.muted, 'the element muted').toBe(true)
    expect(last.host).toMatch(/\.googlevideo\.com$/)
    expect(last.playbackRate, 'its playbackRate').toBe(1)
    expect(last.played, 'its played ranges added up, in seconds').toBeGreaterThanOrEqual(10)
    if (first.audioBytes === null || last.audioBytes === null) {
      throw new Error('The browser reports no decoded audio (webkitAudioDecodedByteCount)')
    }
    expect(last.audioBytes, 'the audio it decoded, in bytes').toBeGreaterThan(first.audioBytes)
    const advanced = last.currentTime - first.currentTime
    const seconds = (last.at - first.at) / 1000
    const decoded = Math.round((last.audioBytes - first.audioBytes) / 1000)
    seen.push(
      `the frame's media element ${first.index + 1} of ${last.of} played itag ${last.itag ?? 'unknown'} (${last.mime ?? 'no mime'}) from ${hostOf(last.host)}, muted, at playbackRate ${last.playbackRate}: its currentTime went from ${first.currentTime.toFixed(1)} s to ${last.currentTime.toFixed(1)} s (${advanced.toFixed(1)} s in ${seconds.toFixed(1)} s of the frame's clock), its played ranges add up to ${last.played.toFixed(1)} s, and it decoded ${decoded} kB of audio meanwhile`,
    )

    // The player started the song's element only after the click, each time with the frame
    // activated and asking for sound: what Chromium needs to start it with sound in a frame with
    // allow="autoplay" (here it is muted all the same). A visitor's frame gets its activation
    // from the visitor; this one also has Playwright's.
    const plays = await frame.evaluate(() => (window as unknown as DocumentRecord).fxmPlays)
    const starts = plays.filter((call) => call.index === first.index && call.source)
    expect(starts.length, "play() calls on the song's element").toBeGreaterThan(0)
    expect(
      starts.filter((call) => call.activated !== true || !call.sound),
      "play() calls on the song's element in a frame not activated, or muted by the player",
    ).toEqual([])
    seen.push(
      `before the click no media element played, and the player had started none with a source (${before.plays} play() call(s) in all; the frame counted as activated already: ${before.activated}, by Playwright's evaluations); after it the player started the song's element ${starts.length} time(s), each with the frame activated and the player asking for sound`,
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

    // Every InnerTube request, the refused ones too, came from the sandbox document with Origin
    // null.
    const sandboxDocument = `${deployment}/sandbox/innertube`
    const innerTube = [...sent, ...refused, ...prefetches].filter(({ request }) =>
      YOUTUBE_API.test(request.url()),
    )
    expect(innerTube.length, 'InnerTube requests').toBeGreaterThan(0)
    const origins = await Promise.all(innerTube.map(({ request }) => originOf(request)))
    const astray = innerTube.flatMap(({ endpoint, from }, index) => {
      const origin = origins[index] ?? 'unknown'
      const fromSandbox = from === sandboxDocument || from === `${sandboxDocument}.html`
      return fromSandbox && origin === 'null' ? [] : [`${endpoint} from ${from}, Origin ${origin}`]
    })
    expect(
      astray,
      `InnerTube requests from elsewhere than ${sandboxDocument} or without Origin: null (unknown: the browser did not say within 5 s)`,
    ).toEqual([])
    seen.push(`${innerTube.length} InnerTube requests, all from ${sandboxDocument}, Origin null`)

    // No policy violation in the page, the player or its sandbox, the recorder running in each.
    const documents: [string, Frame | undefined][] = [
      ['the page', page.mainFrame()],
      ['the player', frame],
      ['the sandbox', frame.childFrames().find(isSandbox)],
    ]
    const records: { name: string; recorder: boolean; violations: string[] }[] = []
    for (const [name, document] of documents) {
      if (document === undefined || document.isDetached()) {
        throw new Error(`The check could not read ${name}: it is gone`)
      }
      records.push({ name, ...(await violationsIn(document, name)) })
    }
    expect(
      records.filter(({ recorder }) => !recorder).map(({ name }) => name),
      'documents the recorder did not run in',
    ).toEqual([])
    expect(records.flatMap(({ violations }) => violations)).toEqual([])
    expect(consoleViolations).toEqual([])
    seen.push('no policy violation in the page, the player, the sandbox, the recorder in each')
  } finally {
    // How it ended, which says why when a step above failed, and the player's build: both read
    // before the page closes.
    let ending: string
    try {
      const end = player === undefined || player.isDetached() ? null : await embedState(player)
      const messages = await received(page)
      const said = messages.map((message) => message.state?.status ?? message.code ?? message.type)
      ending = `the embed's state ${JSON.stringify(end)}; the page got ${said.filter((status, index) => status !== said[index - 1]).join(' → ') || 'no message'}`
    } catch (error) {
      ending = `the documents could not be read (${error})`
    }
    let build = 'not read: the player never loaded'
    if (player !== undefined && !player.isDetached()) {
      try {
        const { modules, assets } = await buildOf(player)
        build = `${modules.join(', ') || 'no module script'}; asset files fetched: ${assets.join(', ') || 'none'}`
      } catch (error) {
        build = `not read (${error})`
      }
    }
    // Once the page is closed nothing more goes out, so what is counted below is the whole run.
    await page.close().catch(() => undefined)
    server.closeAllConnections()
    server.close()
    const finishedAt = new Date()
    const tried = sent.length + refused.length
    const routed = sent.filter(({ hop }) => !hop)
    const hops = sent.filter(({ hop }) => hop)
    const media = sent
      .filter(({ request }) => GOOGLEVIDEO.test(request.url()))
      .map(({ request }) => answerOf(request, answers))
    const requests = [
      `${sent.length} sent, redirect hops included, at most ${BUDGET}: ${byEndpoint(routed)}`,
      `redirect hops: ${byEndpoint(hops)}`,
      ...(refused.length > 0
        ? [`${refused.length} refused at the budget (${byEndpoint(refused)})`]
        : []),
      `${prefetches.length} prefetch(es) refused${prefetches.length > 0 ? ` (${byEndpoint(prefetches)})` : ''}`,
      ...(unreadable.length > 0
        ? [`${unreadable.length} player request(s) with a body the check could not read, counted`]
        : []),
      `googlevideo answered: ${media.join('; ') || 'nothing'}`,
    ].join('; ')
    const timing = `${startedAt.toISOString()} to ${finishedAt.toISOString()}`
    const contacted = `${[...hosts].join(', ') || 'none'}; thumbnails answered here: ${[...answered].join(', ') || 'none'}`
    const strange = [...hosts].filter((host) => !allowedHost(host, deployment))
    seen.push(`hosts the documents sent requests to: ${contacted}`)
    console.log(`[embed live check] YouTube requests: ${requests}`)
    for (const line of seen) console.log(`[embed live check] seen: ${line}`)
    console.log(`[embed live check] the player's build: ${build}`)
    console.log(`[embed live check] at the end: ${ending}`)
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
        { type: 'build', description: build },
        { type: 'youtube-requests', description: requests },
        { type: 'result', description: seen.join('; ') },
      )
    // Soft, so that a failure above still shows: every request the documents tried, the refused
    // ones and the hops included, within the budget, and only to the hosts above.
    expect.soft(tried, `YouTube requests: ${requests}`).toBeLessThanOrEqual(BUDGET)
    expect
      .soft(strange, 'hosts besides the page, the deployment, FXM, InnerTube and googlevideo')
      .toEqual([])
  }
})
