import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BrowserContext,
  test as base,
  expect,
  type Page,
  type Request,
} from '@playwright/test'
import type { FakeNetwork } from '../src/app/services/testing/fake-network'

// What the phone specs (phone-*.spec.ts) share. Each runs on two phones, as playwright.config.ts
// sets them up: Chromium as a Pixel 7 and WebKit, the engine of every browser on iPhone and iPad,
// as an iPhone 15.
//
// - A browser profile and a home folder of its own, in a temporary folder. WebKit keeps nothing
//   in the Origin Private File System of the incognito-like contexts Playwright makes by default
//   (`getDirectory()` fails there, as in Safari's private windows), so downloads need a profile
//   on disk; and it keeps that file system under the home folder whatever the profile, so each
//   browser gets a home of its own. With them, a test can close the whole browser and start it
//   again on the same profile, like a phone that reopens the app. The fixture deletes the folder
//   afterwards.
// - Headless, with the service worker on: the offline app shell is what these tests are about.
// - Silent: every media element is muted, whatever the app sets, and anything Web Audio sends
//   to the speakers goes through a gain of 0. Chromium is also launched with `--mute-audio`;
//   WebKit has no such switch. The tests prove playback by media events and the position.
// - Offline but for this machine: requests that leave the app's origin are answered from the
//   test's fake network (src/app/services/testing/fake-network.ts) while the phone is online,
//   and refused once it is offline, and the Lite tier's sandbox documents are refused, so the
//   page gets the Free tier wherever it runs. Nothing reaches the internet (Chromium is also
//   launched so that no host but this machine resolves). Every request is recorded, with
//   whether the phone was offline and how it ended.

/** One request the browser made for the app, and how it ended. */
export interface SeenRequest {
  readonly url: string
  readonly method: string
  readonly resourceType: string
  /** Whether the phone was offline when the request was made. */
  readonly offline: boolean
  /**
   * How it ended:
   *
   * - `network`: a server answered (the response has a server address);
   * - `service-worker`: the service worker answered;
   * - `no-server`: answered without a server all the same, as WebKit reports the module scripts
   *   the service worker serves (it flags only some of its answers as the service worker's);
   * - `device`: a `blob:` or `data:` URL, which WebKit reports as requests too (a media element
   *   reading a stored file);
   * - `failed`, or `pending` while it isn't over.
   */
  outcome: 'pending' | 'network' | 'service-worker' | 'no-server' | 'device' | 'failed'
  /** Why it failed, when it did. */
  failure?: string
}

/** A phone with FXM open: see the module comment. */
export interface Phone {
  readonly context: BrowserContext
  /** The page FXM runs in: the profile's first tab. */
  readonly page: Page
  /** Every request so far, in order, across restarts. */
  readonly requests: readonly SeenRequest[]
  /** {@link requests}, once the outcome of every answered one is known. */
  settledRequests(): Promise<readonly SeenRequest[]>
  /** Whether the phone is offline now. */
  readonly offline: boolean
  /** Answers the requests that leave this machine from `network`, while the phone is online. */
  serve(network: FakeNetwork): void
  /** Takes the phone offline: the browser's network is off and the fake network stops answering. */
  goOffline(): Promise<void>
  /**
   * Closes the browser and starts it again on the same profile, offline from its first request
   * when `offline` (default: as it is now), and returns the new page.
   */
  restart(options?: { offline?: boolean }): Promise<Page>
}

/** What the page records about its media elements, read with {@link mediaElements}. */
interface MediaRecord {
  /** Every media element the page started, in order. */
  elements: HTMLMediaElement[]
  /** How many `playing` events each element fired. */
  playing: WeakMap<HTMLMediaElement, number>
  /** Media errors, as `code: message`. */
  errors: string[]
  /** Whether an element ever played unmuted (it must not). */
  heard: boolean
}

/** One media element's state, from {@link mediaElements}. */
export interface MediaState {
  readonly index: number
  /** What it plays (`currentSrc`). */
  readonly src: string
  readonly paused: boolean
  readonly ended: boolean
  readonly muted: boolean
  readonly currentTime: number
  readonly readyState: number
  /** How many `playing` events it fired. */
  readonly playing: number
}

