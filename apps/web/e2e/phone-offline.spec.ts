import type { Page } from '@playwright/test'
import { createFakeNetwork } from '../src/app/services/testing/fake-network'
import { flacFile, wavFile } from '../src/features/local-files/testing/audio-files'
import { FIXTURES } from './fake-services'
import {
  expect,
  expectPlaysFromDevice,
  type Phone,
  PLAYED_SECONDS,
  test,
  waitForServiceWorker,
} from './phone'

// Music on a phone without a network, in Chromium as a Pixel 7 and in WebKit as an iPhone 15
// (e2e/phone.ts): a song downloaded from Internet Archive (stage 4.1) plays offline once the app
// shell (stage 5.1) is in, after a reload, from a new tab and after the browser itself restarts;
// and a music file added while offline (stage 4.4) plays too. Each phone has no FXM Connect, so
// it has the Free tier, where Internet Archive's songs download. The songs are silence the test
// makes, served by the fake network while the phone is online; offline, the test refuses every
// request that leaves the machine and the browser's own network is off, so whatever plays comes
// from the device.

/** How long the songs last: long enough to play {@link PLAYED_SECONDS} of, with room to spare. */
const SONG_SECONDS = 12

/** Internet Archive's FLAC files, as the fake network serves every one of them: silence. */
const FLAC = flacFile({ frames: Math.ceil((SONG_SECONDS * 44_100) / 4096) })

/** An audio file's path, such as Internet Archive's (its covers live beside them). */
const AUDIO_FILE = /\.(?:flac|mp3|ogg|oga|opus|wav|m4a|webm)$/iu

/** Home's heading, which shows once the app has rendered. */
const GREETING = /^Good (morning|afternoon|evening)$/u

/** What a download's record says, and the size of its file in the Origin Private File System. */
interface StoredDownload {
  title: string
  status: string
  container?: string
  bytes?: number
}

/** The downloads this browser keeps: records from `fxm-downloads`, files from the OPFS. */
function storedDownloads(page: Page): Promise<StoredDownload[]> {
  return page.evaluate(async () => {
    const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
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
          resolve(read.result as Record<string, unknown>[])
        }
      }
    })
    const folder = await (await navigator.storage.getDirectory())
      .getDirectoryHandle('downloads')
      .catch(() => undefined)
    const found: StoredDownload[] = []
    for (const record of records) {
      const file = typeof record.file === 'string' ? record.file : undefined
      const handle =
        file === undefined ? undefined : await folder?.getFileHandle(file).catch(() => undefined)
      const format = record.format as { container?: string } | undefined
      found.push({
        title: String((record.track as { title?: unknown } | undefined)?.title),
        status: String(record.status),
        ...(format?.container === undefined ? {} : { container: format.container }),
        ...(handle === undefined ? {} : { bytes: (await handle.getFile()).size }),
      })
    }
    return found
  })
}

