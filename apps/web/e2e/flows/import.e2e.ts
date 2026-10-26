import { expect, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../../src/app/services/testing/fake-network'
import { FIXTURES, installFakeConnect, stubNetwork } from '../fake-services'
import { listed } from '../playing'

// An M3U playlist imported (stage 3.6) in the Full tier: the playlist is created, its songs are
// matched on YouTube Music in the background (every search answers with the recorded "radiohead
// creep" results), and the match report waits for the user, since Auto matching is off: the sure
// match is confirmed in one tap and lands in the playlist, and the song nothing matches is
// skipped.

const PLAYLIST = 'Road trip'

/** An extended M3U file, as music players export one: a length and "Artist - Title" per song. */
const M3U = [
  '#EXTM3U',
  '#EXTINF:238,Radiohead - Creep',
  'Music/Radiohead/Pablo Honey/02 Creep.mp3',
  '#EXTINF:301,The Imaginary Band - A Song Nobody Ever Wrote',
  'Music/The Imaginary Band/Nowhere/01 A Song Nobody Ever Wrote.mp3',
  '',
].join('\n')

test('imports an M3U playlist, matches its songs and keeps what the user confirms', async ({
  page,
}) => {
  const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(2) })
  await stubNetwork(page, network)
  await installFakeConnect(page)

  await page.goto('import')
  await page.getByRole('tab', { name: 'Playlist file' }).click()
  await page.getByLabel('Choose a CSV or M3U file').setInputFiles({
    name: `${PLAYLIST}.m3u`,
    mimeType: 'audio/x-mpegurl',
    buffer: Buffer.from(M3U),
  })
  await expect(page.getByRole('textbox', { name: 'Playlist name' })).toHaveValue(PLAYLIST)
  await page.getByRole('button', { name: 'Start import' }).click()

  // The playlist exists at once; its songs are matched in the background.
  const sidebar = page.getByRole('region', { name: 'Your playlists' })
  await expect(sidebar.getByRole('link', { name: new RegExp(`^${PLAYLIST}`) })).toBeVisible()
  // Once matched, the import's card leads to its songs to review.
  const review = page.getByRole('link', {
    name: new RegExp(`^(Review \\d+ songs?|Match report) of ${PLAYLIST}$`, 'u'),
  })
  await expect(review).toBeVisible({ timeout: 30_000 })
  await review.click()
  await expect(page.getByRole('heading', { name: 'Match report' })).toBeVisible()

  // The sure match waits for one tap.
  const confirm = page.getByRole('button', { name: 'Confirm 1 likely match' })
  await expect(confirm).toBeVisible({ timeout: 30_000 })
  await confirm.click()
  await expect(page.getByText('Confirmed 1 likely match.')).toBeVisible()

  // Nothing matches the other song: it is skipped, and the report counts it so.
  await page.getByRole('button', { name: 'Skip A Song Nobody Ever Wrote' }).click()
  await expect(page.getByText('Skipped “A Song Nobody Ever Wrote”')).toBeVisible()
  await expect(
    page.getByRole('listitem').filter({
      has: page.getByRole('button', { name: 'Undo: A Song Nobody Ever Wrote' }),
    }),
  ).toContainText('A Song Nobody Ever Wrote · Skipped')
  await expect(page.getByText(/\b1 song skipped\b/u)).toBeVisible()

  // YouTube Music was searched for both songs, and the playlist holds the confirmed one.
  const searches = network.requests.filter((request) => request.url.includes('/youtubei/v1/search'))
  expect(searches.length).toBeGreaterThanOrEqual(2)
  await sidebar.getByRole('link', { name: new RegExp(`^${PLAYLIST}`) }).click()
  await expect.poll(() => listed(page, `Songs in ${PLAYLIST}`)).toEqual(['Creep'])
})
