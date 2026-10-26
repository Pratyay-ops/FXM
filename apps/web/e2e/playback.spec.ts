import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import {
  createFakeNetwork,
  type FakeNetwork,
  type FakeNetworkFixtures,
  wavTone,
} from '../src/app/services/testing/fake-network'

// Search, play and the next track in a real browser, through the app's real composition
// (src/app/services): platform, providers, stream lifecycle, player and <audio>. Only the network
// is fake: every request that leaves the page is answered from the providers' recorded fixtures
// (src/app/services/testing/fake-network.ts), and the streams are short WAV tones that the page
// really plays. Nothing reaches the internet.
//
// The Lite tier needs the sandbox documents of stage 1.10, which are not in this build yet; the
// Vitest tests in src/app/services cover it with a fake sandbox meanwhile. The shell never waits
// for the services: with an FXM Connect that answers late, it paints at once and says it is
// connecting, rather than offering the install.

/** A provider fixture, read from its package (`packages/sources/src/…`). */
function fixture(path: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../packages/sources/src/${path}`, import.meta.url), 'utf8'),
  )
}

const FIXTURES: FakeNetworkFixtures = {
  songs: fixture('youtube/fixtures/search-songs.json'),
  player: fixture('youtube/stream/fixtures/visionos-song.json'),
  archiveSearch: fixture('archive/fixtures/search-nin-ghosts.json'),
  archiveItems: { nineinchnails_ghosts_I_IV: fixture('archive/fixtures/item-nin-ghosts.json') },
}

/** Each stream plays this long, so a track ends by itself within the test. */
const TRACK_SECONDS = 1.5

/** Answers every request that leaves the app's own origin from `network`. */
async function stubNetwork(page: Page, network: FakeNetwork): Promise<void> {
  const app = new URL(test.info().project.use.baseURL ?? 'http://localhost/')
  await page.route(
    (url) => url.origin !== app.origin,
    async (route) => {
      const request = route.request()
      const body = request.postData()
      let response: Response
      try {
        response = network.respond({
          method: request.method(),
          url: request.url(),
          headers: request.headers(),
          ...(body === null ? {} : { body }),
        })
      } catch {
        await route.abort('connectionrefused')
        return
      }
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      })
    },
  )
}

/** What the page's init scripts record, read with `page.evaluate`. */
interface PageRecord {
  fxmMedia: Set<HTMLMediaElement>
  /** When `#root` first got content, as `performance.now()`. */
  fxmFirstRender?: number
  /** Whether the install pitch ("Get FXM Connect") ever showed. */
  fxmSawInstallPitch?: boolean
  /** When the fake FXM Connect answered the ping first, as `performance.now()`. */
  fxmPongAt?: number
}

/**
 * Makes the page find FXM Connect, as its content script does: the marker on `<html>` and an
 * answer to the ping (the protocol of apps/extension/src/messages.ts), `pongDelayMs` after it,
 * like a service worker waking up. The network stub stands in for the extension's header rules.
 */
async function installFakeConnect(page: Page, { pongDelayMs = 0 } = {}): Promise<void> {
  await page.addInitScript((delayMs: number) => {
    const record = window as unknown as PageRecord
    const mark = () => document.documentElement?.setAttribute('data-fxm-connect', '0.1.0')
    // The content script runs at document_start, when <html> exists. Playwright runs init
    // scripts a moment earlier, so mark <html> as soon as the parser creates it, before any of
    // the page's scripts run.
    if (document.documentElement) mark()
    else {
      new MutationObserver((_, observer) => {
        if (!document.documentElement) return
        mark()
        observer.disconnect()
      }).observe(document, { childList: true })
    }
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      if (event.data?.type !== 'fxm-connect:ping') return
      setTimeout(() => {
        record.fxmPongAt ??= performance.now()
        window.postMessage(
          {
            type: 'fxm-connect:pong',
            version: '0.1.0',
            features: ['youtube', 'googlevideo', 'spotify', 'lastfm', 'spotify-server-time'],
          },
          window.location.origin,
        )
      }, delayMs)
    })
  }, pongDelayMs)
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