/**
 * The page's init script: mutes every media element for good, records the ones the page starts
 * and their `playing` events, and sends whatever Web Audio meant for the speakers through a
 * silent gain node. The player's `<audio>` elements are never attached to the document, so the
 * record is the way to find them.
 */
function silenceAndRecordMedia() {
  const proto = HTMLMediaElement.prototype
  const muted = Object.getOwnPropertyDescriptor(proto, 'muted')
  const setMuted = muted?.set
  if (muted?.get === undefined || setMuted === undefined) throw new Error('no muted property')
  const record: MediaRecord = { elements: [], playing: new WeakMap(), errors: [], heard: false }
  Object.defineProperty(window, '__fxmMedia', { value: record })
  // The app may unmute its elements (its volume control): they stay muted.
  Object.defineProperty(proto, 'muted', {
    configurable: true,
    enumerable: muted.enumerable ?? true,
    get: muted.get,
    set(this: HTMLMediaElement) {
      setMuted.call(this, true)
    },
  })
  const play = proto.play
  proto.play = function (this: HTMLMediaElement) {
    setMuted.call(this, true)
    if (!record.elements.includes(this)) {
      record.elements.push(this)
      this.addEventListener('playing', () => {
        record.playing.set(this, (record.playing.get(this) ?? 0) + 1)
        if (!this.muted) record.heard = true
      })
      this.addEventListener('error', () => {
        record.errors.push(`${this.error?.code}: ${this.error?.message}`)
      })
    }
    return play.call(this)
  }
  // Web Audio: whatever goes to a live context's speakers goes through a gain of 0 first.
  if (typeof AudioNode === 'undefined' || typeof AudioDestinationNode === 'undefined') return
  const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown
  const disconnect = AudioNode.prototype.disconnect as (
    this: AudioNode,
    ...args: unknown[]
  ) => unknown
  const silencers = new WeakMap<AudioDestinationNode, GainNode>()
  const speakers = (target: unknown): target is AudioDestinationNode =>
    target instanceof AudioDestinationNode &&
    !(typeof OfflineAudioContext !== 'undefined' && target.context instanceof OfflineAudioContext)
  const silencer = (destination: AudioDestinationNode) => {
    let gain = silencers.get(destination)
    if (gain === undefined) {
      gain = destination.context.createGain()
      gain.gain.value = 0
      connect.call(gain, destination)
      silencers.set(destination, gain)
    }
    return gain
  }
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const [target, ...rest] = args
    if (!speakers(target)) return connect.call(this, ...args)
    connect.call(this, silencer(target), ...rest)
    return target
  } as AudioNode['connect']
  AudioNode.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
    const [target, ...rest] = args
    if (!speakers(target)) return disconnect.call(this, ...args)
    return disconnect.call(this, silencer(target), ...rest)
  } as AudioNode['disconnect']
}

/** The media elements the page started, and their state now. */
export function mediaElements(page: Page): Promise<MediaState[]> {
  return page.evaluate(() => {
    const record = (window as unknown as { __fxmMedia: MediaRecord }).__fxmMedia
    return record.elements.map((element, index) => ({
      index,
      src: element.currentSrc,
      paused: element.paused,
      ended: element.ended,
      muted: element.muted,
      currentTime: element.currentTime,
      readyState: element.readyState,
      playing: record.playing.get(element) ?? 0,
    }))
  })
}

/** Media errors the page's elements reported, and whether any element ever played unmuted. */
export function mediaProblems(page: Page): Promise<{ errors: string[]; heard: boolean }> {
  return page.evaluate(() => {
    const { errors, heard } = (window as unknown as { __fxmMedia: MediaRecord }).__fxmMedia
    return { errors: [...errors], heard }
  })
}

/** The title the page gives the system's media controls. */
export function mediaSessionTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => navigator.mediaSession.metadata?.title ?? null)
}

/** How far a song must play, in seconds of its position, for a test to count it as playing. */
export const PLAYED_SECONDS = 3

