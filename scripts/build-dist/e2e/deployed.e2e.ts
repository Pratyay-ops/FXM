/**
 * Browser checks of a deployment (docs/PLAN.md, stage 2.8), run against FXM_DEPLOY_URL by the
 * deploy workflow, or against `make dist` served like Cloudflare Pages on 127.0.0.1.
 *
 * - The pages and the app start under their policies, with no violation reported.
 * - A page opened at top level by another site keeps no tie to it (Cross-Origin-Opener-Policy),
 *   and the Permissions-Policy turns off the features FXM never uses, and none the player uses.
 * - googlevideo requests from the app (and the embed, once 5.2 ships it) carry no Referer, also
 *   at a percent-encoded path, where no `_headers` rule applies (src/headers-file.ts).
 * - The sandbox documents (1.10) are opaque at their own paths, reach only their hosts, and
 *   ignore a page on another origin that frames them without the sandbox attribute. At a
 *   percent-encoded path, which their sandbox policy can't reach, they stay inert.
 *
 * Requests to googlevideo, YouTube and the stand-in third-party sites are answered by the test
 * itself, so nothing here contacts YouTube.
 */
import { createServer } from 'node:http'
import { expect, type Frame, type Page, type Request, test } from '@playwright/test'

/** Collects the Content-Security-Policy violations a page reports. */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { fxmViolations: string[] }).fxmViolations = seen
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.effectiveDirective} blocked ${event.blockedURI || 'inline code'}`)
    })
  })
  return () =>
    page.evaluate(() => (window as unknown as { fxmViolations?: string[] }).fxmViolations ?? [])
}

async function deployed(page: Page, path: string): Promise<boolean> {
  const response = await page.request.get(path, { maxRedirects: 0 })
  return response.status() === 200
}

for (const path of ['/', '/privacy', '/disclaimer']) {
  test(`${path} renders under its policy`, async ({ page }) => {
    const violations = await watchViolations(page)
    await page.goto(path)
    await expect(page.locator('h1')).toBeVisible()
    expect(await violations()).toEqual([])
  })
}

test('the web app starts under its policy, deep links included', async ({ page }) => {
  const violations = await watchViolations(page)
  await page.goto('/app/')
  await expect(page.getByRole('main')).toBeVisible()
  // A client-side route: Pages answers 404 with the app's own 404.html, and the app routes it.
  const response = await page.goto('/app/settings')
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  expect(await violations()).toEqual([])
})

/** A googlevideo host the test answers itself. */
const GOOGLEVIDEO = 'https://rr1---sn-fxmcheck.googlevideo.com/videoplayback?fxm-check='

// `/%61pp/` serves the app with no `_headers` rule: only its meta elements apply there.
for (const path of ['/app/', '/embed/', '/%61pp/']) {
  test(`googlevideo requests from ${path} carry no Referer`, async ({ page }) => {
    test.skip(!(await deployed(page, path)), `nothing is deployed at ${path} yet`)
    const seen: Request[] = []
    await page.route('https://*.googlevideo.com/**', async (route) => {
      seen.push(route.request())
      await route.fulfill({ status: 204 })
    })
    await page.goto(path)
    await page.evaluate((base) => {
      // The two ways the player reaches googlevideo: a media element, and fetch (FXM Connect).
      const audio = document.createElement('audio')
      audio.src = `${base}audio`
      audio.load()
      void fetch(`${base}fetch`, { mode: 'no-cors', credentials: 'omit' }).catch(() => undefined)
    }, GOOGLEVIDEO)
    await expect.poll(() => seen.length).toBeGreaterThanOrEqual(2)
    for (const request of seen) {
      const headers = await request.allHeaders()
      expect(headers.referer, `${request.url()} was sent with a Referer`).toBeUndefined()
    }
  })
}

/**
 * The attribute 1.10's documents set on their `<html>` once their script listens for the page
 * (SANDBOX_MARKER_ATTRIBUTE in packages/platform/src/sandbox/document.ts). It tells a document
 * that ignores a message from one whose script never ran. Keep it, and the protocol below, the
 * same as there: the protocol stays inside @fxm/platform, so these checks don't import it.
 */
const SANDBOX_MARKER = 'data-fxm-sandbox'

/**
 * A token as the app's transport puts one in a document's URL fragment (SANDBOX_TOKEN_PATTERN).
 * Without one a document's script serves nobody, and the checks below would prove nothing.
 */
const SANDBOX_TOKEN = '00112233445566778899aabbccddeeff'

/**
 * What the app's transport sends a document (SANDBOX_MESSAGE and SANDBOX_PROTOCOL): `connect`,
 * which carries a port, then requests. A document takes them only from FXM's page.
 */
const SANDBOX_MESSAGES = [
  { type: 'fxm-sandbox:connect', protocol: 2 },
  {
    type: 'fxm-sandbox:request',
    id: '1',
    url: 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
    method: 'POST',
    headers: {},
    body: '{}',
  },
]

/** The InnerTube hosts innertube.html may reach, each answered by the test. */
const INNERTUBE_HOSTS = [
  'https://www.youtube.com',
  'https://music.youtube.com',
  'https://youtubei.googleapis.com',
]

/**
 * Opens a page with the given HTML on another origin, and returns a function that closes what
 * it started.
 *
 * Against a deployment, the page is a made-up public site the test answers itself. Locally it
 * must be a real server: Chrome treats a page the test answers as public, and blocks a public
 * page from framing a local address (it shows its error page instead). So a server on the next
 * free port above the preview's (5801 and up, one per test worker) serves it as `localhost`,
 * another origin than `127.0.0.1`.
 */
async function openElsewhere(
  page: Page,
  baseURL: string,
  html: string,
): Promise<{ close: () => Promise<void> }> {
  const base = new URL(baseURL)
  let close = async () => {}
  let other = `${base.protocol}//fxm-check.example/`
  if (['127.0.0.1', 'localhost'].includes(base.hostname)) {
    const port = Number(base.port) + 1 + test.info().parallelIndex
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    close = () => new Promise((resolve) => server.close(() => resolve()))
    other = `http://${base.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}:${port}/`
  } else {
    await page.route(other, (route) => route.fulfill({ contentType: 'text/html', body: html }))
  }
  await page.goto(other)
  return { close }
}

