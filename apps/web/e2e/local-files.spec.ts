import { expect, type Page, test } from '@playwright/test'
import { FILES, fillMusicFolder, songs, stubFolderPicker } from './local-files-fixture'

// Local files read and played in Chromium (see local-files-fixture.ts for how).

test.beforeEach(async ({ page }) => {
  await stubFolderPicker(page)
})

async function playAndCheck(page: Page, title: string) {
  await songs(page)
    .getByRole('button', { name: `Play ${title}` })
    .click()
  await expect(songs(page).getByRole('button', { name: `Pause ${title}` })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(title)
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing')
}

async function addTheFolder(page: Page) {
  await fillMusicFolder(page)
  await page.goto('library?tab=local')
  await page.getByRole('main').getByRole('button', { name: 'Add a folder' }).click()
  await expect(songs(page).getByRole('listitem')).toHaveCount(3)
}

test('adds a folder, reads its tags and covers, and plays FLAC, MP3 and WAV', async ({ page }) => {
  await addTheFolder(page)
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
  await addTheFolder(page)
  await page.goto('search?q=tide')
  const local = page.getByRole('list', { name: 'Songs on this device' })
  await expect(local.getByRole('listitem')).toHaveCount(1)
  await local.getByRole('button', { name: 'Play Slow Tide' }).click()
  await expect(local.getByRole('button', { name: 'Pause Slow Tide' })).toBeVisible()
})

test('fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await addTheFolder(page)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBe(0)
})
