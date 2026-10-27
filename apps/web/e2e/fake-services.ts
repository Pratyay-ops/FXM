import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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

/** Options for {@link stubNetwork}. */
export interface StubOptions {
  /**
   * Requests left unanswered, like a connection that stalls: a test that needs a download to
   * stay where it is holds its transfer.
   */
  readonly hold?: (request: Request) => boolean
  /** How long to wait before answering a request, in milliseconds: a slow host. Default: none. */
  readonly delay?: (request: Request) => number
}

/** Answers every request that leaves the app's own origin from `network`. */
export async function stubNetwork(
  page: Page,
  network: FakeNetwork,
  { hold, delay }: StubOptions = {},
): Promise<void> {
  const app = new URL(test.info().project.use.baseURL ?? 'http://localhost/')
  await page.route(
    // This machine's other servers (a redirect target, `startRedirectTarget`) answer themselves.
    (url) => url.origin !== app.origin && url.hostname !== '127.0.0.1',
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

/** A local server that stands in for the googlevideo host a redirect sends a request to. */
export interface RedirectTarget {
  /** Its origin, e.g. `http://127.0.0.1:53124`: the fake network's `googlevideoRedirectTo`. */
  readonly origin: string
  /** How many requests it answered. */
  readonly requests: () => number
  close(): Promise<void>
}

/**
 * Starts the host googlevideo's cms_redirect sends media requests to, on this machine: the browser
 * follows a redirect itself, so the test can't answer the request after it the way the network
 * stub answers the others. It serves `audio` (with single ranges) with
 * `Access-Control-Allow-Origin: allowOrigin`: the exact FXM origin, as FXM Connect 0.2.0 sends
 * it, which the `Origin: null` the browser sends after the redirect doesn't match; or `*`, as
 * from 0.2.1 on.
 */
export async function startRedirectTarget(
  audio: Uint8Array,
  allowOrigin: string,
): Promise<RedirectTarget> {
  let count = 0
  const server = createServer((request, response) => {
    count += 1
    const headers: Record<string, string> = {
      'access-control-allow-origin': allowOrigin,
      'access-control-expose-headers': 'content-length, content-range, accept-ranges',
      'accept-ranges': 'bytes',
      'content-type': 'audio/wav',
    }
    const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '')
    if (range === null) {
      response.writeHead(200, { ...headers, 'content-length': String(audio.length) })
      response.end(Buffer.from(audio))
      return
    }
    const first = Math.min(Number(range[1]), audio.length - 1)
    const last = Math.min(range[2] ? Number(range[2]) : audio.length - 1, audio.length - 1)
    response.writeHead(206, {
      ...headers,
      'content-length': String(last - first + 1),
      'content-range': `bytes ${first}-${last}/${audio.length}`,
    })
    response.end(Buffer.from(audio.subarray(first, last + 1)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
