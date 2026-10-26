import { createHash } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { createFakeNetwork } from '../../src/app/services/testing/fake-network'
import { flacFile } from '../../src/features/local-files/testing/audio-files'
import { FIXTURES, refuseLite, stubNetwork } from '../fake-services'
import { type MediaRecord, nowPlaying, trackMediaElements } from '../playing'

// A download in its original format (stage 4.1), in the Free tier, where Internet Archive's files
// can be downloaded: the item's FLAC file (served as a real FLAC stream of silence) lands in the
// Origin Private File System byte for byte, its record says FLAC, and the song then plays from
// that copy while Internet Archive no longer answers. Stage 4.2's conversions aren't released, so
// the original is the only format offered.

const FLAC = flacFile({ tags: { title: '1 Ghosts I', artists: ['Nine Inch Nails'] }, frames: 80 })
const SONG = '1 Ghosts I'

/** The downloads' records, from the `fxm-downloads` database: song, status and file format. */
function downloads(
  page: Page,
): Promise<{ title: string; status: string; codec?: string; container?: string }[]> {
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
              (read.result as Record<string, unknown>[]).map((record) => {
                const format = record.format as { codec?: string; container?: string } | undefined
                return {
                  title: String((record.track as { title?: unknown } | undefined)?.title),
                  status: String(record.status),
                  ...(format?.codec === undefined ? {} : { codec: format.codec }),
                  ...(format?.container === undefined ? {} : { container: format.container }),
                }
              }),
            )
          }
        }
      }),
  )
}

/** The files in the downloads folder of the Origin Private File System: size, SHA-256, magic. */
function storedFiles(page: Page): Promise<{ size: number; sha256: string; magic: string }[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle('downloads', { create: false })
    const files: { size: number; sha256: string; magic: string }[] = []
    for await (const handle of folder.values()) {
      if (handle.kind !== 'file') continue
      const bytes = new Uint8Array(
        await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer(),
      )
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      files.push({
        size: bytes.length,
        sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        magic: String.fromCharCode(...bytes.slice(0, 4)),
      })
    }
    return files
  })
}

test('downloads a song in its original format, and plays it from the device', async ({ page }) => {
  const network = createFakeNetwork({ fixtures: FIXTURES, audio: FLAC })
  await stubNetwork(page, network)
  // Lite's check fails, as where YouTube doesn't answer the sandbox document: the Free tier.
  await refuseLite(page)
  await trackMediaElements(page)

  await page.goto('search?q=nine%20inch%20nails%20ghosts')
  await page.getByRole('button', { name: 'Search Internet Archive instead' }).click()
  const songs = page.getByRole('list', { name: 'Songs' })
  const more = songs.getByRole('button', { name: `More options for ${SONG}`, exact: true })
  await expect(more).toBeVisible({ timeout: 15_000 })
  await more.click()
  await page.getByRole('menuitem', { name: 'Download' }).click()

  await expect
    .poll(() => downloads(page), { timeout: 30_000 })
    .toEqual([{ title: SONG, status: 'completed', codec: 'flac', container: 'flac' }])
  // The file is Internet Archive's FLAC as it was served, not a conversion.
  expect(await storedFiles(page)).toEqual([
    { size: FLAC.length, sha256: createHash('sha256').update(FLAC).digest('hex'), magic: 'fLaC' },
  ])

  // Internet Archive stops answering: the song plays from the copy on the device.
  await page.route('https://archive.org/download/**', (route) =>
    route.abort('internetdisconnected'),
  )
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click()
  await page.getByRole('tab', { name: 'Downloads' }).click()
  const list = page.getByRole('list', { name: 'Songs in Downloads' })
  await expect(list).toContainText(SONG)
  await list
    .getByRole('button', { name: new RegExp(`^Play ${SONG}`) })
    .first()
    .click()
  await expect
    .poll(async () => (await nowPlaying(page)).url?.startsWith('blob:') ?? false, {
      timeout: 15_000,
    })
    .toBe(true)
  expect((await nowPlaying(page)).title).toBe(SONG)
  // Its position moves on.
  const start = (await nowPlaying(page)).currentTime ?? 0
  await expect
    .poll(async () => (await nowPlaying(page)).currentTime ?? 0)
    .toBeGreaterThan(start + 1)
  expect(
    await page.evaluate(() =>
      [...(window as unknown as MediaRecord).fxmMedia].some((media) =>
        media.currentSrc.startsWith('https://archive.org/'),
      ),
    ),
  ).toBe(false)
})
