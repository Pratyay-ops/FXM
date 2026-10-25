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
// Vitest tests in src/app/services cover it with a fake sandbox meanwhile.

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

/**
 * Makes the page find FXM Connect, as its content script does: the marker on `<html>` and an
 * answer to the ping (the protocol of apps/extension/src/messages.ts). The network stub stands
 * in for the extension's header rules.
 */
async function installFakeConnect(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mark = () => document.documentElement?.setAttribute('data-fxm-connect', '0.1.0')
    // <html> usually exists already when an init script runs; wait for it otherwise.
    if (document.documentElement) mark()
    else document.addEventListener('DOMContentLoaded', mark, { once: true })
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      if (event.data?.type !== 'fxm-connect:ping') return
      window.postMessage(
        {
          type: 'fxm-connect:pong',
          version: '0.1.0',
          features: ['youtube', 'googlevideo', 'spotify', 'lastfm', 'spotify-server-time'],
        },
        window.location.origin,
      )
    })
  })
}

/**
 * Keeps a reference to every media element the page plays: the player's `<audio>` elements are
 * never attached to the document, so they can't be found in it.
 */
async function trackMediaElements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const played = new Set<HTMLMediaElement>()
    ;(window as unknown as { fxmMedia: Set<HTMLMediaElement> }).fxmMedia = played
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
    const played = (window as unknown as { fxmMedia: Set<HTMLMediaElement> }).fxmMedia
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
  })
})

test.describe('the Free tier (no FXM Connect)', () => {
  test('plays Internet Archive tracks, then the next one', async ({ page }) => {
    const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
    await stubNetwork(page, network)
    await trackMediaElements(page)

    await page.goto('search?q=nine%20inch%20nails%20ghosts')
    // YouTube Music needs FXM Connect here, so the page says so, and offers the free sources.
    await expect(page.getByText('Search needs YouTube Music access')).toBeVisible()
    await page.locator('label', { hasText: 'Internet Archive' }).click()
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
