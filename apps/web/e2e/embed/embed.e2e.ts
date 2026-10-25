/**
 * The embeddable player on another site (stage 5.2). Done when it plays in Lite inside a test
 * page on another origin: the first test shows that, through the real platform, the real
 * sandbox document, the stream lifecycle and an `<audio>` element, against the mocks in
 * network.ts. The YouTube metadata and ladder are the test doubles of `--mode e2e`
 * (`src/embed/testing/e2e-services.ts`), because stages 1.3 and 1.4 hadn't merged.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type FrameLocator, type Page } from '@playwright/test'
import {
  E2E_ALBUM,
  E2E_ARCHIVE_NATIVE_ID,
  E2E_ARCHIVE_TRACK,
  E2E_SONGS,
  E2E_VIDEO,
} from '../../src/embed/testing/e2e-fixtures'
import {
  ARCHIVE_HOST,
  EMBEDDER,
  EMBEDDER_HOST,
  FXM,
  FXM_HOST,
  INNERTUBE_HOSTS,
  MEDIA_HOST,
  SIBLING_HOST,
  startTestNetwork,
  type TestNetwork,
} from './network'

const SONG = E2E_SONGS.lite
const TRACK_PATH = `/embed/track/ytm:${SONG.videoId}`
const ALBUM_PATH = `/embed/album/ytm:${E2E_ALBUM.browseId}`
const VIDEO_PATH = `/embed/track/ytm:${E2E_VIDEO.videoId}`
const ARCHIVE_PATH = `/embed/track/archive:${encodeURIComponent(E2E_ARCHIVE_NATIVE_ID)}`
const SCREENSHOTS = fileURLToPath(new URL('../../screenshots/embed/', import.meta.url))

/** Hosts the pages may reach: everything else would be a request to the internet. */
const PAGE_HOSTS = new Set([
  FXM_HOST,
  EMBEDDER_HOST,
  SIBLING_HOST,
  ...INNERTUBE_HOSTS,
  MEDIA_HOST,
  ARCHIVE_HOST,
])

/** A message the player posted to the page. */
interface PlayerMessage {
  readonly type: string
  readonly protocol?: number
  readonly code?: string
  readonly id?: string | number
  readonly command?: string
  readonly embed?: { kind: string; id: string; title: string | null; trackCount: number }
  readonly state?: {
    status: string
    index: number
    trackCount: number
    positionMs: number
    muted: boolean
    volume: number
    track: { id: string; title: string; artists: string[] } | null
  }
}

declare global {
  interface Window {
    received: PlayerMessage[]
    sendToPlayer(message: unknown, targetOrigin?: string): void
    hello(): void
    __cspViolations?: string[]
  }
}

