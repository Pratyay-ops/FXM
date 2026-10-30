import { expect, type Page, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../src/app/services/testing/fake-network'
import {
  FIXTURES,
  installFakeConnect,
  installFakePickers,
  mp3Only,
  type PickerRecord,
  silentMp3,
  startRedirectTarget,
  storedDownloads,
  stubNetwork,
} from './fake-services'

// Downloads (stage 4.1) through the app's real composition (src/app/services), in a real
// browser: the queue, the Origin Private File System and the providers run for real, and only
// the network is fake (fake-services.ts). Nothing reaches the internet. Download opens the
// Download dialog, which asks for the format and where to save, then keeps the song in FXM and
// saves its file; Chromium's save and folder pickers are stood in for (`installFakePickers`), so
// no window opens.

/** A download's transfer of a YouTube song: googlevideo's bytes from the start of the file. */
function isTransfer(request: { url(): string; headers(): Record<string, string> }): boolean {
  return (
    new URL(request.url()).hostname.endsWith('.googlevideo.com') &&
    /^bytes=0-\d+$/u.test(request.headers().range ?? '')
  )
}

/** What the fake pickers recorded. */
function picked(page: Page): Promise<PickerRecord> {
  return page.evaluate(() => {
    const { fxmFiles, fxmPicks } = window as unknown as PickerRecord
    return { fxmFiles, fxmPicks }
  })
}

/** Searches Internet Archive for Nine Inch Nails' Ghosts, and returns its songs' menu buttons. */
async function archiveSongs(page: Page) {
  await page.goto('search?q=nine%20inch%20nails%20ghosts')
  await page.getByRole('button', { name: 'Search Internet Archive instead' }).click()
  const buttons = page.getByRole('list', { name: 'Songs' }).getByRole('button', {
    name: /^More options for /,
  })
  await expect(buttons.first()).toBeVisible({ timeout: 15_000 })
  return buttons
}

/** The title a song's menu button names. */
async function titleOf(button: ReturnType<Page['getByRole']>): Promise<string> {
  return ((await button.getAttribute('aria-label')) ?? '').replace('More options for ', '')
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
  await installFakePickers(first)
  await stubNetwork(first, network, { hold: isTransfer })
  await first.goto('search?q=radiohead%20creep')
  const more = first
    .getByRole('list', { name: 'Songs' })
    .getByRole('button', { name: /^More options for / })
    .first()
  await expect(more).toBeVisible({ timeout: 15_000 })
  const title = await titleOf(more)
  await more.click()
  await first.getByRole('menuitem', { name: 'Download' }).click()
  // The Download dialog: the original, whose file type only the download decides, so the save
  // picker opens once it is downloaded.
  const dialog = first.getByRole('dialog', { name: 'Download' })
  await expect(dialog.getByRole('radio', { name: 'Original' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Download' }).click()
  await expect(dialog.getByRole('button', { name: 'Downloading…' })).toBeDisabled()
  await expect
    .poll(() => storedDownloads(first), { timeout: 15_000 })
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
    .poll(() => storedDownloads(next), { timeout: 30_000 })
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
    // The Download dialog with the original: it downloads first, which fails here.
    await page
      .getByRole('dialog', { name: 'Download' })
      .getByRole('button', { name: 'Download' })
      .click()
    await expect
      .poll(() => storedDownloads(page), { timeout: 10_000 })
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

test('Download asks where to save with the save picker first, then downloads and saves the file', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await stubNetwork(page, createFakeNetwork({ fixtures: mp3Only(FIXTURES), audio: silentMp3() }))
  // No Lite: the Free tier, whatever serves the sandbox documents.
  await page.route('**/sandbox/**', (route) => route.abort('connectionrefused'))
  await installFakePickers(page)

  const more = (await archiveSongs(page)).first()
  const title = await titleOf(more)
  await more.click()
  await page.getByRole('menuitem', { name: 'Download' }).click()
  const dialog = page.getByRole('dialog', { name: 'Download' })
  await expect(dialog).toHaveAccessibleDescription(`“${title}”`)
  // MP3 from an MP3 source needs no conversion, and no ffmpeg core: FXM tags it itself.
  await dialog.getByRole('radio', { name: 'MP3 .mp3' }).check()
  await expect(dialog).toContainText('An MP3 from Internet Archive: MP3 (no conversion).')
  await dialog.getByRole('button', { name: 'Download' }).click()

  const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  await expect(page.getByText(new RegExp(`^Saved “${escaped}” as .+\\.mp3$`, 'u'))).toBeVisible({
    timeout: 30_000,
  })
  await expect(dialog).toBeHidden()
  const { fxmPicks, fxmFiles } = await picked(page)
  // Asked once, straight from the click, before anything was downloaded.
  expect(fxmPicks).toHaveLength(1)
  expect(fxmPicks[0]).toMatchObject({ picker: 'save', downloads: 0 })
  const [name] = Object.keys(fxmFiles)
  expect(name).toMatch(/ - .+\.mp3$/u)
  const file = fxmFiles[name ?? '']
  // FXM's ID3v2 tags, then the song.
  expect(file?.head.slice(0, 3)).toEqual([0x49, 0x44, 0x33])
  expect(file?.size).toBeGreaterThan(silentMp3().length)
  // The song stays downloaded in FXM: in Downloads, to play offline.
  expect(await storedDownloads(page)).toEqual([{ title, status: 'completed' }])
  await page.goto('library?tab=downloads')
  await expect(page.getByRole('list', { name: 'Songs in Downloads' })).toContainText(title)
})

test('Download all on a playlist asks for a folder once and saves every song there', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await stubNetwork(page, createFakeNetwork({ fixtures: mp3Only(FIXTURES), audio: silentMp3() }))
  await page.route('**/sandbox/**', (route) => route.abort('connectionrefused'))
  await installFakePickers(page)

  // Two of Ghosts' songs in a playlist.
  const songs = await archiveSongs(page)
  const titles = [await titleOf(songs.nth(0)), await titleOf(songs.nth(1))]
  await songs.nth(0).click()
  await page.getByRole('menuitem', { name: 'Add to playlist…' }).click()
  await page.getByRole('textbox', { name: 'New playlist' }).fill('Road trip')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText(/^Created Road trip/u)).toBeVisible()
  await songs.nth(1).click()
  await page.getByRole('menuitem', { name: 'Add to playlist…' }).click()
  await page
    .getByRole('list', { name: 'Your playlists' })
    .getByRole('button', { name: /Road trip/u })
    .click()
  await page.goto('library')
  await page
    .getByRole('main')
    .getByRole('link', { name: /Road trip/u })
    .first()
    .click()
  await expect(page.getByRole('list', { name: 'Songs in Road trip' })).toContainText(
    titles[1] ?? '',
  )

  await page.getByRole('main').getByRole('button', { name: 'More options for Road trip' }).click()
  await page.getByRole('menuitem', { name: 'Download all' }).click()
  const dialog = page.getByRole('dialog', { name: 'Download' })
  await expect(dialog).toHaveAccessibleDescription('“Road trip” · 2 songs')
  await expect(dialog).toContainText('FXM asks for a folder and saves each song there')
  // The original: Internet Archive's MP3, tagged by FXM, without the ffmpeg core.
  await dialog.getByRole('radio', { name: 'Original' }).check()
  await dialog.getByRole('button', { name: 'Download' }).click()

  await expect(page.getByText('Saved 2 songs to “Music”')).toBeVisible({ timeout: 60_000 })
  const { fxmPicks, fxmFiles } = await picked(page)
  expect(fxmPicks).toEqual([
    {
      picker: 'folder',
      options: { id: 'fxm-downloads', mode: 'readwrite', startIn: 'music' },
      downloads: 0,
    },
  ])
  const names = Object.keys(fxmFiles).sort()
  expect(names).toHaveLength(2)
  for (const name of names) {
    expect(name).toMatch(/\.mp3$/u)
    expect(fxmFiles[name]?.head.slice(0, 3)).toEqual([0x49, 0x44, 0x33])
  }
  // Both stay downloaded, in Downloads.
  const stored = await storedDownloads(page)
  expect(stored.map((record) => record.status)).toEqual(['completed', 'completed'])
  await page.goto('library?tab=downloads')
  const downloads = page.getByRole('list', { name: 'Songs in Downloads' })
  for (const title of titles) await expect(downloads).toContainText(title)
})
