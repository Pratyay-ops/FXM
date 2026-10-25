/**
 * Browser checks of a deployment (docs/PLAN.md, stage 2.8), run against FXM_DEPLOY_URL by the
 * deploy workflow, or against `make dist` served like Cloudflare Pages on 127.0.0.1.
 *
 * - The pages and the app start under their policies, with no violation reported.
 * - googlevideo requests from the app (and the embed, once 5.2 ships it) carry no Referer.
 * - The sandbox documents (1.10) are opaque however they are loaded, reach only their hosts,
 *   and ignore a page on another origin that frames them without the sandbox attribute.
 *
 * Requests to googlevideo, YouTube and the stand-in third-party site are answered by the test
 * itself, so nothing here contacts YouTube.
 */
import { expect, type Page, type Request, test } from '@playwright/test'

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

for (const path of ['/app/', '/embed/']) {
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

test.describe('sandbox documents', () => {
  test('innertube.html is opaque and reaches only its three hosts', async ({ page }) => {
    test.skip(
      !(await deployed(page, '/sandbox/innertube')),
      'no sandbox documents deployed yet (1.10)',
    )
    await page.route('https://www.youtube.com/**', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': 'null' },
        body: '{}',
      }),
    )
    await page.goto('/sandbox/innertube.html')
    const result = await page.evaluate(async () => {
      const attempt = (url: string) =>
        fetch(url, { method: 'POST', body: '{}', credentials: 'omit' }).then(
          () => 'reached',
          () => 'blocked',
        )
      return {
        origin: self.origin,
        youtube: await attempt('https://www.youtube.com/youtubei/v1/search?prettyPrint=false'),
        elsewhere: await attempt('https://example.com/'),
      }
    })
    expect(result).toEqual({ origin: 'null', youtube: 'reached', elsewhere: 'blocked' })
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
      const base = new URL(baseURL as string)
      // Another origin, on the same scheme so the frame isn't blocked as mixed content.
      const other = `${base.protocol}//fxm-check.example/`
      await page.route(other, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><iframe src="${new URL(`/sandbox/${name}.html`, base)}"></iframe>`,
        }),
      )
      await page.goto(other)
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
      expect(frame).toBeDefined()
      await frame?.waitForLoadState()
      expect(await frame?.evaluate(() => self.origin)).toBe('null')
      // TODO(1.10 integration): post the transport's real request messages here.
      const replies = await page.evaluate(async () => {
        const target = document.querySelector('iframe')?.contentWindow
        const received: unknown[] = []
        addEventListener('message', (event) => received.push(event.data))
        for (const message of [
          { type: 'ping' },
          { id: 1, method: 'POST', url: 'https://www.youtube.com/' },
        ]) {
          target?.postMessage(message, '*')
        }
        await new Promise((wait) => setTimeout(wait, 1500))
        return received
      })
      expect(replies).toEqual([])
    })
  }

  test('eval.html evaluates a test function', async ({ page }) => {
    test.skip(!(await deployed(page, '/sandbox/eval')), 'no evaluator deployed yet (1.11)')
    test.fixme(true, '1.11 defines the evaluator protocol; its integration fills in this check')
  })
})
