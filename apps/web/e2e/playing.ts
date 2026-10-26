import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { SERVES_SANDBOX } from './target'

// What the browser tests of playback share: the Lite tier's sandbox document where the server
// doesn't serve it, and a look at the media elements the page plays. Playback is proven by the
// elements' events and position, never by sound: Chromium runs with --mute-audio, and every
// element the page plays is muted as well.

/** The Lite tier's sandbox document, as the deploy serves it at `/sandbox/innertube.html`. */
const SANDBOX_DOCUMENT = readFileSync(new URL('../sandbox/innertube.html', import.meta.url), 'utf8')

/**
 * Serves the sandbox document as the deploy does, with its header, where the server doesn't
 * (`vite preview`; make dist's own copy comes with its full policy): a page without FXM Connect
 * then runs the Lite self-test and, with InnerTube answering its opaque origin (the fake network
 * allows every origin), gets the Lite tier.
 */
export async function serveSandbox(page: Page): Promise<void> {
  if (SERVES_SANDBOX) return
  await page.route('**/sandbox/innertube.html', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'content-security-policy': 'sandbox allow-scripts' },
      body: SANDBOX_DOCUMENT,
    }),
  )
}

/** A media element {@link trackMediaElements} keeps, with the events it fired, in order. */
export type TrackedMedia = HTMLMediaElement & { fxmEvents: string[] }

/** What {@link trackMediaElements} keeps on the page, read with `page.evaluate`. */
export interface MediaRecord {
  fxmMedia: Set<TrackedMedia>
}

/**
 * Keeps a reference to every media element the page plays, muted, with the media events it
 * fires (`playing`, `pause`, `seeked`, `ended`, `error`): the player's `<audio>` elements are
 * never attached to the document, so they can't be found in it.
 */
export async function trackMediaElements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const played = new Set<TrackedMedia>()
    ;(window as unknown as MediaRecord).fxmMedia = played
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      // Never a sound, even in a browser started without --mute-audio.
      this.muted = true
      const media = this as TrackedMedia
      if (!played.has(media)) {
        media.fxmEvents = []
        for (const type of ['playing', 'pause', 'seeked', 'ended', 'error']) {
          media.addEventListener(type, () => media.fxmEvents.push(type))
        }
        played.add(media)
      }
      return play.call(this)
    }
  })
}

/** What the page plays right now. */
export interface NowPlaying {
  /** The title in the system media controls (Media Session). */
  readonly title: string | null
  /**
   * The URL a media element is playing: one that fired `playing`, isn't paused and has really
   * played some of it (its `played` ranges, which only playback adds to). Else `null`.
   */
  readonly url: string | null
  /** That element's position, in seconds, else `null`. */
  readonly currentTime: number | null
}

/** What the page plays: see {@link NowPlaying}. */
export function nowPlaying(page: Page): Promise<NowPlaying> {
  return page.evaluate(() => {
    const played = (window as unknown as MediaRecord).fxmMedia
    const seconds = (ranges: TimeRanges) => {
      let total = 0
      for (let index = 0; index < ranges.length; index += 1) {
        total += ranges.end(index) - ranges.start(index)
      }
      return total
    }
    const playing = [...played].find(
      (media) =>
        media.fxmEvents.includes('playing') &&
        !media.paused &&
        media.currentTime > 0 &&
        seconds(media.played) > 0,
    )
    return {
      title: navigator.mediaSession.metadata?.title ?? null,
      url: playing?.currentSrc ?? null,
      currentTime: playing?.currentTime ?? null,
    }
  })
}

/** Waits until the page plays `title` from `host` (see {@link NowPlaying}), and returns the URL. */
export async function waitUntilPlaying(
  page: Page,
  title: string | undefined,
  host: string,
  timeout = 10_000,
): Promise<URL> {
  let url = ''
  await expect
    .poll(
      async () => {
        const now = await nowPlaying(page)
        url = now.url ?? ''
        return { title: now.title, host: now.url === null ? null : new URL(now.url).hostname }
      },
      { timeout },
    )
    .toEqual({ title, host })
  return new URL(url)
}

/**
 * The titles of the songs a list of results or a shelf shows, in order, from their play buttons'
 * labels ("Play <title> by <artists>"; a title may have " by " in it too).
 */
export async function titles(page: Page, list: string): Promise<string[]> {
  const labels = await page
    .getByRole('list', { name: list })
    .getByRole('button', { name: /^Play / })
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''))
  return labels.map((label) => {
    const title = label.replace(/^Play /u, '')
    const by = title.lastIndexOf(' by ')
    return by === -1 ? title : title.slice(0, by)
  })
}

/** The songs a library list shows, in order, from their menus' labels ("More options for …"). */
export function listed(page: Page, list: string): Promise<string[]> {
  return page
    .getByRole('list', { name: list })
    .getByRole('button', { name: /^More options for / })
    .evaluateAll((buttons) =>
      buttons.map(
        (button) => button.getAttribute('aria-label')?.replace('More options for ', '') ?? '',
      ),
    )
}
