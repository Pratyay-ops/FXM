import { expect, type Page, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../src/app/services/testing/fake-network'
import {
  type ConnectRecord,
  FIXTURES,
  installFakeConnect,
  refuseLite,
  stubNetwork,
} from './fake-services'
import {
  type MediaRecord,
  serveSandbox,
  titles,
  trackMediaElements,
  waitUntilPlaying,
} from './playing'

// Search, play and the next track in a real browser, through the app's real composition
// (src/app/services): platform, providers, stream lifecycle, player and <audio>. Only the network
// is fake: every request that leaves the page is answered from the providers' recorded fixtures
// (src/app/services/testing/fake-network.ts), and the streams are short WAV tones that the page
// really plays. Nothing reaches the internet.
//
// The Lite tier runs the real sandbox document of stage 1.10 (apps/web/sandbox/innertube.html),
// which the deploy serves at /sandbox/ and `vite preview` doesn't, so its test serves it there.
// The shell never waits for the services: with an FXM Connect that answers late, it paints at once
// and says it is connecting, rather than offering the install.
//
// These are critical flows (tagged @flow), so they also run against `make dist` served like
// Cloudflare Pages (e2e/flows/), where the deployed sandbox document comes with its own policy.

/** Each stream plays this long, so a track ends by itself within the test. */
const TRACK_SECONDS = 1.5

/** What the page's init scripts record, read with `page.evaluate`. */
interface PageRecord extends ConnectRecord, MediaRecord {
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

test.describe('the Full tier (FXM Connect)', { tag: '@flow' }, () => {
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

    // A first visit with FXM Connect: Home asks what the user likes, once the tier is known. Where
    // the server serves the sandbox document (make dist), Lite's check may pass first, and Home
    // asks the same then.
    await expect(page.getByRole('heading', { name: 'What do you like to listen to?' })).toBeVisible(
      { timeout: 15_000 },
    )
    await expect
      .poll(() => page.evaluate(() => (window as unknown as PageRecord).fxmPongAt))
      .toBeDefined()
    // Meanwhile it showed a placeholder, never an install pitch.
    expect(await page.evaluate(() => (window as unknown as PageRecord).fxmSawInstallPitch)).toBe(
      false,
    )
  })
})

test.describe('the Free tier (no FXM Connect)', { tag: '@flow' }, () => {
  // A phone, where FXM Connect can't always help, and the source chips scroll sideways.
  test.use({ viewport: { width: 375, height: 667 } })

  test('plays Internet Archive tracks, then the next one', async ({ page }) => {
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
    await stubNetwork(page, network)
    // Lite's check fails here, as where YouTube doesn't answer the sandbox document.
    await refuseLite(page)
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
    // This page can't reach YouTube, so beyond Lite's check, which YouTube refused, it never tried.
    expect(network.requests.filter((request) => /youtube|googlevideo/u.test(request.url))).toEqual(
      [],
    )
  })
})

test.describe('the Lite tier (no FXM Connect, the sandbox documents)', { tag: '@flow' }, () => {
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