const test = base.extend<{ hosts: Set<string> }, { network: TestNetwork }>({
  network: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a fixture uses from its first parameter.
    async ({}, use) => {
      const network = await startTestNetwork()
      await use(network)
      await network.close()
    },
    { scope: 'worker', auto: true },
  ],
  // Every host the page and its frames sent a request to (the browser's own traffic aside).
  hosts: async ({ page, network }, use) => {
    network.reset()
    const hosts = new Set<string>()
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.protocol === 'https:' || url.protocol === 'http:') hosts.add(url.hostname)
    })
    // Every frame, the player's included, keeps the policy violations it sees.
    await page.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`)
      })
    })
    await use(hosts)
  },
})

// Every test starts with an empty log and the mocks' defaults, whether it reads hosts or not.
test.beforeEach(({ hosts }) => {
  expect(hosts.size).toBe(0)
})

/** Opens the other site's page with the player at `embed` (a path and query on FXM's site). */
async function openEmbedder(
  page: Page,
  embed: string,
  options: { height?: number; hello?: boolean } = {},
): Promise<FrameLocator> {
  const url = new URL(EMBEDDER)
  url.searchParams.set('embed', embed)
  if (options.height !== undefined) url.searchParams.set('height', String(options.height))
  if (options.hello === false) url.searchParams.set('hello', '0')
  await page.goto(url.href)
  return page.frameLocator('#player')
}

/** The policy violations the player's frame saw. */
async function playerViolations(page: Page): Promise<string[] | undefined> {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(`${FXM}/embed/`))
  return frame?.evaluate(() => window.__cspViolations)
}

/** Every message the player posted to the page so far. */
function received(page: Page): Promise<PlayerMessage[]> {
  return page.evaluate(() => window.received)
}

/** Waits for a message from the player that `match` accepts, and returns it. */
async function waitForMessage(
  page: Page,
  match: (message: PlayerMessage) => boolean,
  timeout = 20_000,
): Promise<PlayerMessage> {
  let found: PlayerMessage | undefined
  await expect
    .poll(
      async () => {
        found = (await received(page)).findLast(match)
        return found !== undefined
      },
      { timeout },
    )
    .toBe(true)
  return found as PlayerMessage
}

/** The newest state the player reported. */
async function lastState(page: Page): Promise<PlayerMessage['state']> {
  const messages = await received(page)
  return messages.findLast((message) => message.state !== undefined)?.state
}

const hasStatus = (status: string) => (message: PlayerMessage) =>
  (message.type === 'fxm-embed:state' || message.type === 'fxm-embed:ready') &&
  message.state?.status === status

/** Sends a command to the player, as the page's own script would. */
function command(page: Page, message: Record<string, unknown>): Promise<void> {
  return page.evaluate(
    (fields) => window.sendToPlayer({ type: 'fxm-embed:command', protocol: 1, ...fields }),
    message,
  )
}

async function screenshot(frame: FrameLocator, name: string): Promise<void> {
  if (!process.env.FXM_SCREENSHOTS) return
  mkdirSync(SCREENSHOTS, { recursive: true })
  await frame.locator('main').screenshot({ path: `${SCREENSHOTS}${name}.png` })
}

test('plays in Lite inside a page on another origin', async ({ page, network, hosts }) => {
  const frame = await openEmbedder(page, TRACK_PATH)

  // The player paired with the page and is ready: Lite, since nothing else applies.
  const ready = await waitForMessage(page, (message) => message.type === 'fxm-embed:ready')
  expect(ready.protocol).toBe(1)
  expect(ready.embed).toEqual({
    kind: 'track',
    id: `ytm:track:${SONG.videoId}`,
    title: SONG.title,
    trackCount: 1,
  })
  expect(ready.state?.status).toBe('idle')
  await expect(frame.getByRole('heading', { name: SONG.title })).toBeVisible()
  await screenshot(frame, 'card-track')

  await frame.getByRole('button', { name: `Play ${SONG.title}` }).click()

  const playing = await waitForMessage(page, hasStatus('playing'))
  expect(playing.state?.track).toEqual({
    id: `ytm:track:${SONG.videoId}`,
    title: SONG.title,
    artists: [SONG.artist],
  })
  // The position moves on: audio plays.
  await waitForMessage(
    page,
    (message) => message.type === 'fxm-embed:state' && (message.state?.positionMs ?? 0) >= 1500,
  )
  await expect(frame.getByRole('button', { name: 'Pause' })).toBeVisible()
  await screenshot(frame, 'card-track-playing')

  // Every InnerTube call came from the opaque sandbox document, never from FXM's origin, in the
  // CORS-simple shape: the self-test, then one /player call per rung.
  const innerTube = INNERTUBE_HOSTS.flatMap((host) => network.requests(host))
  expect(new Set(innerTube.map((entry) => entry.path?.split('?')[0]))).toEqual(
    new Set(['/youtubei/v1/music/get_search_suggestions', '/youtubei/v1/player']),
  )
  expect(innerTube.every((entry) => entry.origin === 'null')).toBe(true)
  expect(innerTube.every((entry) => entry.contentType?.startsWith('text/plain'))).toBe(true)

  // The top rung's URL was capped: the media element's first request failed, so the lifecycle
  // fell back to itag 18, which played (stage 2.3's Lite probe, inside the third-party page).
  const players = network.requests('www.youtube.com', '/youtubei/v1/player')
  const clients = players.map((entry) => JSON.parse(entry.body ?? '{}').context?.client?.clientName)
  expect(clients).toEqual(['VISIONOS', 'ANDROID'])
  const media = network.requests(MEDIA_HOST, '/videoplayback')
  const capped = media.filter((entry) => entry.path?.includes('fxm=capped'))
  const full = media.filter((entry) => entry.path?.includes('fxm=full'))
  expect(capped.length).toBeGreaterThan(0)
  expect(capped.every((entry) => entry.status === 403)).toBe(true)
  expect(full.some((entry) => entry.status === 200 || entry.status === 206)).toBe(true)

  // Media requests carry no Referer, no page reached a host outside the test network, and the
  // player ran under the app's policy minus frame-ancestors without a violation.
  expect(media.every((entry) => entry.referer === undefined)).toBe(true)
  expect([...hosts].filter((host) => !PAGE_HOSTS.has(host))).toEqual([])
  expect(await playerViolations(page)).toEqual([])
})

test('answers the page that embeds it, and only that page', async ({ page }) => {
  const frame = await openEmbedder(page, TRACK_PATH)
  await waitForMessage(page, (message) => message.type === 'fxm-embed:ready')
  await page.locator('#page-button').click() // The page's own user activation.

  // Commands from the page: play, then pause, seek and mute.
  await command(page, { command: 'play' })
  await waitForMessage(page, hasStatus('playing'))
  await command(page, { command: 'pause' })
  await waitForMessage(page, hasStatus('paused'))
  await command(page, { command: 'seek', positionMs: 20_000 })
  await expect.poll(async () => (await lastState(page))?.positionMs).toBeGreaterThanOrEqual(19_000)
  await command(page, { command: 'setMuted', muted: true, id: 'mute-1' })
  await expect.poll(async () => (await lastState(page))?.muted).toBe(true)
  await expect(frame.getByRole('button', { name: `Play ${SONG.title}` })).toBeVisible()

  // Every parameter is checked: refusals name the command and echo the page's own ID.
  await command(page, { command: 'seek', positionMs: -5, id: 'bad-seek' })
  await command(page, { command: 'setVolume', volume: 2, id: 7 })
  await command(page, { command: 'play', index: 1, id: 'no-such-track' })
  await command(page, { command: 'play', unexpected: true, id: 'extra-field' })
  await command(page, { command: 'eject', id: 'unknown' })
  await expect
    .poll(async () =>
      (await received(page))
        .filter((message) => message.type === 'fxm-embed:error')
        .map(({ code, id, command: name }) => ({ code, id, command: name })),
    )
    .toEqual([
      { code: 'bad-request', id: 'bad-seek', command: 'seek' },
      { code: 'bad-request', id: 7, command: 'setVolume' },
      { code: 'bad-request', id: 'no-such-track', command: 'play' },
      { code: 'bad-request', id: 'extra-field', command: 'play' },
      { code: 'unsupported', id: 'unknown', command: undefined },
    ])

  // A frame of a third site next to the player is not its parent: it is ignored.
  const sibling = page.frames().find((candidate) => candidate.url().includes(SIBLING_HOST))
  const before = (await received(page)).length
  await sibling?.evaluate(() => {
    window.sendToPlayer({ type: 'fxm-embed:hello', protocol: 1 })
    window.sendToPlayer({ type: 'fxm-embed:command', protocol: 1, command: 'play' })
  })
  await page.waitForTimeout(500)
  expect((await lastState(page))?.status).toBe('paused')
  expect((await received(page)).length).toBe(before)
})

test('announces itself only to the origin its address names', async ({ page }) => {
  // With `origin`, the player announces itself to that origin without a hello.
  await openEmbedder(page, `${TRACK_PATH}?origin=${encodeURIComponent(EMBEDDER)}`, {
    hello: false,
  })
  await waitForMessage(page, (message) => message.type === 'fxm-embed:ready')

  // Named for another origin, it never talks to this page, even when it says hello.
  await openEmbedder(
    page,
    `${TRACK_PATH}?origin=${encodeURIComponent('https://elsewhere.example')}`,
  )
  await page.waitForTimeout(1500)
  expect(await received(page)).toEqual([])
})

test('plays free sources and shows the install hint without Lite', async ({ page, network }) => {
  // InnerTube stops answering opaque origins: the self-test fails, and YouTube is out of reach.
  network.state.refuseOpaque = true
  const frame = await openEmbedder(page, TRACK_PATH)
  await waitForMessage(page, hasStatus('unavailable'))
  await expect(frame.getByText(/FXM can't reach YouTube Music in this browser/)).toBeVisible()
  await expect(frame.getByRole('link', { name: 'Get FXM' })).toHaveAttribute('href', `${FXM}/#get`)
  await screenshot(frame, 'card-install-hint')
  // The self-test was the only InnerTube call; nothing else was tried.
  const innerTube = INNERTUBE_HOSTS.flatMap((host) => network.requests(host))
  expect(innerTube.map((entry) => entry.path?.split('?')[0])).toEqual([
    '/youtubei/v1/music/get_search_suggestions',
  ])

  // An Internet Archive track plays anyway, with its credits, and frames no sandbox.
  network.reset()
  network.state.refuseOpaque = true
  const archive = await openEmbedder(page, ARCHIVE_PATH)
  await waitForMessage(page, (message) => message.type === 'fxm-embed:ready')
  await archive.getByRole('button', { name: `Play ${E2E_ARCHIVE_TRACK.title}` }).click()
  await waitForMessage(page, hasStatus('playing'))
  await expect(archive.getByRole('link', { name: 'Internet Archive' })).toBeVisible()
  expect(network.requests(ARCHIVE_HOST, '/download/').length).toBeGreaterThan(0)
  expect(INNERTUBE_HOSTS.flatMap((host) => network.requests(host))).toEqual([])
  expect(network.requests(FXM_HOST, '/sandbox/')).toEqual([])
})

