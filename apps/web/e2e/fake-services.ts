import { readFileSync } from 'node:fs'
import { type Page, type Request, test } from '@playwright/test'
import type { FakeNetwork, FakeNetworkFixtures } from '../src/app/services/testing/fake-network'

// What the browser tests of the app's real composition (src/app/services) share: the providers'
// recorded fixtures, a network stub that answers every request leaving the app's origin from the
// fake network (src/app/services/testing/fake-network.ts), and a fake FXM Connect. Nothing
// reaches the internet.

/** A provider fixture, read from its package (`packages/sources/src/…`). */
export function fixture(path: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../packages/sources/src/${path}`, import.meta.url), 'utf8'),
  )
}

/** The recorded answers: a songs search, a VISIONOS `/player`, an Internet Archive search and item. */
export const FIXTURES: FakeNetworkFixtures = {
  songs: fixture('youtube/fixtures/search-songs.json'),
  player: fixture('youtube/stream/fixtures/visionos-song.json'),
  archiveSearch: fixture('archive/fixtures/search-nin-ghosts.json'),
  archiveItems: { nineinchnails_ghosts_I_IV: fixture('archive/fixtures/item-nin-ghosts.json') },
}

/** Radiohead's YouTube Music channel, whose artist page `artist-radiohead.json` is. */
export const RADIOHEAD_CHANNEL = 'UCr_iyUANcn9OX_yy9piYoLw'

/** The bundled YouTube config's search filters (`params`), as InnerTube's search gets them. */
const SEARCH_FILTERS = (
  fixture('youtube/youtube-config.json') as { search: { music: { artists: string } } }
).search.music

/**
 * {@link FIXTURES} plus what Home's recommendations ask for (the composition root's Vitest
 * fixtures, src/app/services/testing/fixtures.ts): an artists search, Creep's radio and
 * Radiohead's, Radiohead's artist page, and ListenBrainz's lookup of Creep and Radiohead's
 * similar artists.
 */
export const HOME_FIXTURES: FakeNetworkFixtures = {
  ...FIXTURES,
  searches: { [SEARCH_FILTERS.artists]: fixture('youtube/fixtures/search-artists.json') },
  radio: fixture('youtube/fixtures/radio-creep.json'),
  artistRadio: fixture('youtube/fixtures/radio-artist.json'),
  browse: { [RADIOHEAD_CHANNEL]: fixture('youtube/fixtures/artist-radiohead.json') },
  listenbrainz: {
    'acr-lookup/json': fixture('listenbrainz/fixtures/acr-lookup-radiohead-creep.json'),
    'similar-artists/json': fixture('listenbrainz/fixtures/similar-artists-radiohead.json'),
  },
}

/** Options for {@link stubNetwork}. */
export interface StubOptions {
  /**
   * Requests left unanswered, like a connection that stalls: a test that needs a download to
   * stay where it is holds its transfer.
   */
  readonly hold?: (request: Request) => boolean
  /** How long to wait before answering a request, in milliseconds: a slow host. Default: none. */
  readonly delay?: (request: Request) => number
  /** Other origins of this machine that the test serves itself, such as a page that embeds FXM. */
  readonly local?: readonly string[]
}

/** Answers every request that leaves the app's own origin (and `local`) from `network`. */
export async function stubNetwork(
  page: Page,
  network: FakeNetwork,
  { hold, delay, local = [] }: StubOptions = {},
): Promise<void> {
  const app = new URL(test.info().project.use.baseURL ?? 'http://localhost/')
  await page.route(
    (url) => url.origin !== app.origin && !local.includes(url.origin),
    async (route) => {
      const request = route.request()
      if (hold?.(request) === true) return
      const wait = delay?.(request) ?? 0
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
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
 * Makes InnerTube refuse the Lite tier's sandbox document (its opaque origin, `Origin: null`)
 * with a 403 and no CORS headers, as YouTube answers origins it doesn't serve: Lite's self-test
 * fails, so a page without FXM Connect gets the Free tier, also where the server serves the
 * sandbox document (`make dist`). Calls from the page itself, through FXM Connect, still reach
 * the stub. Call it after {@link stubNetwork}: routes run newest first.
 */
export async function refuseLite(page: Page): Promise<void> {
  await page.route(/^https:\/\/(?:www|music)\.youtube\.com\/youtubei\/v1\//u, (route) =>
    route.request().headers().origin === 'null'
      ? route.fulfill({ status: 403, body: '' })
      : route.fallback(),
  )
}

/** What {@link installFakeConnect} records on the page, read with `page.evaluate`. */
export interface ConnectRecord {
  /** When the fake FXM Connect answered the ping first, as `performance.now()`. */
  fxmPongAt?: number
}

/**
 * Makes the page find FXM Connect, as its content script does: the marker on `<html>` and an
 * answer to the ping (the protocol of apps/extension/src/messages.ts), `pongDelayMs` after it,
 * like a service worker waking up. The network stub stands in for the extension's header rules.
 */
export async function installFakeConnect(page: Page, { pongDelayMs = 0 } = {}): Promise<void> {
  await page.addInitScript((delayMs: number) => {
    const record = window as unknown as ConnectRecord
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
