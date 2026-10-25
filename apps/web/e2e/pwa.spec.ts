import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'

// The installable web app in Chromium: installability, launches, the service worker (offline
// shell, what it stores, updates) and the Window Controls Overlay title bar. One test at a time,
// because the update tests publish new versions of dist/sw.js, which this run built.
test.describe.configure({ mode: 'serial' })
test.use({ serviceWorkers: 'allow' })

const SW_FILE = fileURLToPath(new URL('../dist/sw.js', import.meta.url))
const UPDATE_TEXT = 'A new version of FXM is ready.'
const GREETING = /^Good (morning|afternoon|evening)$/
/** What the app shell is made of: the page, its code and styles, the manifest and the icons. */
const SHELL_FILE =
  /\/app\/(index\.html|manifest\.webmanifest|apple-touch-icon\.png|icons\/[\w-]+\.png|assets\/[\w.-]+\.(js|css))$/

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
 * Publishes a new version of FXM, as a deploy would: the same service worker with one more
 * line. The page's next update check finds it.
 */
function publishNewVersion() {
  versions += 1
  writeFileSync(SW_FILE, `${originalWorker}\n// e2e version ${versions} ${Date.now()}\n`)
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

/**
 * Runs `test` in a browser profile on disk: Chromium installs apps only outside incognito, and
 * every context Playwright makes otherwise is incognito.
 *
 * Installing an app makes Chromium add it to the operating system: an app in ~/Applications on
 * macOS, a .desktop file under ~/.local/share on Linux. The browser gets a home folder of its own
 * in the same temporary folder, so nothing lands in yours (`CFFIXED_USER_HOME` is the home that
 * macOS's own APIs report).
 */
async function withProfile(
  baseURL: string | undefined,
  run: (context: BrowserContext, page: Page, manifestId: string) => Promise<void>,
) {
  if (!baseURL) throw new Error('playwright.config.ts sets baseURL')
  const dir = mkdtempSync(join(tmpdir(), 'fxm-pwa-'))
  const home = join(dir, 'home')
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
    await run(context, page, new URL('./', baseURL).href)
  } finally {
    await context.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('Chromium finds FXM installable, offers it in the top bar and installs it', async ({
  baseURL,
}) => {
  await withProfile(baseURL, async (context, page, manifestId) => {
    await page.goto('./')
    await waitForServiceWorker(page)
    const cdp = await context.newCDPSession(page)

    expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([])
    const manifest = await cdp.send('Page.getAppManifest')
    expect(manifest.errors).toEqual([])
    expect(manifest.url).toBe(new URL('manifest.webmanifest', manifestId).href)
    expect(await cdp.send('Page.getAppId')).toEqual({ appId: manifestId, recommendedId: '/app/' })

    // Chromium's own offer (beforeinstallprompt) brings up FXM's install button.
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Install app' }),
    ).toBeVisible()

    await cdp.send('PWA.install', { manifestId })
    expect(await cdp.send('PWA.getOsAppState', { manifestId })).toMatchObject({ badgeCount: 0 })
  })
})

test('a launch of the installed app opens its page in the open window, without a reload', async ({
  baseURL,
}) => {
  await withProfile(baseURL, async (context, page, manifestId) => {
    await page.goto('settings')
    await waitForServiceWorker(page)
    const cdp = await context.newCDPSession(page)
    await cdp.send('PWA.install', { manifestId })
    await markPage(page, 'still playing')

    // As from the Library shortcut: launch_handler focuses the open window.
    await cdp.send('PWA.launch', { manifestId, url: new URL('library', manifestId).href })

    await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
    await expect(page).toHaveURL(/\/app\/library$/)
    expect(await pageMark(page)).toBe('still playing')
  })
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
  async function newVersionWaits(page: Page, path = './') {
    await page.goto(path)
    await waitForServiceWorker(page)
    publishNewVersion()
    await checkForUpdate(page)
    await expect(page.getByText(UPDATE_TEXT)).toBeVisible()
  }

  test('waits for the user, then reloads into it', async ({ page }) => {
    await newVersionWaits(page)
    await markPage(page, 'old version')

    const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame())
    await page.getByRole('button', { name: 'Reload' }).click()

    await reloaded
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
    expect(await pageMark(page)).toBeUndefined()
    await expect(page.getByText(UPDATE_TEXT)).toBeHidden()
    const registration = await page.evaluate(async () => {
      const current = await navigator.serviceWorker.getRegistration()
      return { waiting: current?.waiting ?? null, active: current?.active?.state }
    })
    expect(registration).toEqual({ waiting: null, active: 'activated' })
  })

  test('"Not now" keeps the running version, so the music goes on', async ({ page }) => {
    await newVersionWaits(page, 'library')
    await markPage(page, 'same page')

    await page.getByRole('button', { name: 'Not now' }).click()

    await expect(page.getByText(UPDATE_TEXT)).toBeHidden()
    expect(await pageMark(page)).toBe('same page')
    const waiting = await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration())?.waiting !== null,
    )
    expect(waiting).toBe(true)
  })
})

/** Pretends to be an installed desktop window whose title bar the page draws. */
async function windowControlsOverlay(page: Page) {
  await page.addInitScript(() => {
    const overlay = Object.assign(new EventTarget(), {
      visible: true,
      getTitlebarAreaRect: () => new DOMRect(0, 0, window.innerWidth - 140, 36),
    })
    Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay })
  })
}

test('a window with Window Controls Overlay gets a title bar that drags the window', async ({
  page,
}) => {
  await windowControlsOverlay(page)
  await page.goto('library')
  await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()

  const strip = page.locator('.titlebar')
  await expect(strip).toHaveText('Library · FXM')
  const bar = await strip.boundingBox()
  expect(bar).toMatchObject({ x: 0, y: 0 })
  expect(bar?.height).toBeGreaterThan(20)
  const region = await strip.evaluate(
    (element) => getComputedStyle(element).getPropertyValue('-webkit-app-region') || 'none',
  )
  expect(region).toBe('drag')

  // The shell moves below it.
  const below = (bar?.height ?? 0) - 0.5
  const search = await page.getByRole('banner').getByRole('searchbox').boundingBox()
  const sidebar = await page.getByRole('navigation', { name: 'Main' }).boundingBox()
  expect(search?.y).toBeGreaterThan(below)
  expect(sidebar?.y).toBeGreaterThan(below)
})

// Visual check, not a test: `pnpm --filter @fxm/web screenshots` saves the PWA's states at
// 320/768/1280 px in both themes to apps/web/screenshots/ (gitignored).
test.describe('screenshots', () => {
  test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 (pnpm screenshots) to capture')

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

          // Window Controls Overlay is for desktop windows.
          if (width >= 768) {
            const overlay = await page.context().newPage()
            await windowControlsOverlay(overlay)
            await overlay.goto('library')
            await expect(overlay.locator('.titlebar')).toBeVisible()
            await overlay.screenshot({ path: `${prefix}-title-bar.png` })
            await overlay.close()
          }

          await page.goto('./')
          await waitForServiceWorker(page)
          publishNewVersion()
          await checkForUpdate(page)
          await expect(page.getByText(UPDATE_TEXT)).toBeVisible()
          await page.screenshot({ path: `${prefix}-update.png` })
        })
      })
    }
  }
})
