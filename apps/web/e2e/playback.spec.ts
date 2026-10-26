import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../src/app/services/testing/fake-network'
import { type ConnectRecord, FIXTURES, installFakeConnect, stubNetwork } from './fake-services'

// Search, play and the next track in a real browser, through the app's real composition
// (src/app/services): platform, providers, stream lifecycle, player and <audio>. Only the network
// is fake: every request that leaves the page is answered from the providers' recorded fixtures
// (src/app/services/testing/fake-network.ts), and the streams are short WAV tones that the page
// really plays. Nothing reaches the internet.
//
// The Lite tier runs the real sandbox document of stage 1.10 (apps/web/sandbox/innertube.html),
// which the deploy serves at /sandbox/ and `vite preview` doesn't, so its test serves it. The
// shell never waits for the services: with an FXM Connect that answers late, it paints at once
// and says it is connecting, rather than offering the install.

/** The Lite tier's sandbox document, as the deploy serves it at `/sandbox/innertube.html`. */
const SANDBOX_DOCUMENT = readFileSync(new URL('../sandbox/innertube.html', import.meta.url), 'utf8')

/**
 * Serves the sandbox document as the deploy does, with its header: a page without FXM Connect
 * then runs the Lite self-test and, with InnerTube answering its opaque origin (the fake network
 * allows every origin), gets the Lite tier.
 */
async function serveSandbox(page: Page): Promise<void> {
  await page.route('**/sandbox/innertube.html', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'content-security-policy': 'sandbox allow-scripts' },
      body: SANDBOX_DOCUMENT,
    }),
  )
}

/** Each stream plays this long, so a track ends by itself within the test. */
const TRACK_SECONDS = 1.5

/** What the page's init scripts record, read with `page.evaluate`. */
interface PageRecord extends ConnectRecord {
  fxmMedia: Set<HTMLMediaElement>
  /** When `#root` first got content, as `performance.now()`. */
  fxmFirstRender?: number
  /** Whether the install pitch ("Get FXM Connect") ever showed. */
  fxmSawInstallPitch?: boolean
}

/**
 * Records when the app first renders into `#root`, and whether the install pitch for FXM
 * Connect ever shows (its "Get FXM Connect" link).
 */
async function watchShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = window as unknown as PageRecord
    record.fxmSawInstallPitch = false
    new MutationObserver(() => {
      if (record.fxmFirstRender === undefined && document.getElementById('root')?.firstChild) {
        record.fxmFirstRender = performance.now()
      }
      if (document.body?.textContent?.includes('Get FXM Connect')) record.fxmSawInstallPitch = true
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
}

/**
 * Keeps a reference to every media element the page plays: the player's `<audio>` elements are
 * never attached to the document, so they can't be found in it.
 */
async function trackMediaElements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const played = new Set<HTMLMediaElement>()
    ;(window as unknown as PageRecord).fxmMedia = played
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      played.add(this)
      return play.call(this)
    }
  })
}

/**
 * What the page plays: the title in the system media controls, and the URL an `<audio>` element
 * is playing (it is past its start and not paused), else `null`.
 */
function nowPlaying(page: Page): Promise<{ title: string | null; url: string | null }> {
  return page.evaluate(() => {
    const played = (window as unknown as PageRecord).fxmMedia
    const playing = [...played].find((media) => !media.paused && media.currentTime > 0)
    return {
      title: navigator.mediaSession.metadata?.title ?? null,
      url: playing?.currentSrc ?? null,
    }
  })
}

/** Waits until the page plays `title` from `host`, and returns the URL it plays. */
async function waitUntilPlaying(page: Page, title: string | undefined, host: string) {
  let url = ''
  await expect
    .poll(
      async () => {
        const now = await nowPlaying(page)
        url = now.url ?? ''
        return { title: now.title, host: now.url === null ? null : new URL(now.url).hostname }
      },
      { timeout: 10_000 },
    )
    .toEqual({ title, host })
  return new URL(url)
}

/** The titles of the songs a results list shows, in order. */
async function titles(page: Page, list: string): Promise<string[]> {
  const labels = await page
    .getByRole('list', { name: list })
    .getByRole('button', { name: /^Play / })
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''))
  return labels.map((label) => label.replace(/^Play /u, '').replace(/ by .*$/u, ''))
}

