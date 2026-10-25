import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BrowserContext,
  type CDPSession,
  chromium,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test'

// The installable web app in Chromium: installability, launches, the service worker (offline
// shell, what it stores, updates), where the update toast goes, and Window Controls Overlay.
// One test at a time, because the update tests publish new versions of dist/sw.js, which this
// run built.
test.describe.configure({ mode: 'serial' })
test.use({ serviceWorkers: 'allow' })

const SCREENSHOTS = Boolean(process.env.FXM_SCREENSHOTS)

/**
 * Whether tests may install FXM, into a temporary browser profile. An install also registers the
 * app with the operating system: on Linux that stays in the temporary home folder; on macOS
 * LaunchServices records the app (the tests make it forget it again); on Windows it adds Start
 * menu shortcuts. So installing runs on Linux, and elsewhere only with FXM_E2E_INSTALL=1.
 */
const INSTALLS =
  !SCREENSHOTS && (process.platform === 'linux' || process.env.FXM_E2E_INSTALL === '1')

const SW_FILE = fileURLToPath(new URL('../dist/sw.js', import.meta.url))
const UPDATE_TEXT = 'A new version of FXM is ready.'
const GREETING = /^Good (morning|afternoon|evening)$/
/** What the app shell is made of: the page, its code and styles, the manifest and the icons. */
const SHELL_FILE =
  /\/app\/(index\.html|manifest\.webmanifest|apple-touch-icon\.png|icons\/[\w-]+\.png|assets\/[\w.-]+\.(js|css))$/
/** The message a published version answers with its number (see publishNewVersion). */
const VERSION_QUESTION = 'fxm-e2e-version'

type MarkedWindow = Window & { fxmMarker?: string }

let originalWorker = ''
let versions = 0

test.beforeAll(() => {
  originalWorker = readFileSync(SW_FILE, 'utf8')
})

test.afterAll(() => {
  writeFileSync(SW_FILE, originalWorker)
})

/**
 * Publishes a new version of FXM, as a deploy would: the same service worker, plus a line that
 * tells a page which version controls it ({@link controllerVersion}). The page's next update
 * check finds it. Returns the version's number.
 */
function publishNewVersion(): number {
  versions += 1
  writeFileSync(
    SW_FILE,
    `${originalWorker}
self.addEventListener('message', (event) => {
  if (event.data === '${VERSION_QUESTION}') event.ports[0]?.postMessage(${versions})
})
`,
  )
  return versions
}

/** The published version that controls the page: 0 for the build's own, -1 for none. */
function controllerVersion(page: Page): Promise<number> {
  return page.evaluate(
    (question) =>
      new Promise<number>((resolve) => {
        const controller = navigator.serviceWorker.controller
        if (controller === null) {
          resolve(-1)
          return
        }
        const channel = new MessageChannel()
        channel.port1.onmessage = (event) => resolve(Number(event.data))
        controller.postMessage(question, [channel.port2])
        setTimeout(() => resolve(0), 1_000) // the build's own worker doesn't answer
      }),
    VERSION_QUESTION,
  )
}

/** Asks the browser to check for a new version now, instead of within the hour. */
function checkForUpdate(page: Page) {
  return page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update()
  })
}

/** Waits until the service worker controls the page (it claims the first visit once active). */
async function waitForServiceWorker(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
}

/** Whether a version waits, and the state of the active one. */
function registrationState(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    return { waiting: registration?.waiting !== null, active: registration?.active?.state }
  })
}

/** The URLs in the page's caches, without Workbox's revision parameter, sorted. */
function cachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        const url = new URL(request.url)
        url.searchParams.delete('__WB_REVISION__')
        urls.push(url.href)
      }
    }
    return urls.sort()
  })
}

/** Leaves a mark in the page, which only a reload wipes out. */
function markPage(page: Page, mark: string) {
  return page.evaluate((value) => {
    ;(window as MarkedWindow).fxmMarker = value
  }, mark)
}

const pageMark = (page: Page) => page.evaluate(() => (window as MarkedWindow).fxmMarker)

/** Counts the page's full loads from now on (a reload is one). */
function countLoads(page: Page): () => number {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  return () => loads
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox()
  if (found === null) throw new Error(`${locator} has no box`)
  return found
}

