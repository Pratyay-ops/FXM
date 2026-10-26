/**
 * The live check behind the site's `AVAILABLE.radio` (stage 3.4, endless autoplay): in a browser
 * without FXM Connect, in the Lite tier, a song played from the end of a search's results leaves
 * nothing up next, autoplay adds songs like it, marked "Autoplay" in the queue, and the first of
 * them plays, from its radio ("Playing from Autoplay"). It reaches YouTube for real, so it runs
 * only with FXM_LIVE=1, from a residential connection (YouTube meets datacenter addresses with
 * bot checks), against FXM_DEPLOY_URL or, without it, `make dist`'s folder served the way
 * Cloudflare Pages would (`playwright.config.ts`). It stays within 15 YouTube requests:
 * thumbnails are answered here, the `player` requests of the songs the app prefetches after the
 * first autoplay song are refused before they reach YouTube, and every other request counts, so
 * that one past the budget is refused and fails the check. Media elements are muted, and the
 * deploy README says how to run it.
 */
import { expect, type Page, test } from '@playwright/test'

const live = process.env.FXM_LIVE === '1'
const QUERY = 'Blitzkrieg Bop Ramones'
const YOUTUBE_API = /^https:\/\/(www\.youtube\.com|music\.youtube\.com|youtubei\.googleapis\.com)\//
const GOOGLEVIDEO = /^https:\/\/[^/]+\.googlevideo\.com\//
const IMAGES = /^https:\/\/([^/]+\.)?(ytimg\.com|ggpht\.com|googleusercontent\.com)\//
const BUDGET = 15
/**
 * The `player` requests that may reach YouTube: the song the check plays, and the first song
 * autoplay added, which the app prefetches or asks for when it plays.
 */
const PLAYERS = 2
/** A 1×1 PNG for the thumbnails, which would cost a request each. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** What the page's playing media element reports, or `null` while nothing plays. */
interface Playing {
  readonly currentTime: number
  readonly muted: boolean
  readonly host: string
  readonly title: string | null
}

interface PageRecord {
  fxmMedia: Set<HTMLMediaElement>
}

test.skip(!live, 'a live check: set FXM_LIVE=1, from a residential connection')
// Silent: the browser plays to no audio device, and every media element is muted as well.
test.use({ serviceWorkers: 'block', launchOptions: { args: ['--mute-audio'] } })
// Each run costs YouTube requests from the owner's connection: never again on its own.
test.describe.configure({ retries: 0 })

/** The media element playing now, if one is. */
function playing(page: Page): Promise<Playing | null> {
  return page.evaluate((): Playing | null => {
    const media = [...(window as unknown as PageRecord).fxmMedia].find(
      (element) => !element.paused && element.currentTime > 0,
    )
    return media === undefined
      ? null
      : {
          currentTime: media.currentTime,
          muted: media.muted,
          host: new URL(media.currentSrc).host,
          title: navigator.mediaSession.metadata?.title ?? null,
        }
  })
}

test('autoplay keeps a Lite queue going with songs like the last one', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(180_000)
  /** Every YouTube request the page made, but the refused prefetches: at most BUDGET. */
  const attempted: string[] = []
  /** `player` requests for the songs the app prefetches, refused before they reach YouTube. */
  const prefetches: string[] = []
  let players = 0
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (IMAGES.test(url.href)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
    }
    if (YOUTUBE_API.test(url.href) || GOOGLEVIDEO.test(url.href)) {
      const request = `${route.request().method()} ${url.host}${url.pathname}`
      if (YOUTUBE_API.test(url.href) && url.pathname.endsWith('/player')) {
        players += 1
        // The song the check plays and autoplay's first; the prefetches of the next ones stay here.
        if (players > PLAYERS) {
          prefetches.push(request)
          return route.abort('blockedbyclient')
        }
      }
      attempted.push(request)
      // Past the budget: refused, and the check fails below.
      if (attempted.length > BUDGET) return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  // The player's <audio> elements are never in the document: keep each one, muted.
  await page.addInitScript(() => {
    const played = new Set<HTMLMediaElement>()
    ;(window as unknown as PageRecord).fxmMedia = played
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      this.muted = true
      played.add(this)
      return play.call(this)
    }
  })
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
  })

  await page.goto(`/app/search?q=${encodeURIComponent(QUERY)}`)
  const songs = page.getByRole('list', { name: 'Songs' })
  const plays = songs.getByRole('button', { name: /^Play / })
  await expect(plays.first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText("This browser passed Lite's check.", { exact: false })).toBeVisible()

  // The last result: the queue holds the results, so nothing follows it and the queue is low.
  await plays.last().click()
  await expect.poll(() => playing(page), { timeout: 60_000 }).not.toBeNull()
  const seed = await playing(page)
  if (seed === null) throw new Error('The song stopped right after it started to play')

  // The queue, through the player bar: a route change, no reload.
  await page.getByRole('link', { name: 'Queue' }).click()
  const nextUp = page.getByRole('region', { name: 'Next up' })
  const added = nextUp.getByRole('listitem').filter({ hasText: 'Autoplay' })
  // It waits 1.5 s for the queue to settle, then has 8 s for the radio (EXTENSION_DEADLINE_MS).
  await expect(added).toHaveCount(4, { timeout: 30_000 })
  await expect(nextUp.getByRole('switch', { name: 'Autoplay' })).toBeChecked()
  // Each row's handle is "Move <title>".
  const titles = await added
    .getByRole('button', { name: /^Move / })
    .evaluateAll((handles) =>
      handles.map((handle) => handle.getAttribute('aria-label')?.replace(/^Move /, '') ?? ''),
    )

  // The first song autoplay added plays, from its radio.
  await page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Next' }).click()
  await expect(nextUp.getByText('Playing from Autoplay')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => (await playing(page))?.title ?? null, { timeout: 60_000 })
    .toBe(titles[0])
  const first = await playing(page)
  if (first === null) throw new Error('The song autoplay added stopped right after it started')
  await page.waitForTimeout(6_000)
  const last = await playing(page)
  if (last === null) throw new Error('The song autoplay added stopped playing within 6 s')
  expect(last.muted).toBe(true)
  expect(last.host).toMatch(/\.googlevideo\.com$/)
  expect(last.currentTime - first.currentTime).toBeGreaterThanOrEqual(5)

  expect(attempted.length, `YouTube requests: ${attempted.join(', ')}`).toBeLessThanOrEqual(BUDGET)
  expect(violations).toEqual([])
  test.info().annotations.push({
    type: 'result',
    description: `${browser.browserType().name()} ${browser.version()}: after ${seed.title}, autoplay added ${titles.join(', ')}; ${last.title} played from ${last.host}, ${(last.currentTime - first.currentTime).toFixed(1)} s, in ${attempted.length} YouTube requests (${attempted.join(', ')}); ${prefetches.length} prefetch(es) refused`,
  })
})