/** Library › Downloads, the way a phone gets there: the tab bar's Library, then the tab. */
async function openLibraryDownloads(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click()
  await page.getByRole('tab', { name: 'Downloads' }).click()
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Plays `title` from the Downloads playlist the page shows, and waits until it plays. */
async function playDownload(page: Page, title: string) {
  const list = page.getByRole('list', { name: 'Songs in Downloads' })
  await list
    .getByRole('button', { name: new RegExp(`^Play ${escapeRegExp(title)}(?: by .+)?$`, 'u') })
    .click()
  return expectPlaysFromDevice(page, title)
}

/**
 * Downloads the first Internet Archive song of a search while the phone is online, and returns
 * its title once its file is on the device and it is in Library › Downloads.
 */
async function downloadSong(phone: Phone): Promise<string> {
  const { page } = phone
  phone.serve(createFakeNetwork({ fixtures: FIXTURES, audio: FLAC }))
  await page.goto('search?q=nine%20inch%20nails%20ghosts')
  // YouTube Music needs FXM Connect, which no phone has: the free sources it is.
  await page.getByRole('button', { name: 'Search Internet Archive instead' }).click()
  const more = page
    .getByRole('list', { name: 'Songs' })
    .getByRole('button', { name: /^More options for / })
    .first()
  await expect(more).toBeVisible({ timeout: 15_000 })
  const title = ((await more.getAttribute('aria-label')) ?? '').replace('More options for ', '')
  await more.click()
  await page.getByRole('menuitem', { name: 'Download' }).click()
  // The item's FLAC, byte for byte in the Origin Private File System.
  await expect
    .poll(() => storedDownloads(page), { timeout: 30_000 })
    .toEqual([{ title, status: 'completed', container: 'flac', bytes: FLAC.length }])
  await openLibraryDownloads(page)
  await expect(page.getByRole('list', { name: 'Songs in Downloads' })).toContainText(title)
  // The service worker has the shell by now: it controls the page once it is installed.
  await waitForServiceWorker(page)
  return title
}

/**
 * What the page asked of the network while the phone was offline: nothing for the audio, and
 * nothing a server answered (the shell came from the service worker, the rest failed). Returns
 * how the requests ended, by outcome, and the addresses of the ones that failed.
 */
async function expectNothingFromTheNetwork(
  phone: Phone,
): Promise<{ outcomes: Record<string, number>; failed: string[] }> {
  const offline = (await phone.settledRequests()).filter((request) => request.offline)
  const audio = offline.filter(
    (request) =>
      (request.resourceType === 'media' && request.outcome !== 'device') ||
      AUDIO_FILE.test(new URL(request.url).pathname),
  )
  expect(audio, 'requests for the audio while offline').toEqual([])
  expect(
    offline.filter((request) => request.outcome === 'network'),
    'requests the network answered while offline',
  ).toEqual([])
  const outcomes: Record<string, number> = {}
  for (const { outcome } of offline) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  const failed = offline
    .filter((request) => request.outcome === 'failed')
    .map(({ url }) => new URL(url).origin + new URL(url).pathname)
  return { outcomes, failed: [...new Set(failed)] }
}

/** Notes what a test saw in the report: what played, how far, and the requests while offline. */
function evidence(scenario: string, details: Record<string, unknown>): void {
  const line = JSON.stringify({ scenario, project: test.info().project.name, ...details })
  test.info().annotations.push({ type: 'evidence', description: line })
  console.log(`evidence ${line}`)
}

test('a downloaded song plays offline, in the shell the service worker serves', async ({
  phone,
}) => {
  test.slow()
  const title = await downloadSong(phone)
  const stored = await storedDownloads(phone.page)

  await phone.goOffline()
  const { page } = phone
  const shell = await page.goto('./')
  expect(shell?.fromServiceWorker()).toBe(true)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
  await openLibraryDownloads(page)
  const played = await playDownload(page, title)

  const requests = await expectNothingFromTheNetwork(phone)
  evidence('download offline after a reload', { title, stored, played, requests })
})

test('after a cold start offline, the app opens and the download still plays', async ({
  phone,
}) => {
  test.slow()
  const title = await downloadSong(phone)
  await phone.goOffline()

  // A new tab, offline: Home, then a deep link.
  await phone.page.close()
  const page = await phone.context.newPage()
  const home = await page.goto('./')
  expect(home?.fromServiceWorker()).toBe(true)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
  const deepLink = await page.goto('library?tab=downloads')
  expect(deepLink?.fromServiceWorker()).toBe(true)
  await expect(page.getByRole('tab', { name: 'Downloads' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const inNewTab = await playDownload(page, title)

  // The browser itself closes and starts again, like a phone reopening the app, offline from
  // its first request.
  const restarted = await phone.restart({ offline: true })
  const reopened = await restarted.goto('library?tab=downloads')
  expect(reopened?.fromServiceWorker()).toBe(true)
  const afterRestart = await playDownload(restarted, title)

  const requests = await expectNothingFromTheNetwork(phone)
  evidence('download offline after a cold start', { title, inNewTab, afterRestart, requests })
})

test('a music file added offline plays offline', async ({ phone }) => {
  test.slow()
  const { page } = phone
  const name = 'Offline Tone'
  const wav = wavFile({ tags: { title: name, artists: ['FXM Tests'] }, seconds: SONG_SECONDS })
  await page.goto('./')
  await waitForServiceWorker(page)

  await phone.goOffline()
  const shell = await page.goto('library?tab=local')
  expect(shell?.fromServiceWorker()).toBe(true)
  // Phones choose files (neither Android's nor iOS's browsers keep a folder): through the
  // browser's file chooser, which the test answers.
  const chooser = page.waitForEvent('filechooser')
  await page
    .getByRole('main')
    .getByRole('button', { name: /^Choose (music )?files$/ })
    .click()
  await (await chooser).setFiles({
    name: `${name}.wav`,
    mimeType: 'audio/wav',
    buffer: Buffer.from(wav),
  })
  const songs = page.getByRole('list', { name: 'Songs in local files' })
  await expect(songs.getByRole('listitem')).toHaveCount(1)
  await songs.getByRole('button', { name: `Play ${name}` }).click()
  const played = await expectPlaysFromDevice(page, name)

  const requests = await expectNothingFromTheNetwork(phone)
  evidence('local file offline', { name, bytes: wav.length, played, requests })
})