test.describe('the Full tier (FXM Connect)', () => {
  test('searches YouTube Music, plays a song, then the next ones', async ({ page }) => {
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
    await stubNetwork(page, network)
    await trackMediaElements(page)
    await watchShell(page)
    await installFakeConnect(page)

    await page.goto('search?q=radiohead%20creep')
    const songs = page.getByRole('list', { name: 'Songs' })
    await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible()
    const [first, second, third] = await titles(page, 'Songs')

    await songs
      .getByRole('button', { name: /^Play / })
      .first()
      .click()

    const googlevideo = 'rr1---sn-fxmfixture.googlevideo.com'
    const firstUrl = await waitUntilPlaying(page, first, googlevideo)
    // The end-of-file probes ran, since FXM Connect makes googlevideo's bytes readable.
    const probes = network.requests.filter((request) =>
      /^bytes=\d+-\d+$/u.test(request.headers.range ?? ''),
    )
    expect(probes).not.toHaveLength(0)

    // Next, from the player bar.
    await page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Next' }).click()
    const secondUrl = await waitUntilPlaying(page, second, googlevideo)

    // And the one after it, when that one ends by itself.
    const thirdUrl = await waitUntilPlaying(page, third, googlevideo)
    // Three videos, each from its own /player answer.
    const videos = [firstUrl, secondUrl, thirdUrl].map((url) => url.searchParams.get('id'))
    expect(new Set(videos).size).toBe(3)
    for (const video of videos) expect(network.players).toContain(video)
    // FXM Connect was there from the start, so the page never offered to install it.
    expect(await page.evaluate(() => (window as unknown as PageRecord).fxmSawInstallPitch)).toBe(
      false,
    )
  })

  test('paints the shell at once, and never offers the install, when FXM Connect answers late', async ({
    page,
  }) => {
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
    await stubNetwork(page, network)
    await watchShell(page)
    // Later than the platform's 800 ms wait for the answer.
    await installFakeConnect(page, { pongDelayMs: 1500 })

    await page.goto('search?q=radiohead%20creep')

    await expect(page.getByRole('heading', { name: 'Connecting to FXM Connect…' })).toBeVisible()
    const songs = page.getByRole('list', { name: 'Songs' })
    await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible({
      timeout: 10_000,
    })
    const record = await page.evaluate(() => {
      const { fxmFirstRender, fxmSawInstallPitch, fxmPongAt } = window as unknown as PageRecord
      const [navigation] = performance.getEntriesByType('navigation')
      const ready = (navigation as PerformanceNavigationTiming | undefined)
        ?.domContentLoadedEventEnd
      return { fxmFirstRender, fxmSawInstallPitch, fxmPongAt, ready }
    })
    expect(record.fxmSawInstallPitch).toBe(false)
    // The shell doesn't wait for FXM Connect: it paints right after the document is ready (a
    // few milliseconds; the bound leaves room for a busy machine), long before the answer.
    expect(record.fxmFirstRender).toBeDefined()
    expect(record.fxmPongAt).toBeDefined()
    expect((record.fxmFirstRender ?? 0) - (record.ready ?? 0)).toBeLessThan(600)
    expect(record.fxmFirstRender ?? 0).toBeLessThan(record.fxmPongAt ?? 0)
  })

  test('Home never offers the install while FXM Connect answers late', async ({ page }) => {
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
    await stubNetwork(page, network)
    await watchShell(page)
    await installFakeConnect(page, { pongDelayMs: 1500 })

    await page.goto('./')

    // A first visit with FXM Connect: Home asks what the user likes, once the tier is known.
    await expect(page.getByRole('heading', { name: 'What do you like to listen to?' })).toBeVisible(
      { timeout: 15_000 },
    )
    expect(await page.evaluate(() => (window as unknown as PageRecord).fxmPongAt)).toBeDefined()
    // Meanwhile it showed a placeholder, never the Free tier's install pitch.
    expect(await page.evaluate(() => (window as unknown as PageRecord).fxmSawInstallPitch)).toBe(
      false,
    )
  })
})

test.describe('the Free tier (no FXM Connect)', () => {
  // A phone, where FXM Connect can't always help, and the source chips scroll sideways.
  test.use({ viewport: { width: 375, height: 667 } })

  test('plays Internet Archive tracks, then the next one', async ({ page }) => {
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
    await stubNetwork(page, network)
    await trackMediaElements(page)

    await page.goto('search?q=nine%20inch%20nails%20ghosts')
    // YouTube Music needs FXM Connect here, so the page says so, and offers the free sources
    // right there, on the screen without scrolling sideways.
    await expect(page.getByText('Search needs YouTube Music access')).toBeVisible()
    const instead = page.getByRole('button', { name: 'Search Internet Archive instead' })
    await expect(instead).toBeInViewport()
    const box = await instead.boundingBox()
    expect(box?.x).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375)
    await instead.click()
    const songs = page.getByRole('list', { name: 'Songs' })
    await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible()
    const [first, second] = await titles(page, 'Songs')

    await songs
      .getByRole('button', { name: /^Play / })
      .first()
      .click()
    const firstUrl = await waitUntilPlaying(page, first, 'archive.org')

    // The next one, when the first ends by itself.
    const secondUrl = await waitUntilPlaying(page, second, 'archive.org')
    expect(secondUrl.pathname).not.toBe(firstUrl.pathname)
    // This page can't reach YouTube, so it never tried.
    expect(network.requests.filter((request) => /youtube|googlevideo/u.test(request.url))).toEqual(
      [],
    )
  })
})

