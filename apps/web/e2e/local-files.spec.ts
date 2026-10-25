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
  await expect(page.getByText('3 songs · until FXM reloads', { exact: true })).toBeVisible()
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

async function horizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

test('fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await addTheFolder(page)
  expect(await horizontalOverflow(page)).toBe(0)
})

for (const viewport of [
  { width: 320, height: 720 },
  { width: 375, height: 667 },
]) {
  test(`shows songs on the first screen of a ${viewport.width} × ${viewport.height} phone`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await addTheFolder(page)
    await page.reload()
    await expect(songs(page).getByRole('listitem')).toHaveCount(3)
    await page.evaluate(() => window.scrollTo(0, 0))
    const firstSong = await songs(page).getByRole('listitem').first().boundingBox()
    // The mini player's card, above the tab bar.
    const player = await page.getByRole('region', { name: 'Player' }).locator('> div').boundingBox()
    expect(firstSong).not.toBeNull()
    expect(player).not.toBeNull()
    expect((firstSong?.y ?? 0) + (firstSong?.height ?? 0)).toBeLessThanOrEqual(player?.y ?? 0)
    // The selected tab is scrolled into its row.
    const tab = await page.getByRole('tab', { name: 'Local files' }).boundingBox()
    expect(tab?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((tab?.x ?? 0) + (tab?.width ?? 0)).toBeLessThanOrEqual(viewport.width)
    expect(await horizontalOverflow(page)).toBe(0)
  })
}

test('keeps room for what a folder needs on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await addTheFolder(page)
  // A later visit in which the browser wants to ask before FXM reads the folder again.
  await page.addInitScript(() => {
    const handle = (globalThis as { FileSystemHandle?: { prototype: object } }).FileSystemHandle
    if (handle) Object.assign(handle.prototype, { queryPermission: async () => 'prompt' })
  })
  await page.reload()
  const status = page.getByText('FXM needs your permission to read this folder again')
  await expect(status).toBeVisible()
  expect((await status.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(200)
  const allow = page.getByRole('button', { name: 'Allow access: Music' })
  await expect(allow).toBeVisible()
  // The button sits under the text, not beside it.
  expect((await allow.boundingBox())?.y ?? 0).toBeGreaterThan((await status.boundingBox())?.y ?? 0)
  expect(await horizontalOverflow(page)).toBe(0)
})
