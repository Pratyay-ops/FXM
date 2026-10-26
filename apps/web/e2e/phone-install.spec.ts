import { expect, test, waitForServiceWorker } from './phone'

// FXM installs on a phone (stage 5.1), in Chromium as a Pixel 7 and in WebKit as an iPhone 15
// (e2e/phone.ts): the manifest and icons a Home Screen needs, the page's own tags for iOS, and
// the service worker that controls /app/. Chromium also offers the install itself
// (`beforeinstallprompt`); Safari has no such offer, and installs from its Share menu, which
// Settings explains. Tapping Share and then Add to Home Screen is Safari's own interface, which
// no test can reach.

/** A web app manifest, as far as these tests read it. */
interface WebManifest {
  id?: string
  name?: string
  short_name?: string
  start_url?: string
  scope?: string
  display?: string
  theme_color?: string
  background_color?: string
  icons?: { src: string; sizes?: string; type?: string; purpose?: string }[]
}

/** A PNG's size and whether it has an alpha channel, from its header. */
function pngHeader(bytes: Buffer): { size: string; alpha: boolean } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
  // Colour types 4 and 6 have an alpha channel.
  const colourType = bytes[25]
  return {
    size: `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`,
    alpha: colourType === 4 || colourType === 6,
  }
}

test('the manifest, the icons and the tags make FXM a Home Screen app', async ({
  phone,
  baseURL,
}) => {
  if (!baseURL) throw new Error('playwright.config.ts sets baseURL')
  const { page, context } = phone
  await page.goto('./')
  const head = await page.evaluate(() => {
    const link = (rel: string) =>
      document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)?.href ?? null
    const meta = (name: string) =>
      document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null
    return {
      manifest: link('manifest'),
      appleTouchIcon: link('apple-touch-icon'),
      themeColor: meta('theme-color'),
      viewport: meta('viewport'),
      appleTitle: meta('apple-mobile-web-app-title'),
      appleCapable: meta('apple-mobile-web-app-capable'),
    }
  })

  // The manifest: served as one, with the app's identity, address and window.
  expect(head.manifest).toBe(new URL('manifest.webmanifest', baseURL).href)
  const served = await context.request.get(head.manifest ?? '')
  expect(served.status()).toBe(200)
  expect(served.headers()['content-type']).toMatch(/^application\/manifest\+json/)
  const manifest = (await served.json()) as WebManifest
  expect(manifest).toMatchObject({
    id: '/app/',
    name: 'FXM',
    short_name: 'FXM',
    start_url: '/app/',
    scope: '/app/',
    display: 'standalone',
  })
  // As a browser resolves them: the app starts at its own address, and the page is in scope.
  const startUrl = new URL(manifest.start_url ?? '', head.manifest ?? '').href
  const scope = new URL(manifest.scope ?? '', head.manifest ?? '').href
  expect(startUrl).toBe(baseURL)
  expect(scope).toBe(baseURL)
  expect(page.url().startsWith(scope)).toBe(true)
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i)
  expect(manifest.theme_color).toBe(head.themeColor)

  // Its icons: each one served, a PNG of the size it says; plain and maskable, 192 and 512 px.
  const icons: string[] = []
  for (const icon of manifest.icons ?? []) {
    const url = new URL(icon.src, head.manifest ?? '').href
    const png = await context.request.get(url)
    expect(png.status(), url).toBe(200)
    expect(png.headers()['content-type'], url).toBe('image/png')
    expect(icon.type, url).toBe('image/png')
    expect(pngHeader(await png.body()).size, url).toBe(icon.sizes)
    icons.push(`${icon.purpose ?? 'any'} ${icon.sizes}`)
  }
  expect(icons).toEqual(
    expect.arrayContaining(['any 192x192', 'any 512x512', 'maskable 192x192', 'maskable 512x512']),
  )

  // iOS: its own Home Screen icon, 180 px and opaque (iOS rounds the corners itself, and would
  // fill transparent ones black), and the name under it.
  expect(head.appleTouchIcon).toBe(new URL('apple-touch-icon.png', baseURL).href)
  const touchIcon = await context.request.get(head.appleTouchIcon ?? '')
  expect(touchIcon.status()).toBe(200)
  expect(touchIcon.headers()['content-type']).toBe('image/png')
  expect(pngHeader(await touchIcon.body())).toEqual({ size: '180x180', alpha: false })
  expect(head.appleTitle).toBe('FXM')
  // Its own window from the Home Screen: iOS 11.3 and later read the manifest's `display`, so
  // FXM needs no `apple-mobile-web-app-capable` (it would have to say yes if it had one).
  expect(head.appleCapable === null ? manifest.display : head.appleCapable).toMatch(
    /^(standalone|fullscreen|yes)$/,
  )
  // The status bar's colour, and a page that may draw under the notch and the home indicator.
  expect(head.themeColor).toMatch(/^#[0-9a-f]{6}$/i)
  expect(head.viewport).toContain('width=device-width')
  expect(head.viewport).toContain('viewport-fit=cover')
})

