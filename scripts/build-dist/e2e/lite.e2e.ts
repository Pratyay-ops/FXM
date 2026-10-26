/**
 * The live check behind the site's `AVAILABLE.lite` (docs/PLAN.md, 2.8: "Without FXM Connect,
 * Lite plays one in Chromium"): on a deployment, in a browser without FXM Connect, the Lite
 * self-test passes, a YouTube Music search returns songs, and a song plays, its `currentTime`
 * advancing for at least 10 s. It reaches YouTube for real, so it runs only with FXM_LIVE=1 and
 * FXM_DEPLOY_URL, from a residential connection (YouTube meets datacenter addresses with bot
 * checks), and stays within 10 YouTube requests: thumbnails are answered here, the streams of
 * songs the app prefetches are refused here, and anything past the budget fails the check.
 * Media elements are muted, and the deploy README says how to run it.
 */
import { expect, test } from '@playwright/test'

const live = process.env.FXM_LIVE === '1' && Boolean(process.env.FXM_DEPLOY_URL)
const QUERY = 'Blitzkrieg Bop Ramones'
const YOUTUBE_API = /^https:\/\/(www\.youtube\.com|music\.youtube\.com|youtubei\.googleapis\.com)\//
const GOOGLEVIDEO = /^https:\/\/[^/]+\.googlevideo\.com\//
const IMAGES = /^https:\/\/([^/]+\.)?(ytimg\.com|ggpht\.com|googleusercontent\.com)\//
const BUDGET = 10
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

test.skip(!live, 'a live check: set FXM_LIVE=1 and FXM_DEPLOY_URL, from a residential connection')
// Silent: the browser plays to no audio device, and every media element is muted as well.
test.use({ serviceWorkers: 'block', launchOptions: { args: ['--mute-audio'] } })
// Each run costs YouTube requests from the owner's connection: never again on its own.
test.describe.configure({ retries: 0 })

test('Lite searches YouTube Music and plays a song without FXM Connect', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(120_000)
  const youtube: string[] = []
  let players = 0
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (IMAGES.test(url.href)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
    }
    if (YOUTUBE_API.test(url.href) || GOOGLEVIDEO.test(url.href)) {
      if (YOUTUBE_API.test(url.href) && url.pathname.endsWith('/player')) {
        players += 1
        // The song the check plays; the lifecycle's prefetches of the next ones stay here.
        if (players > 1) return route.abort('blockedbyclient')
      }
      if (youtube.length >= BUDGET) return route.abort('blockedbyclient')
      youtube.push(`${route.request().method()} ${url.host}${url.pathname}`)
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
  await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible({
    timeout: 60_000,
  })
  expect(await songs.getByRole('button', { name: /^Play / }).count()).toBeGreaterThan(0)
  await expect(page.getByText("This browser passed Lite's check.", { exact: false })).toBeVisible()

  await songs
    .getByRole('button', { name: /^Play / })
    .first()
    .click()
  const playing = () =>
    page.evaluate((): Playing | null => {
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
  await expect.poll(playing, { timeout: 60_000 }).not.toBeNull()
  const first = (await playing()) as Playing
  await page.waitForTimeout(11_000)
  const last = (await playing()) as Playing
  expect(last.muted).toBe(true)
  expect(last.host).toMatch(/\.googlevideo\.com$/)
  expect(last.currentTime - first.currentTime).toBeGreaterThanOrEqual(10)

  // The self-test's verdict, on Settings → Diagnostics: a route change, no new request.
  await page.getByRole('link', { name: 'Settings' }).first().click()
  const diagnostics = page
    .getByRole('heading', { level: 2, name: 'Diagnostics' })
    .locator('xpath=ancestor::section[1]')
  await expect(diagnostics.getByText('Check passed', { exact: true })).toBeVisible({
    timeout: 30_000,
  })

  expect(youtube.length).toBeLessThanOrEqual(BUDGET)
  expect(violations).toEqual([])
  test.info().annotations.push({
    type: 'result',
    description: `${browser.browserType().name()} ${browser.version()}: played ${last.title} from ${last.host}, ${(last.currentTime - first.currentTime).toFixed(1)} s in ${youtube.length} YouTube requests (${youtube.join(', ')})`,
  })
})