/** Whether two boxes share any area. */
function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'

/** The app shims Chromium made on macOS for apps installed with `home` as the home folder. */
function appShims(home: string): string[] {
  const folder = join(home, 'Applications', 'Chromium Apps.localized')
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter((name) => name.endsWith('.app'))
    .map((name) => join(folder, name))
}

/**
 * Makes LaunchServices forget app shims. It keeps listing an app after its folder is deleted, so
 * without this every run would leave an entry behind on the Mac.
 */
function forgetShims(shims: Iterable<string>) {
  for (const shim of shims) {
    try {
      execFileSync(LSREGISTER, ['-u', shim], { stdio: 'ignore', timeout: 30_000 })
    } catch {
      // Not registered after all.
    }
  }
}

interface Profile {
  context: BrowserContext
  page: Page
  cdp: CDPSession
  /** The manifest id, which is also the app's start URL. */
  manifestId: string
  /** Installs FXM; the fixture uninstalls it again when the test ends. */
  install(): Promise<void>
}

/** Waits for `promise` at most `ms`, and never throws: for cleanup that must go on. */
function settle(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([promise.catch(() => {}), new Promise((done) => setTimeout(done, ms))])
}

/**
 * Tests in a browser profile on disk (the `profile` fixture): Chromium offers to install apps
 * only outside incognito, and every context Playwright makes otherwise is incognito. Each test
 * starts its own browser, which takes a while on a busy machine: mark them `test.slow()`.
 *
 * Installing makes Chromium add the app to the operating system: an app in ~/Applications on
 * macOS, a .desktop file under ~/.local/share on Linux. The browser gets a home folder of its
 * own in a temporary folder, so none of that lands in yours (`CFFIXED_USER_HOME` is the home
 * that macOS's own APIs report). When the test ends, even by timing out, the fixture uninstalls
 * the app, closes the browser, makes LaunchServices forget the app on macOS and deletes the
 * folder.
 */
const profileTest = test.extend<{ profile: Profile }>({
  profile: [
    async ({ baseURL }, use) => {
      if (!baseURL) throw new Error('playwright.config.ts sets baseURL')
      // The real path: LaunchServices records /private/var/…, not the /var/… of tmpdir().
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fxm-pwa-')))
      const home = join(dir, 'home')
      const manifestId = new URL('./', baseURL).href
      const shims = new Set<string>()
      let installed = false
      const context = await chromium.launchPersistentContext(join(dir, 'profile'), {
        channel: 'chromium',
        baseURL,
        env: {
          ...process.env,
          HOME: home,
          CFFIXED_USER_HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local', 'share'),
          XDG_CACHE_HOME: join(home, '.cache'),
        },
      })
      try {
        const page = context.pages()[0] ?? (await context.newPage())
        const cdp = await context.newCDPSession(page)
        await use({
          context,
          page,
          cdp,
          manifestId,
          install: async () => {
            if (!INSTALLS) throw new Error('Installing is off here: set FXM_E2E_INSTALL=1')
            installed = true
            await cdp.send('PWA.install', { manifestId })
          },
        })
      } finally {
        for (const shim of appShims(home)) shims.add(shim)
        if (installed) {
          // The shim's usual name, in case Chromium deleted it before it was listed.
          shims.add(join(home, 'Applications', 'Chromium Apps.localized', 'FXM.app'))
          const uninstall = async () => {
            const page = context.pages()[0] ?? (await context.newPage())
            await (await context.newCDPSession(page)).send('PWA.uninstall', { manifestId })
          }
          await settle(uninstall(), 15_000)
        }
        await settle(context.close(), 30_000)
        for (const shim of appShims(home)) shims.add(shim)
        if (process.platform === 'darwin') forgetShims(shims)
        rmSync(dir, { recursive: true, force: true })
      }
    },
    // Its own time: the cleanup must run even after the test timed out.
    { timeout: 120_000 },
  ],
})