test('plays an album from its track list', async ({ page }) => {
  const frame = await openEmbedder(page, ALBUM_PATH, { height: 380 })
  const ready = await waitForMessage(page, (message) => message.type === 'fxm-embed:ready')
  expect(ready.embed?.trackCount).toBe(3)
  const tracks = frame.getByRole('list', { name: 'Tracks' }).getByRole('button')
  await expect(tracks).toHaveCount(3)
  await expect(frame.getByText(`Album · 3 songs`)).toBeVisible()
  await screenshot(frame, 'card-album')

  await frame
    .getByRole('button', { name: `Play ${E2E_SONGS.second.title} by The Sandboxes` })
    .click()
  const playing = await waitForMessage(page, hasStatus('playing'))
  expect(playing.state?.index).toBe(1)
  await expect(tracks.nth(1)).toHaveAttribute('aria-current', 'true')

  await command(page, { command: 'next' })
  await expect
    .poll(async () => {
      const state = await lastState(page)
      return state?.status === 'playing' ? state.track?.title : undefined
    })
    .toBe(E2E_SONGS.third.title)
  await screenshot(frame, 'card-album-playing')
})

test('plays a video only in Music + Video mode', async ({ page }) => {
  const music = await openEmbedder(page, VIDEO_PATH)
  await waitForMessage(page, hasStatus('unavailable'))
  await expect(music.getByText('This is a video, and this player plays songs only.')).toBeVisible()

  const all = await openEmbedder(page, `${VIDEO_PATH}?mode=all&layout=compact`, { height: 80 })
  await waitForMessage(page, (message) => message.type === 'fxm-embed:ready')
  await all.getByRole('button', { name: `Play ${E2E_VIDEO.title}` }).click()
  await waitForMessage(page, hasStatus('playing'))
})