test.describe('the Lite tier (no FXM Connect, the sandbox documents)', () => {
  test('searches YouTube Music through the sandbox, plays a song, then the next one', async ({
    page,
  }) => {
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
    await stubNetwork(page, network)
    await serveSandbox(page)
    await trackMediaElements(page)

    await page.goto('search?q=radiohead%20creep')
    const songs = page.getByRole('list', { name: 'Songs' })
    await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible({
      timeout: 15_000,
    })
    const [first, second] = await titles(page, 'Songs')

    await songs
      .getByRole('button', { name: /^Play / })
      .first()
      .click()

    const googlevideo = 'rr1---sn-fxmfixture.googlevideo.com'
    const firstUrl = await waitUntilPlaying(page, first, googlevideo)
    // Every InnerTube call went through the sandbox document, from its opaque origin.
    const innerTube = network.requests.filter((request) => request.url.includes('/youtubei/v1/'))
    expect(innerTube).not.toHaveLength(0)
    expect(innerTube.map((request) => request.headers.origin)).toEqual(innerTube.map(() => 'null'))
    // googlevideo's bytes can't be read here, so nothing probed them: the media element's first
    // request is the probe.
    const probes = network.requests.filter((request) =>
      /^bytes=\d+-\d+$/u.test(request.headers.range ?? ''),
    )
    expect(probes).toEqual([])

    // Next, from the player bar.
    await page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Next' }).click()
    const secondUrl = await waitUntilPlaying(page, second, googlevideo)
    expect(secondUrl.searchParams.get('id')).not.toBe(firstUrl.searchParams.get('id'))
  })

  test('Home waits for a slow Lite check instead of offering the install', async ({ page }) => {
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
    // InnerTube answers after 2 s, so the Lite self-test takes that long.
    await stubNetwork(page, network, {
      delay: (request) => (request.url().includes('/youtubei/v1/') ? 2000 : 0),
    })
    await serveSandbox(page)
    await watchShell(page)

    await page.goto('./')

    // Lite passed: Home asks what the user likes, as it does where YouTube Music answers.
    await expect(page.getByRole('heading', { name: 'What do you like to listen to?' })).toBeVisible(
      { timeout: 20_000 },
    )
    // Meanwhile it showed a placeholder, never the Free tier's install pitch.
    expect(await page.evaluate(() => (window as unknown as PageRecord).fxmSawInstallPitch)).toBe(
      false,
    )
  })
})

test.describe('the current song in track lists', () => {
  test('marks the album’s song that plays, and follows the player', async ({ page }) => {
    // Long enough that no song ends by itself during the test.
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(120) })
    await stubNetwork(page, network)
    await trackMediaElements(page)

    // Internet Archive's recorded album, which the Free tier reaches without FXM Connect.
    await page.goto('album/archive:nineinchnails_ghosts_I_IV')
    const tracks = page.getByRole('list', { name: 'Tracks' })
    const rows = tracks.getByRole('listitem')
    await expect(rows).toHaveCount(3)
    const [, second] = await titles(page, 'Tracks')
    const current = tracks.locator('li[aria-current="true"]')
    await expect(current).toHaveCount(0)

    await rows
      .nth(1)
      .getByRole('button', { name: /^Play / })
      .click()
    await waitUntilPlaying(page, second, 'archive.org')

    await expect(current).toHaveCount(1)
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true')
    await expect(rows.nth(1).getByRole('button', { name: /^Play / })).toHaveAccessibleName(
      /\. Now playing$/,
    )
    await expect(rows.nth(1).locator('svg[data-now-playing]')).toHaveAttribute(
      'data-now-playing',
      'playing',
    )
    // The bars move: Chromium runs an animation on each of them. Not with reduced motion.
    const bars = rows.nth(1).locator('svg[data-now-playing]')
    const animations = () =>
      bars.locator('rect').evaluateAll((rects) => rects.map((rect) => rect.getAnimations().length))
    await expect.poll(animations).toEqual([1, 1, 1, 1])
    // Each in its own time, not in step.
    const delays = await bars
      .locator('rect')
      .evaluateAll((rects) => rects.map((rect) => getComputedStyle(rect).animationDelay))
    expect(new Set(delays).size).toBe(4)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(animations).toEqual([0, 0, 0, 0])
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect.poll(animations).toEqual([1, 1, 1, 1])
    // In forced colours they take the system's text colour, never its background's.
    await page.emulateMedia({ forcedColors: 'active' })
    const colours = await bars.evaluate((svg) => ({
      bars: getComputedStyle(svg).fill,
      canvas: getComputedStyle(document.body).backgroundColor,
    }))
    expect(colours.bars).not.toBe(colours.canvas)
    await page.emulateMedia({ forcedColors: 'none' })

    // Paused from the player bar: still marked, with still bars.
    const player = page.getByRole('region', { name: 'Player' })
    await player.getByRole('button', { name: 'Pause' }).click()
    await expect(rows.nth(1).getByRole('button', { name: /^Play / })).toHaveAccessibleName(
      /\. Paused$/,
    )
    await expect(rows.nth(1).locator('svg[data-now-playing]')).toHaveAttribute(
      'data-now-playing',
      'paused',
    )

    // Next, from the player bar: the marker moves with it.
    await player.getByRole('button', { name: 'Next' }).click()
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true')
    await expect(current).toHaveCount(1)
    await player.getByRole('button', { name: 'Play', exact: true }).click()
    await expect(rows.nth(2).getByRole('button', { name: /^Play / })).toHaveAccessibleName(
      /\. Now playing$/,
    )
  })
})
