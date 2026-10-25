/**
 * Browser checks of a deployment (docs/PLAN.md, stage 2.8), run against FXM_DEPLOY_URL by the
 * deploy workflow, or against `make dist` served like Cloudflare Pages on 127.0.0.1.
 *
 * - The pages and the app start under their policies, with no violation reported.
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
 * (SANDBOX_MARKER_ATTRIBUTE in packages/platform/src/sandbox). It tells a document that ignores
 * a message from one whose script never ran. 1.10's integration keeps the two in sync.
 */
const SANDBOX_MARKER = 'data-fxm-sandbox'

/** The InnerTube hosts innertube.html may reach, each answered by the test. */
const INNERTUBE_HOSTS = [
  'https://www.youtube.com',
  'https://music.youtube.com',
  'https://youtubei.googleapis.com',
]

/**
 * Opens a page on another origin that frames `path` without the sandbox attribute, and returns
 * the frame and a function that closes what it started.
 *
 * Against a deployment, the page is a made-up public site the test answers itself. Locally it
 * must be a real server: Chrome treats a page the test answers as public, and blocks a public
 * page from framing a local address (it shows its error page instead). So a server on the next
 * free port above the preview's (5801 and up, one per test worker) serves it as `localhost`,
 * another origin than `127.0.0.1`.
 */
async function frameFromElsewhere(
  page: Page,
  baseURL: string,
  path: string,
): Promise<{ frame: Frame; close: () => Promise<void> }> {
  const base = new URL(baseURL)
  const html = `<!doctype html><title>elsewhere</title><iframe src="${new URL(path, base)}"></iframe>`
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
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
  if (!frame) throw new Error('the page has no frame')
  await frame.waitForLoadState()
  return { frame, close }
}

/** Posts messages to the page's frame and returns whatever comes back within 1.5 s. */
async function repliesTo(page: Page, messages: readonly unknown[]): Promise<unknown[]> {
  return page.evaluate(async (messages) => {
    const target = document.querySelector('iframe')?.contentWindow
    const received: unknown[] = []
    addEventListener('message', (event) => received.push(event.data))
    for (const message of messages) target?.postMessage(message, '*')
    await new Promise((wait) => setTimeout(wait, 1500))
    return received
  }, messages)
}

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
        `/sandbox/${name}.html`,
      )
      try {
        // The document itself, after Pages' redirect to the extension-less path, not an error page.
        expect(frame.url()).toBe(new URL(`/sandbox/${name}`, baseURL).href)
        expect(await frame.evaluate(() => self.origin)).toBe('null')
        expect(
          await frame.evaluate(
            (marker) => document.documentElement.hasAttribute(marker),
            SANDBOX_MARKER,
          ),
          'the document script ran',
        ).toBe(true)
        // TODO(1.10 integration): post the transport's real request messages here.
        const replies = await repliesTo(page, [
          { type: 'ping' },
          { id: 1, method: 'POST', url: 'https://www.youtube.com/' },
        ])
        expect(replies).toEqual([])
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
      const { frame, close } = await frameFromElsewhere(page, baseURL as string, path)
      try {
        expect(frame.url()).toBe(new URL(path, baseURL).href)
        expect(await frame.title()).toMatch(/\S/)
        expect(
          await frame.evaluate(
            (marker) => document.documentElement.hasAttribute(marker),
            SANDBOX_MARKER,
          ),
          'the document script started listening',
        ).toBe(false)
        expect(await repliesTo(page, [{ type: 'ping' }])).toEqual([])
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