test('comes in a compact layout, light or dark', async ({ page }) => {
  for (const theme of ['dark', 'light'] as const) {
    const frame = await openEmbedder(page, `${ALBUM_PATH}?layout=compact&theme=${theme}`, {
      height: 80,
    })
    await waitForMessage(page, (message) => message.type === 'fxm-embed:ready')
    await expect(frame.getByRole('button', { name: `Play ${E2E_ALBUM.name}` })).toBeVisible()
    await expect(frame.getByRole('button', { name: 'Next track' })).toBeVisible()
    const box = await frame.locator('main').boundingBox()
    expect(box?.height).toBeLessThanOrEqual(80)
    expect(await frame.locator('html').getAttribute('data-theme')).toBe(
      theme === 'light' ? 'light' : null,
    )
    await screenshot(frame, `compact-album-${theme}`)
  }
})

test('frames the player on any site but never the app', async ({ page }) => {
  await page.goto(`${EMBEDDER}/?embed=${encodeURIComponent('/app/')}`)
  // The app's policy has `frame-ancestors 'none'`: the browser refuses to show it in the frame.
  await page.waitForTimeout(1000)
  const appFrame = page.frames().find((candidate) => candidate.url().startsWith(`${FXM}/app/`))
  const shown = await appFrame
    ?.evaluate(() => document.getElementById('app') !== null)
    .catch(() => false)
  expect(shown ?? false).toBe(false)

  const frame = await openEmbedder(page, TRACK_PATH)
  await expect(frame.getByRole('heading', { name: SONG.title })).toBeVisible()
})