test.describe('in Chromium', () => {
  test.skip(SCREENSHOTS, 'A screenshot run captures the screenshots below only')

  profileTest(
    'Chromium finds FXM installable and offers it in the top bar',
    async ({ profile }) => {
      profileTest.slow()
      const { page, cdp, manifestId } = profile
      await page.goto('./')
      await waitForServiceWorker(page)

      expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([])
      const manifest = await cdp.send('Page.getAppManifest')
      expect(manifest.errors).toEqual([])
      expect(manifest.url).toBe(new URL('manifest.webmanifest', manifestId).href)
      expect(await cdp.send('Page.getAppId')).toEqual({ appId: manifestId, recommendedId: '/app/' })

      // Chromium's own offer (beforeinstallprompt) brings up FXM's install button.
      await expect(
        page.getByRole('banner').getByRole('button', { name: 'Install app' }),
      ).toBeVisible()
    },
  )

  profileTest.describe('installed', () => {
    profileTest.skip(!INSTALLS, 'Installs register an app with the OS: set FXM_E2E_INSTALL=1')
    profileTest.slow()

    profileTest('Chromium installs FXM', async ({ profile }) => {
      const { page, cdp, manifestId, install } = profile
      await page.goto('./')
      await waitForServiceWorker(page)
      await install()
      expect(await cdp.send('PWA.getOsAppState', { manifestId })).toMatchObject({ badgeCount: 0 })
    })

    profileTest(
      'a launch opens its page in the open window, without a reload',
      async ({ profile }) => {
        const { page, cdp, manifestId, install } = profile
        await page.goto('settings')
        await waitForServiceWorker(page)
        await install()
        await markPage(page, 'still playing')

        // As from the Library shortcut: launch_handler focuses the open window.
        await cdp.send('PWA.launch', { manifestId, url: new URL('library', manifestId).href })

        await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
        await expect(page).toHaveURL(/\/app\/library$/)
        expect(await pageMark(page)).toBe('still playing')
      },
    )
  })

  test('the service worker controls /app/, and the shell opens offline', async ({
    page,
    context,
  }) => {
    await page.goto('./')
    await waitForServiceWorker(page)
    const scope = await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration())?.scope,
    )
    expect(scope).toBe(new URL('./', page.url()).href)

    await context.setOffline(true)
    try {
      await page.reload()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)

      // A page whose code is a separate chunk, then a deep link.
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Library' })
        .click()
      await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
      await page.goto('settings')
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    } finally {
      await context.setOffline(false)
    }
  })

  test('the service worker keeps the app shell and never stores media or API responses', async ({
    page,
    context,
  }) => {
    // Stand-ins for the music services, so nothing leaves this machine.
    const cors = { 'access-control-allow-origin': '*' }
    await context.route('https://music.youtube.com/**', (route) =>
      route.fulfill({ json: {}, headers: cors }),
    )
    await context.route('https://*.googlevideo.com/**', (route) =>
      route.fulfill({ body: 'not really audio', contentType: 'audio/webm', headers: cors }),
    )
    await page.goto('./')
    await waitForServiceWorker(page)
    const shell = await cachedUrls(page)
    expect(shell.length).toBeGreaterThan(5)
    for (const url of shell) {
      expect(url).toMatch(SHELL_FILE)
      expect(new URL(url).origin).toBe(new URL(page.url()).origin)
    }

    const fromServiceWorker = new Map<string, boolean>()
    page.on('response', (response) =>
      fromServiceWorker.set(response.url(), response.fromServiceWorker()),
    )
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
    const api = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false'
    const media = 'https://rr1---sn-fxm.googlevideo.com/videoplayback?id=fxm'
    const element = 'https://rr2---sn-fxm.googlevideo.com/videoplayback?id=fxm'
    const local = new URL('not-in-the-shell.webm', page.url()).href
    await page.evaluate(
      async ({ api, media, element, local }) => {
        await fetch(api, { method: 'POST', body: '{}' })
        await fetch(media, { headers: { Range: 'bytes=0-63' } })
        await fetch(local)
        const audio = new Audio(element)
        await new Promise((settle) => {
          audio.addEventListener('error', settle, { once: true })
          audio.addEventListener('loadedmetadata', settle, { once: true })
        })
      },
      { api, media, element, local },
    )

    // The shell came from the service worker's cache; everything else went past it.
    const script = [...fromServiceWorker.keys()].find((url) => /\/app\/assets\/.+\.js$/.test(url))
    expect(script && fromServiceWorker.get(script)).toBe(true)
    for (const url of [api, media, element, local]) {
      expect(fromServiceWorker.get(url), url).toBe(false)
    }
    expect(await cachedUrls(page)).toEqual(shell)
  })

  test.describe('a new version', () => {
    /** Opens FXM, then publishes a new version and lets the page find it. */
    async function newVersionWaits(page: Page, path = './'): Promise<number> {
      await page.goto(path)
      await waitForServiceWorker(page)
      const version = publishNewVersion()
      await checkForUpdate(page)
      await expect(page.getByText(UPDATE_TEXT)).toBeVisible()
      return version
    }

    test('waits for the user, then reloads into it', async ({ page }) => {
      const version = await newVersionWaits(page)
      await markPage(page, 'old version')

      const reloaded = page.waitForEvent('load')
      await page.getByRole('button', { name: 'Reload' }).click()

      await reloaded
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
      expect(await pageMark(page)).toBeUndefined()
      await expect(page.getByText(UPDATE_TEXT)).toBeHidden()
      expect(await registrationState(page)).toEqual({ waiting: false, active: 'activated' })
      expect(await controllerVersion(page)).toBe(version)
    })

    test('a page that loaded under the service worker reloads into it once', async ({ page }) => {
      // A returning visit: the service worker controls the page from its start, and
      // vite-plugin-pwa's own takeover report (onNeedReload) fires as well.
      await page.goto('./')
      await waitForServiceWorker(page)
      await page.reload()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
      const version = publishNewVersion()
      await checkForUpdate(page)
      await expect(page.getByText(UPDATE_TEXT)).toBeVisible()
      await markPage(page, 'old version')
      const loads = countLoads(page)

      await page.getByRole('button', { name: 'Reload' }).click()

      await expect.poll(loads).toBe(1)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
      expect(await pageMark(page)).toBeUndefined()
      expect(await controllerVersion(page)).toBe(version)
      // No second reload follows.
      await page.waitForTimeout(1_500)
      expect(loads()).toBe(1)
    })

    test('"Not now" keeps the running version, so the music goes on', async ({ page }) => {
      await newVersionWaits(page, 'library')
      await markPage(page, 'same page')

      await page.getByRole('button', { name: 'Not now' }).click()

      await expect(page.getByText(UPDATE_TEXT)).toBeHidden()
      // Workbox reports a version twice, 200 ms apart: the second report must not bring it back.
      await page.waitForTimeout(1_000)
      await expect(page.getByText(UPDATE_TEXT)).toBeHidden()
      expect(await pageMark(page)).toBe('same page')
      expect((await registrationState(page)).waiting).toBe(true)
    })

    test('the other FXM tabs reload into it too', async ({ page, context }) => {
      const other = await context.newPage()
      await page.goto('./')
      await other.goto('library')
      await waitForServiceWorker(page)
      await waitForServiceWorker(other)
      const version = publishNewVersion()
      await checkForUpdate(page)
      await expect(page.getByText(UPDATE_TEXT)).toBeVisible()
      await expect(other.getByText(UPDATE_TEXT)).toBeVisible()
      await markPage(other, 'other tab')

      const otherReloaded = other.waitForEvent('load')
      await page.getByRole('button', { name: 'Reload' }).click()

      await otherReloaded
      await expect(other.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
      expect(await pageMark(other)).toBeUndefined()
      await expect(other.getByText(UPDATE_TEXT)).toBeHidden()
      expect(await controllerVersion(other)).toBe(version)
      expect(await controllerVersion(page)).toBe(version)
    })

    test.describe('on a phone', () => {
      test.use({ viewport: { width: 320, height: 720 }, hasTouch: true })

      test('the toast keeps clear of the player controls', async ({ page }) => {
        // Home: above the mini player.
        await newVersionWaits(page)
        const toast = page.getByRole('region', { name: 'App update' })
        const mini = page.getByRole('region', { name: 'Player' })
        expect(overlap(await box(toast), await box(mini))).toBe(false)

        // Now Playing has big controls where the mini player would be: the toast goes on top.
        await page.goto('now-playing')
        await expect(toast).toBeVisible()
        const main = page.getByRole('main')
        for (const control of [
          main.getByRole('button', { name: 'Play' }),
          main.getByRole('button', { name: 'Next' }),
          main.getByRole('slider', { name: 'Seek' }),
        ]) {
          expect(overlap(await box(toast), await box(control)), `${control}`).toBe(false)
        }
        const topBar = await box(page.getByRole('banner'))
        expect((await box(toast)).y).toBeGreaterThanOrEqual(topBar.y + topBar.height)
      })
    })
  })

  test.describe('Window Controls Overlay', () => {
    for (const { side, width } of [
      { side: 'right', width: 1280 },
      { side: 'left', width: 1280 },
      { side: 'right', width: 768 },
      { side: 'left', width: 768 },
      { side: 'left', width: 480 },
      { side: 'right', width: 480 },
    ] as const) {
      test.describe(`${width}px, window buttons on the ${side}`, () => {
        test.use({ viewport: { width, height: 800 } })

        test('the top bar is the title bar, clear of the window buttons', async ({ page }) => {
          await windowControlsOverlay(page, side)
          await page.goto('library')
          await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
          await expect(page.locator('html')).toHaveAttribute('data-titlebar', `overlay ${side}`)
          const buttons = windowButtons(side, width)

          // The top bar sits where the title bar was, and drags the window.
          const topBar = page.getByRole('banner')
          expect((await box(topBar)).y).toBe(0)
          expect(await appRegion(topBar)).toBe('drag')

          // Everything in it stays clickable and out from under the window buttons.
          const controls = topBar.locator('a, button, input')
          expect(await controls.count()).toBeGreaterThan(0)
          for (const control of await controls.all()) {
            if (!(await control.isVisible())) continue
            expect(await appRegion(control), `${control}`).toBe('no-drag')
            expect(overlap(await box(control), buttons), `${control}`).toBe(false)
          }

          // So does the sidebar's logo, where the window buttons may sit (macOS).
          if (width >= 768) {
            const logo = page
              .getByRole('navigation', { name: 'Main' })
              .getByRole('link', { name: 'FXM home' })
            expect(await appRegion(page.locator('.titlebar-logo'))).toBe('drag')
            if (await logo.isVisible()) {
              expect(await appRegion(logo)).toBe('no-drag')
              expect(overlap(await box(logo), buttons)).toBe(false)
            } else {
              // The icon rail is too narrow to share its top with the buttons.
              expect({ side, width }).toEqual({ side: 'left', width: 768 })
            }
          }
        })

        test('the skip link shows below the title bar', async ({ page }) => {
          await windowControlsOverlay(page, side)
          await page.goto('library')
          await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()

          await page.keyboard.press('Tab')

          const skip = page.getByRole('link', { name: 'Skip to content' })
          await expect(skip).toBeFocused()
          const link = await box(skip)
          const topBar = await box(page.getByRole('banner'))
          expect(link.y).toBeGreaterThanOrEqual(topBar.y + topBar.height - 0.5)
          expect(overlap(link, windowButtons(side, width))).toBe(false)
          // Nothing covers it.
          const hit = await page.evaluate(
            ({ x, y }) => document.elementFromPoint(x, y)?.textContent ?? '',
            { x: link.x + link.width / 2, y: link.y + link.height / 2 },
          )
          expect(hit).toBe('Skip to content')
        })
      })
    }

    test('switching the overlay off gives the window its own title bar back', async ({ page }) => {
      await windowControlsOverlay(page, 'right')
      await page.goto('./')
      await expect(page.locator('html')).toHaveAttribute('data-titlebar', 'overlay right')

      await page.evaluate(() => {
        const overlay = (navigator as Navigator & { windowControlsOverlay: EventTarget })
          .windowControlsOverlay
        Object.assign(overlay, { visible: false })
        overlay.dispatchEvent(new Event('geometrychange'))
      })

      await expect(page.locator('html')).not.toHaveAttribute('data-titlebar')
      expect(await appRegion(page.getByRole('banner'))).toBe('none')
    })
  })
})