/**
 * Waits until the page plays `title` from a file on the device (a `blob:` URL): a muted media
 * element fired `playing` and is under way, and its position then moves on by
 * {@link PLAYED_SECONDS}. Returns what played, with the position before and after.
 */
export async function expectPlaysFromDevice(
  page: Page,
  title: string,
): Promise<{ src: string; from: number; to: number }> {
  let element: MediaState | undefined
  try {
    await expect
      .poll(
        async () => {
          element = (await mediaElements(page)).find(
            (media) => media.src.startsWith('blob:') && media.playing > 0 && !media.paused,
          )
          return { title: await mediaSessionTitle(page), playing: element !== undefined }
        },
        { message: `${title} plays from a blob: URL`, timeout: 20_000 },
      )
      .toEqual({ title, playing: true })
  } catch (error) {
    // What the media elements did, and what the player says.
    const media = await mediaElements(page).catch(() => [])
    const problems = await mediaProblems(page).catch(() => undefined)
    const player = await page
      .getByRole('region', { name: 'Player' })
      .innerText({ timeout: 1_000 })
      .catch(() => '')
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `media elements: ${JSON.stringify(media)}`,
        `media problems: ${JSON.stringify(problems)}`,
        `player: ${player.replace(/\s+/gu, ' ')}`,
      ].join('\n'),
    )
  }
  if (element === undefined) throw new Error('unreachable')
  const { index, currentTime: from } = element
  let to = from
  await expect
    .poll(
      async () => {
        const now = (await mediaElements(page))[index]
        to = now?.currentTime ?? to
        return { moved: to - from >= PLAYED_SECONDS, src: now?.src, paused: now?.paused }
      },
      { message: `the position moves on ${PLAYED_SECONDS} s`, timeout: 20_000 },
    )
    .toEqual({ moved: true, src: element.src, paused: false })
  // Muted all along: every element the page started is muted, and none played unmuted.
  const all = await mediaElements(page)
  expect(all.map((media) => media.muted)).toEqual(all.map(() => true))
  expect((await mediaProblems(page)).heard).toBe(false)
  return { src: element.src, from, to }
}

/** Waits until the service worker controls the page (it claims the first visit once active). */
export async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 30_000,
  })
}

/** Waits for `promise` at most `ms`, and never throws: for cleanup that must go on. */
function settle(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([promise.catch(() => {}), new Promise((done) => setTimeout(done, ms))])
}

/**
 * Tests on a phone (see the module comment): `phone` has the browser, FXM's page and the
 * requests. Each test starts its own browser, which takes a while on a busy machine.
 */