test('the service worker registers and controls /app/', async ({ phone, baseURL }) => {
  if (!baseURL) throw new Error('playwright.config.ts sets baseURL')
  const { page } = phone
  await page.goto('./')
  await waitForServiceWorker(page)
  const registration = () =>
    page.evaluate(async () => {
      const found = await navigator.serviceWorker.getRegistration()
      return {
        scope: found?.scope,
        active: found?.active?.state,
        controller: navigator.serviceWorker.controller?.scriptURL,
      }
    })
  const expected = { scope: baseURL, active: 'activated', controller: `${baseURL}sw.js` }
  // It claims the page while it activates (WebKit reports that state for a moment): polled.
  await expect.poll(registration).toEqual(expected)

  // It controls the app's other pages from their first load, and keeps the shell for offline use.
  const deepLink = await page.goto('library?tab=downloads')
  expect(deepLink?.fromServiceWorker()).toBe(true)
  expect(await registration()).toEqual(expected)
  const shell = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url)
    }
    return urls
  })
  expect(shell.some((url) => url.startsWith(`${baseURL}index.html`))).toBe(true)
  expect(shell.some((url) => url.startsWith(`${baseURL}manifest.webmanifest`))).toBe(true)
})

test.describe('in Chromium', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Safari makes no install offer')

  test('Chromium offers to install FXM, and Home shows the offer', async ({ phone }) => {
    const { page, context } = phone
    // Whether Chromium made its offer (`beforeinstallprompt`), which FXM keeps for its button.
    await page.addInitScript(() => {
      window.addEventListener('beforeinstallprompt', () => {
        document.documentElement.dataset.e2eInstallOffer = 'made'
      })
    })
    await page.goto('./')
    await waitForServiceWorker(page)

    const cdp = await context.newCDPSession(page)
    expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([])
    expect((await cdp.send('Page.getAppManifest')).errors).toEqual([])
    await expect(page.locator('html')).toHaveAttribute('data-e2e-install-offer', 'made')

    // On a phone the offer is a card on Home (the top bar keeps its room for the page title).
    const card = page.getByRole('region', { name: 'Install FXM' })
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: 'Install' })).toBeVisible()
    // Settings offers it too.
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByText('Opens FXM in its own window, from your dock')).toBeVisible()
    await expect(page.getByRole('main').getByRole('button', { name: 'Install' })).toBeVisible()
  })
})

test.describe('in WebKit', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'The iPhone hint shows in WebKit')

  test('on an iPhone, Settings says to add FXM from the Share menu', async ({ phone }) => {
    const { page } = phone
    await page.goto('settings')
    // Safari makes no install offer to the page: Share, then Add to Home Screen.
    expect(await page.evaluate(() => 'onbeforeinstallprompt' in window)).toBe(false)
    await expect(
      page.getByText('Tap Share in your browser, then Add to Home Screen.', { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('main').getByRole('button', { name: 'Install' })).toHaveCount(0)
  })
})
