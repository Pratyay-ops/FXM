import { expect, type Page, test } from '@playwright/test'
import {
  flacFile,
  mp3File,
  pngImage,
  wavFile,
} from '../src/features/local-files/testing/audio-files'

// Local files in a real browser: the folder picker is stubbed with a folder of the
// origin-private file system, a real FileSystemDirectoryHandle, filled with tiny generated
// files of silence. So music-metadata's browser build, the cover thumbnails (canvas), the
// handle kept in IndexedDB and playback from object URLs all run for real.

const COVER = { data: pngImage([40, 90, 200], 64), mime: 'image/png' }

const FILES: { path: string; bytes: Uint8Array }[] = [
  {
    path: 'Aria Vale/Neon Rivers/01 Night Drive.flac',
    bytes: flacFile({
      tags: { title: 'Night Drive', artists: ['Aria Vale'], album: 'Neon Rivers', track: 1 },
      picture: COVER,
      frames: 40,
    }),
  },
  {
    path: 'Aria Vale/Neon Rivers/02 Slow Tide.mp3',
    bytes: mp3File({
      tags: { title: 'Slow Tide', artists: ['Aria Vale'], album: 'Neon Rivers', track: 2 },
      frames: 160,
    }),
  },
  {
    path: 'Field Kit/Room Tone.wav',
    bytes: wavFile({ tags: { title: 'Room Tone', artists: ['Field Kit'] }, seconds: 4 }),
  },
]

/** Writes the files into a `Music` folder of the origin-private file system. */
async function fillMusicFolder(page: Page) {
  await page.goto('./')
  await page.evaluate(
    async (files) => {
      const root = await navigator.storage.getDirectory()
      const music = await root.getDirectoryHandle('Music', { create: true })
      for (const { path, bytes } of files) {
        const parts = path.split('/')
        const name = parts.pop() ?? path
        let dir = music
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
        await writable.write(new Uint8Array(bytes))
        await writable.close()
      }
    },
    FILES.map(({ path, bytes }) => ({ path, bytes: Array.from(bytes) })),
  )
}

test.beforeEach(async ({ page }) => {
  // The picker hands out the origin-private Music folder, as if the user had chosen it.
  await page.addInitScript(() => {
    Object.assign(window, {
      showDirectoryPicker: async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle('Music'),
    })
  })
})

function songs(page: Page) {
  return page.getByRole('list', { name: 'Songs in local files' })
}

async function playAndCheck(page: Page, title: string) {
  await songs(page)
    .getByRole('button', { name: `Play ${title}` })
    .click()
  await expect(songs(page).getByRole('button', { name: `Pause ${title}` })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(title)
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing')
}

test('adds a folder, reads its tags and covers, and plays FLAC, MP3 and WAV', async ({ page }) => {
  await fillMusicFolder(page)
  await page.goto('library?tab=local')
  await page.getByRole('main').getByRole('button', { name: 'Add a folder' }).click()

  await expect(songs(page).getByRole('listitem')).toHaveCount(3)
  const rows = songs(page).getByRole('listitem')
  await expect(rows.nth(0)).toContainText('Night Drive')
  await expect(rows.nth(0)).toContainText('Lossless')
  await expect(rows.nth(1)).toContainText('Slow Tide')
  await expect(rows.nth(1)).not.toContainText('Lossless')
  await expect(rows.nth(2)).toContainText('Room Tone')
  await expect(rows.nth(2)).toContainText('Lossless')
  // The embedded cover became a small thumbnail.
  await expect(rows.nth(0).locator('img')).toHaveAttribute(
    'src',
    /^data:image\/(webp|jpeg);base64,/,
  )

  await playAndCheck(page, 'Night Drive')
  await playAndCheck(page, 'Slow Tide')
  await playAndCheck(page, 'Room Tone')

  // The folder is kept: after a reload its songs are listed and play again.
  await page.reload()
  await expect(songs(page).getByRole('listitem')).toHaveCount(3)
  await expect(page.getByText(/^3 songs · updated/)).toBeVisible()
  await playAndCheck(page, 'Night Drive')
})

test('plays files chosen through the file input', async ({ page }) => {
  await page.goto('library?tab=local')
  await page
    .getByTestId('local-files-input')
    .first()
    .setInputFiles(
      FILES.map(({ path, bytes }) => ({
        name: path.split('/').pop() ?? path,
        mimeType: '',
        buffer: Buffer.from(bytes),
      })),
    )
  await expect(songs(page).getByRole('listitem')).toHaveCount(3)
  await expect(page.getByText('3 songs · until FXM reloads')).toBeVisible()
  await playAndCheck(page, 'Slow Tide')
})

test('shows local files in search', async ({ page }) => {
  await fillMusicFolder(page)
  await page.goto('library?tab=local')
  await page.getByRole('main').getByRole('button', { name: 'Add a folder' }).click()
  await expect(songs(page).getByRole('listitem')).toHaveCount(3)
  await page.goto('search?q=tide')
  const local = page.getByRole('list', { name: 'Songs on this device' })
  await expect(local.getByRole('listitem')).toHaveCount(1)
  await local.getByRole('button', { name: 'Play Slow Tide' }).click()
  await expect(local.getByRole('button', { name: 'Pause Slow Tide' })).toBeVisible()
})

test('fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await fillMusicFolder(page)
  await page.goto('library?tab=local')
  await page.getByRole('main').getByRole('button', { name: 'Add a folder' }).click()
  await expect(songs(page).getByRole('listitem')).toHaveCount(3)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBe(0)
})

test('captures screenshots', async ({ page }) => {
  test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 to capture')
  const capture = async (name: string) => {
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: `screenshots/local-files-${name}-${width}.png` })
    }
  }
  await fillMusicFolder(page)
  await page.goto('library?tab=local')
  await expect(
    page.getByRole('heading', { name: 'Play music files from this device' }),
  ).toBeVisible()
  await capture('empty')
  await page.getByRole('main').getByRole('button', { name: 'Add a folder' }).click()
  await expect(songs(page).getByRole('listitem')).toHaveCount(3)
  await songs(page).getByRole('button', { name: 'Play Slow Tide' }).click()
  await expect(songs(page).getByRole('button', { name: 'Pause Slow Tide' })).toBeVisible()
  await capture('songs')
  await page.goto('search?q=drive')
  await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible()
  await capture('search')
})
