import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../../src/app/services/testing/fake-network'
import { FIXTURES, installFakeConnect, stubNetwork } from '../fake-services'
import { listed, titles, trackMediaElements, waitUntilPlaying } from '../playing'

// The library (stage 2.6) around a song that really played, in the Full tier: a like from the
// player bar, a new playlist from the song's menu, the play in Recently played, then a backup
// saved as a file and restored into another browser profile, which gets all three back.

const GOOGLEVIDEO = 'rr1---sn-fxmfixture.googlevideo.com'
const TRACK_SECONDS = 4
const PLAYLIST = 'Night drive'

/** The parts of a library backup this test reads (src/db/backup.ts). */
interface Backup {
  format: string
  tables: {
    tracks: { id: string; track: { title: string } }[]
    likes: unknown[]
    playlists: { name: string; trackIds?: string[]; items?: unknown[] }[]
    history: { trackId: string }[]
  }
}

test('likes, saves to a playlist and remembers a song, and a backup carries them to another profile', async ({
  page,
  browser,
}, testInfo) => {
  const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
  await stubNetwork(page, network)
  await trackMediaElements(page)
  await installFakeConnect(page)

  await page.goto('search?q=radiohead%20creep')
  const songs = page.getByRole('list', { name: 'Songs' })
  await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible()
  const [song, next] = await titles(page, 'Songs')
  if (song === undefined || next === undefined) throw new Error('The search found too few songs')
  await songs
    .getByRole('button', { name: /^Play / })
    .first()
    .click()
  await waitUntilPlaying(page, song, GOOGLEVIDEO)

  // A like from the player bar, while the song plays.
  const player = page.getByRole('region', { name: 'Player' })
  const like = player.getByRole('button', { name: 'Like' })
  await like.click()
  await expect(like).toHaveAttribute('aria-pressed', 'true')

  // A new playlist from the song's menu in the results.
  await songs
    .getByRole('button', { name: /^More options for / })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Add to playlist…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add to playlist' })
  await dialog.getByRole('textbox', { name: 'New playlist' }).fill(PLAYLIST)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('status').getByText(`Created ${PLAYLIST} with 1 song`)).toBeVisible()

  // The song ends and the next one starts: the play is in the history. Then the music stops.
  await waitUntilPlaying(page, next, GOOGLEVIDEO, 15_000)
  await player.getByRole('button', { name: 'Pause' }).click()

  const sidebar = page.getByRole('region', { name: 'Your playlists' })
  await sidebar.getByRole('link', { name: new RegExp(`^${PLAYLIST}`) }).click()
  await expect.poll(() => listed(page, `Songs in ${PLAYLIST}`)).toEqual([song])
  await sidebar.getByRole('link', { name: /^Liked songs/ }).click()
  await expect.poll(() => listed(page, 'Songs in Liked songs')).toEqual([song])
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click()
  await page.getByRole('tab', { name: 'Recently played' }).click()
  await expect(page.getByRole('list', { name: 'Recently played' })).toContainText(song)

  // A backup, saved as a file.
  await page.getByRole('main').getByRole('button', { name: 'Backup' }).click()
  const backupDialog = page.getByRole('dialog', { name: 'Back up your library' })
  const saving = page.waitForEvent('download')
  await backupDialog.getByRole('button', { name: 'Download backup' }).click()
  const download = await saving
  const file = testInfo.outputPath(download.suggestedFilename())
  await download.saveAs(file)
  expect(download.suggestedFilename()).toMatch(/\.json$/u)
  const backup = JSON.parse(readFileSync(file, 'utf8')) as Backup
  expect(backup.format).toBe('fxm-library-backup')
  const saved = backup.tables.tracks.find((record) => record.track.title === song)
  expect(saved).toBeDefined()
  expect(backup.tables.likes).toHaveLength(1)
  expect(backup.tables.playlists.map((playlist) => playlist.name)).toContain(PLAYLIST)
  expect(backup.tables.history.some((play) => play.trackId === saved?.id)).toBe(true)

  // Restored into another browser profile, which starts empty.
  const other = await browser.newContext({
    baseURL: testInfo.project.use.baseURL ?? '',
    serviceWorkers: 'block',
  })
  try {
    const restored = await other.newPage()
    await restored.goto('library')
    await expect(
      restored.getByRole('region', { name: 'Your playlists' }).getByRole('link', {
        name: new RegExp(`^${PLAYLIST}`),
      }),
    ).toHaveCount(0)
    await restored.getByRole('main').getByRole('button', { name: 'Backup' }).click()
    const restore = restored.getByRole('dialog', { name: 'Back up your library' })
    await restore.getByLabel('Choose a backup file').setInputFiles(file)
    await restore.getByRole('radio', { name: /Replace/ }).check()
    await restore.getByRole('button', { name: 'Replace my library' }).click()
    await expect(restored.getByText('Library replaced from the backup')).toBeVisible()

    const otherSidebar = restored.getByRole('region', { name: 'Your playlists' })
    await otherSidebar.getByRole('link', { name: new RegExp(`^${PLAYLIST}`) }).click()
    await expect.poll(() => listed(restored, `Songs in ${PLAYLIST}`)).toEqual([song])
    await otherSidebar.getByRole('link', { name: /^Liked songs/ }).click()
    await expect.poll(() => listed(restored, 'Songs in Liked songs')).toEqual([song])
    await restored.goto('library?tab=recent')
    await expect(restored.getByRole('list', { name: 'Recently played' })).toContainText(song)
  } finally {
    await other.close()
  }
})