/** How wide the window buttons are on each side, and the title bar's height there. */
const WINDOW_BUTTONS = {
  // macOS: the traffic lights, on the left.
  left: { width: 80, height: 28 },
  // Windows, Linux and ChromeOS: minimize, maximize and close, on the right.
  right: { width: 140, height: 33 },
} as const

/** The window buttons' box in a window `viewportWidth` wide. */
function windowButtons(side: keyof typeof WINDOW_BUTTONS, viewportWidth: number): Box {
  const { width, height } = WINDOW_BUTTONS[side]
  return { x: side === 'left' ? 0 : viewportWidth - width, y: 0, width, height }
}

/**
 * Pretends to be an installed desktop window whose title bar the page draws, with the window
 * buttons on `side` (Chromium's `navigator.windowControlsOverlay`).
 */
async function windowControlsOverlay(page: Page, side: keyof typeof WINDOW_BUTTONS) {
  await page.addInitScript(
    ({ side, width, height }) => {
      const overlay = Object.assign(new EventTarget(), {
        visible: true,
        getTitlebarAreaRect: () =>
          new DOMRect(side === 'left' ? width : 0, 0, window.innerWidth - width, height),
      })
      Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay })
    },
    { side, ...WINDOW_BUTTONS[side] },
  )
}

/** Whether an element drags the window (`-webkit-app-region`). */
function appRegion(locator: Locator): Promise<string> {
  return locator.evaluate(
    (element) => getComputedStyle(element).getPropertyValue('-webkit-app-region') || 'none',
  )
}