/**
 * Opens a page on another origin that frames `path` without the sandbox attribute (see
 * openElsewhere), and returns the frame and a function that closes what it started.
 */
async function frameFromElsewhere(
  page: Page,
  baseURL: string,
  path: string,
): Promise<{ frame: Frame; close: () => Promise<void> }> {
  const html = `<!doctype html><title>elsewhere</title><iframe src="${new URL(path, baseURL)}"></iframe>`
  const { close } = await openElsewhere(page, baseURL, html)
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
  if (!frame) throw new Error('the page has no frame')
  await frame.waitForLoadState()
  return { frame, close }
}

/**
 * Posts messages to the page's frame, each with a port as `connect` carries one, and returns
 * whatever comes back within 1.5 s, to the page or on a port.
 */
async function repliesTo(page: Page, messages: readonly unknown[]): Promise<unknown[]> {
  return page.evaluate(async (messages) => {
    const target = document.querySelector('iframe')?.contentWindow
    const received: unknown[] = []
    addEventListener('message', (event) => received.push(event.data))
    for (const message of messages) {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = (event) => received.push(event.data)
      target?.postMessage(message, '*', [port2])
    }
    await new Promise((wait) => setTimeout(wait, 1500))
    return received
  }, messages)
}

test('a page opened by another site keeps no tie to it', async ({ page, baseURL }) => {
  const opener = '<!doctype html><title>elsewhere</title><button id="open">Open FXM</button>'
  const { close } = await openElsewhere(page, baseURL as string, opener)
  try {
    await page.evaluate((url) => {
      document.getElementById('open')?.addEventListener('click', () => {
        ;(window as unknown as { opened: Window | null }).opened = window.open(url, 'fxm', 'popup')
      })
    }, new URL('/app/', baseURL).href)
    const [popup] = await Promise.all([
      page.context().waitForEvent('page'),
      page.locator('#open').click(),
    ])
    await popup.waitForLoadState()
    // Cross-Origin-Opener-Policy put the app in a group of its own: the opener's handle on it
    // reads as a closed window, and the app has no opener.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { opened: Window }).opened.closed))
      .toBe(true)
    expect(await popup.evaluate(() => window.opener)).toBeNull()
    await popup.close()
  } finally {
    await close()
  }
})

test('the pages turn off the features FXM never uses, and none the player uses', async ({
  page,
}) => {
  for (const path of ['/', '/app/']) {
    await page.goto(path)
    const allowed = await page.evaluate(() => {
      // Chromium's view of the page's Permissions-Policy.
      const policy = (document as { featurePolicy?: { allowsFeature(name: string): boolean } })
        .featurePolicy
      if (!policy) return undefined
      const features = ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial']
      const player = ['autoplay', 'fullscreen', 'picture-in-picture', 'screen-wake-lock']
      return Object.fromEntries(
        [...features, 'bluetooth', 'hid', 'midi', ...player].map((name) => [
          name,
          policy.allowsFeature(name),
        ]),
      )
    })
    test.skip(allowed === undefined, 'this browser does not report its permissions policy')
    expect(allowed, path).toEqual({
      camera: false,
      microphone: false,
      geolocation: false,
      payment: false,
      usb: false,
      serial: false,
      bluetooth: false,
      hid: false,
      midi: false,
      autoplay: true,
      fullscreen: true,
      'picture-in-picture': true,
      'screen-wake-lock': true,
    })
  }
})