export const test = base.extend<{ phone: Phone }>({
  phone: [
    async ({ playwright, browserName }, use, testInfo) => {
      const project = testInfo.project.use
      const baseURL = project.baseURL
      if (baseURL === undefined) throw new Error('playwright.config.ts sets baseURL')
      const app = new URL(baseURL)
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fxm-phone-')))
      const requests: SeenRequest[] = []
      const seen = new Map<Request, SeenRequest>()
      /** Responses whose outcome is still being worked out (their server address). */
      const classifying = new Set<Promise<void>>()
      const consoleLines: string[] = []
      let network: FakeNetwork | undefined
      let offline = false

      // A home folder of the browser's own: WebKit keeps the Origin Private File System (and some
      // other site data) in ~/Library/WebKit/<its bundle>/WebsiteData whatever profile it runs
      // with, so without one, WebKit tests running side by side would share one file system,
      // and each would delete the other's downloads as files no record names. `CFFIXED_USER_HOME`
      // is the home that macOS's own APIs report.
      const home = join(dir, 'home')
      const launch = async (startOffline: boolean): Promise<BrowserContext> => {
        const context = await playwright[browserName].launchPersistentContext(
          join(dir, 'profile'),
          {
            env: {
              ...process.env,
              HOME: home,
              CFFIXED_USER_HOME: home,
              XDG_CONFIG_HOME: join(home, '.config'),
              XDG_DATA_HOME: join(home, '.local', 'share'),
              XDG_CACHE_HOME: join(home, '.cache'),
            },
            // The project's phone: screen, user agent, touch, and its scale.
            ...(project.viewport === undefined ? {} : { viewport: project.viewport }),
            ...(project.screen === undefined ? {} : { screen: project.screen }),
            ...(project.userAgent === undefined ? {} : { userAgent: project.userAgent }),
            ...(project.deviceScaleFactor === undefined
              ? {}
              : { deviceScaleFactor: project.deviceScaleFactor }),
            ...(project.isMobile === undefined ? {} : { isMobile: project.isMobile }),
            ...(project.hasTouch === undefined ? {} : { hasTouch: project.hasTouch }),
            ...(project.channel === undefined ? {} : { channel: project.channel }),
            ...(project.launchOptions?.args === undefined
              ? {}
              : { args: project.launchOptions.args }),
            headless: true,
            baseURL,
            serviceWorkers: 'allow',
            offline: startOffline,
          },
        )
        await context.addInitScript(silenceAndRecordMedia)
        // The Lite tier's sandbox documents (what make dist serves): refused, so the Free tier.
        await context.route('**/sandbox/**', (route) => route.abort('connectionrefused'))
        // Anything that leaves this machine: the fake network while online, else nothing.
        await context.route(
          (url) => url.origin !== app.origin,
          async (route) => {
            const request = route.request()
            if (offline || network === undefined) {
              await route.abort('internetdisconnected')
              return
            }
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
        context.on('request', (request) => {
          const url = request.url()
          const entry: SeenRequest = {
            url,
            method: request.method(),
            resourceType: request.resourceType(),
            offline,
            outcome: /^(blob|data):/u.test(url) ? 'device' : 'pending',
          }
          seen.set(request, entry)
          requests.push(entry)
        })
        context.on('response', (response) => {
          const entry = seen.get(response.request())
          if (entry === undefined || entry.outcome === 'device') return
          const classified = response
            .serverAddr()
            .catch(() => null)
            .then((server) => {
              if (server !== null) entry.outcome = 'network'
              else entry.outcome = response.fromServiceWorker() ? 'service-worker' : 'no-server'
            })
          classifying.add(classified)
          void classified.finally(() => classifying.delete(classified))
        })
        context.on('requestfailed', (request) => {
          const entry = seen.get(request)
          if (!entry) return
          entry.outcome = 'failed'
          entry.failure = request.failure()?.errorText ?? 'failed'
        })
        context.on('console', (message) => {
          consoleLines.push(`[${message.type()}] ${message.text()}`)
        })
        context.on('weberror', (error) => consoleLines.push(`[pageerror] ${error.error().message}`))
        return context
      }

      let context = await launch(false)
      let page = context.pages()[0] ?? (await context.newPage())
      const phone: Phone = {
        get context() {
          return context
        },
        get page() {
          return page
        },
        requests,
        async settledRequests() {
          while (classifying.size > 0) await Promise.all(classifying)
          return requests
        },
        get offline() {
          return offline
        },
        serve(next) {
          network = next
        },
        async goOffline() {
          offline = true
          await context.setOffline(true)
        },
        async restart(options = {}) {
          await settle(context.close(), 30_000)
          offline = options.offline ?? offline
          context = await launch(offline)
          page = context.pages()[0] ?? (await context.newPage())
          return page
        },
      }
      try {
        await use(phone)
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) {
          // Saved in the test's output folder, beside the report's copies.
          const consolePath = testInfo.outputPath('console.txt')
          const requestsPath = testInfo.outputPath('requests.json')
          writeFileSync(consolePath, consoleLines.join('\n'))
          writeFileSync(requestsPath, JSON.stringify(requests, null, 2))
          await testInfo.attach('console', { path: consolePath, contentType: 'text/plain' })
          await testInfo.attach('requests', { path: requestsPath, contentType: 'application/json' })
        }
        await settle(context.close(), 30_000)
        rmSync(dir, { recursive: true, force: true })
      }
    },
    // Its own time: the cleanup must run even after the test timed out.
    { timeout: 60_000 },
  ],
})

export { expect }