// Visual check, not a test: `pnpm --filter @fxm/web screenshots` saves the PWA's states at
// 320/768/1280 px in both themes to apps/web/screenshots/ (gitignored).
test.describe('screenshots', () => {
  test.skip(!SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 (pnpm screenshots) to capture')

  /** Chromium's install offer, as the browser would make it (the real one needs a profile). */
  const offerInstall = (page: Page) =>
    page.evaluate(() => {
      const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: async () => {},
        userChoice: new Promise(() => {}),
      })
      window.dispatchEvent(offer)
    })

  for (const theme of ['dark', 'light'] as const) {
    for (const width of [320, 768, 1280] as const) {
      test.describe(`${theme} at ${width}px`, () => {
        test.use({
          viewport: { width, height: width < 768 ? 720 : 860 },
          hasTouch: width < 1024,
          reducedMotion: 'reduce',
        })

        test('captures the install offer, the update toast and the title bar', async ({ page }) => {
          const prefix = `screenshots/pwa-${theme}-${width}`
          await page.addInitScript(
            (state) =>
              localStorage.setItem('fxm.settings.v1', JSON.stringify({ state, version: 1 })),
            { catalogMode: 'music', theme },
          )

          // Phones: the card on Home; from 768px: the top bar's button.
          await page.goto('./')
          await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
          await offerInstall(page)
          await page.screenshot({ path: `${prefix}-install.png` })

          await page.goto('settings')
          await offerInstall(page)
          await page
            .getByRole('heading', { level: 2, name: 'App', exact: true })
            .evaluate((heading) => heading.scrollIntoView({ block: 'center' }))
          await page.screenshot({ path: `${prefix}-settings.png` })

          // Window Controls Overlay is for desktop windows: buttons on the right, then on the
          // left as on macOS.
          if (width >= 768) {
            for (const side of ['right', 'left'] as const) {
              const overlay = await page.context().newPage()
              await windowControlsOverlay(overlay, side)
              await overlay.goto('library')
              await expect(overlay.locator('html')).toHaveAttribute('data-titlebar', /overlay/)
              await overlay.screenshot({ path: `${prefix}-title-bar-${side}.png` })
              await overlay.close()
            }
          }

          await page.goto('./')
          await waitForServiceWorker(page)
          publishNewVersion()
          await checkForUpdate(page)
          await expect(page.getByText(UPDATE_TEXT)).toBeVisible()
          await page.screenshot({ path: `${prefix}-update.png` })

          if (width < 768) {
            await page.goto('now-playing')
            await expect(page.getByText(UPDATE_TEXT)).toBeVisible()
            await page.screenshot({ path: `${prefix}-update-now-playing.png` })
          }
        })
      })
    }
  }
})