test.describe('sandbox documents', () => {
  test('innertube.html is opaque and only its policy keeps it to its three hosts', async ({
    page,
  }) => {
    test.skip(
      !(await deployed(page, '/sandbox/innertube')),
      'no sandbox documents deployed yet (1.10)',
    )
    // Every host answers, the disallowed one too, so only connect-src can stop a request.
    const answer = { status: 200, headers: { 'access-control-allow-origin': '*' }, body: '{}' }
    for (const host of [...INNERTUBE_HOSTS, 'https://example.com']) {
      await page.route(`${host}/**`, (route) => route.fulfill(answer))
    }
    await page.goto('/sandbox/innertube.html')
    const result = await page.evaluate(async (hosts) => {
      const violations: string[] = []
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(`${event.effectiveDirective} ${event.blockedURI}`)
      })
      const attempt = (url: string) =>
        fetch(url, { method: 'POST', body: '{}', credentials: 'omit' }).then(
          () => 'reached',
          () => 'blocked',
        )
      const reached: Record<string, string> = {}
      for (const host of hosts) reached[host] = await attempt(`${host}/youtubei/v1/search`)
      const elsewhere = await attempt('https://example.com/')
      await new Promise((wait) => setTimeout(wait, 100))
      return { origin: self.origin, reached, elsewhere, violations }
    }, INNERTUBE_HOSTS)
    expect(result).toMatchObject({
      origin: 'null',
      reached: Object.fromEntries(INNERTUBE_HOSTS.map((host) => [host, 'reached'])),
      elsewhere: 'blocked',
    })
    // One report from the header's policy, and one from the meta element's copy of it.
    expect(result.violations.length).toBeGreaterThan(0)
    expect(new Set(result.violations)).toEqual(new Set(['connect-src https://example.com/']))
  })

  for (const name of ['innertube', 'userhost']) {
    test(`${name}.html framed by another site without the sandbox attribute stays opaque and silent`, async ({
      page,
      baseURL,
    }) => {
      test.skip(
        !(await deployed(page, `/sandbox/${name}`)),
        'no sandbox documents deployed yet (1.10)',
      )
      const { frame, close } = await frameFromElsewhere(
        page,
        baseURL as string,
        `/sandbox/${name}.html#${SANDBOX_TOKEN}`,
      )
      try {
        // The document itself, after Pages' redirect to the extension-less path, not an error page.
        expect(frame.url()).toBe(new URL(`/sandbox/${name}#${SANDBOX_TOKEN}`, baseURL).href)
        expect(await frame.evaluate(() => self.origin)).toBe('null')
        expect(
          await frame.evaluate(
            (marker) => document.documentElement.hasAttribute(marker),
            SANDBOX_MARKER,
          ),
          'the document script ran',
        ).toBe(true)
        expect(await repliesTo(page, [{ type: 'ping' }, ...SANDBOX_MESSAGES])).toEqual([])
      } finally {
        await close()
      }
    })
  }

  // Pages serves innertube.html at these paths too, but no `_headers` rule can match them
  // (src/headers-file.ts), so the document's sandbox policy doesn't apply: its own check of
  // self.origin must keep it from doing anything. Browsers send these paths as written.
  for (const path of ['/sandbox/innertub%65', '/sandbox%2Finnertube']) {
    test(`a sandbox document at ${path} stays inert`, async ({ page, baseURL }) => {
      test.skip(
        !(await deployed(page, '/sandbox/innertube')),
        'no sandbox documents deployed yet (1.10)',
      )
      const url = `${path}#${SANDBOX_TOKEN}`
      const { frame, close } = await frameFromElsewhere(page, baseURL as string, url)
      try {
        expect(frame.url()).toBe(new URL(url, baseURL).href)
        expect(await frame.title()).toMatch(/\S/)
        // No rule, so no sandbox policy: the document runs with FXM's origin.
        expect(await frame.evaluate(() => self.origin)).toBe(new URL(baseURL as string).origin)
        expect(
          await frame.evaluate(
            (marker) => document.documentElement.hasAttribute(marker),
            SANDBOX_MARKER,
          ),
          'the document script started listening',
        ).toBe(false)
        expect(await repliesTo(page, [{ type: 'ping' }, ...SANDBOX_MESSAGES])).toEqual([])
      } finally {
        await close()
      }
    })
  }

  test('eval.html evaluates a test function', async ({ page }) => {
    test.skip(!(await deployed(page, '/sandbox/eval')), 'no evaluator deployed yet (1.11)')
    test.fixme(true, '1.11 defines the evaluator protocol; its integration fills in this check')
  })
})
