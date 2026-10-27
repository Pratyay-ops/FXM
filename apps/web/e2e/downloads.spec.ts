import { expect, type Page, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../src/app/services/testing/fake-network'
import { FIXTURES, installFakeConnect, startRedirectTarget, stubNetwork } from './fake-services'

// Downloads (stage 4.1) through the app's real composition (src/app/services), in a real
// browser: the queue, the Origin Private File System and the providers run for real, and only
// the network is fake (fake-services.ts). Nothing reaches the internet.

/** Where each download stands, from the `fxm-downloads` database: its song and status. */
function downloads(page: Page): Promise<{ title: string; status: string; error?: string }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('fxm-downloads')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('downloads')) {
            db.close()
            resolve([])
            return
          }
          const read = db.transaction('downloads', 'readonly').objectStore('downloads').getAll()
          read.onerror = () => reject(read.error)
          read.onsuccess = () => {
            db.close()
            resolve(
              (read.result as Record<string, unknown>[]).map((record) => ({
                title: String((record.track as { title?: unknown } | undefined)?.title),
                status: String(record.status),
                ...(record.error === undefined
                  ? {}
                  : { error: String((record.error as { code?: unknown }).code) }),
              })),
            )
          }
        }
      }),
  )
}

/** A download's transfer of a YouTube song: googlevideo's bytes from the start of the file. */
function isTransfer(request: { url(): string; headers(): Record<string, string> }): boolean {
  return (
    new URL(request.url()).hostname.endsWith('.googlevideo.com') &&
    /^bytes=0-\d+$/u.test(request.headers().range ?? '')
  )
}

test('a YouTube download left unfinished continues when FXM Connect answers late', async ({
  context,
}) => {
  test.setTimeout(60_000)
  const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(1.5) })

  // The first visit: FXM Connect answers at once, and the download's transfer stalls, so the
  // tab closes with the download on its way.
  const first = await context.newPage()
  await installFakeConnect(first)
  await stubNetwork(first, network, { hold: isTransfer })
  await first.goto('search?q=radiohead%20creep')
  const more = first
    .getByRole('list', { name: 'Songs' })
    .getByRole('button', { name: /^More options for / })
    .first()
  await expect(more).toBeVisible({ timeout: 15_000 })
  const title = ((await more.getAttribute('aria-label')) ?? '').replace('More options for ', '')
  await more.click()
  await first.getByRole('menuitem', { name: 'Download' }).click()
  await expect
    .poll(() => downloads(first), { timeout: 15_000 })
    .toEqual([{ title, status: 'downloading' }])
  await first.close()

  // The next visit: FXM Connect's service worker wakes up slowly and answers after 1.5 s, past
  // the platform's 800 ms wait, so the platform first finds the Free tier. The queue waits for
  // the answer and continues the download, rather than failing it as one that can't be
  // downloaded here.
  const next = await context.newPage()
  await installFakeConnect(next, { pongDelayMs: 1500 })
  await stubNetwork(next, network)
  await next.goto('./')
  await expect
    .poll(() => downloads(next), { timeout: 30_000 })
    .toEqual([{ title, status: 'completed' }])
  // It is in the Downloads playlist, ready to play offline.
  await next.goto('library?tab=downloads')
  await expect(next.getByRole('list', { name: 'Songs in Downloads' })).toContainText(title)
})

test('a YouTube download that googlevideo moves to another server fails at once, asking to update an older FXM Connect', async ({
  page,
}) => {
  // googlevideo's cms_redirect, with FXM Connect 0.2.0's exact Access-Control-Allow-Origin: the
  // browser sends Origin: null after the redirect and refuses the answer. The download used to
  // stay at "Starting" for minutes. The fake FXM Connect is 0.1.0.
  const appOrigin = new URL(test.info().project.use.baseURL ?? 'http://localhost/').origin
  const audio = wavTone(1.5)
  const target = await startRedirectTarget(audio, appOrigin)
  try {
    const network = createFakeNetwork({
      fixtures: FIXTURES,
      audio,
      googlevideo: 'redirected',
      googlevideoAllowOrigin: appOrigin,
      googlevideoRedirectTo: target.origin,
    })
    await installFakeConnect(page)
    await stubNetwork(page, network)
    await page.goto('search?q=radiohead%20creep')
    const more = page
      .getByRole('list', { name: 'Songs' })
      .getByRole('button', { name: /^More options for / })
      .first()
    await expect(more).toBeVisible({ timeout: 15_000 })
    const title = ((await more.getAttribute('aria-label')) ?? '').replace('More options for ', '')
    await more.click()
    await page.getByRole('menuitem', { name: 'Download' }).click()
    await expect
      .poll(() => downloads(page), { timeout: 10_000 })
      .toEqual([{ title, status: 'failed', error: 'redirected' }])
    await page.goto('library?tab=downloads')
    await expect(
      page
        .getByText(
          'YouTube moved this download to another server that FXM Connect 0.1.0 can’t read. Update FXM Connect to 0.2.1',
        )
        .first(),
    ).toBeVisible()
  } finally {
    await target.close()
  }
})
