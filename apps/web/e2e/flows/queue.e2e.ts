import { expect, type Page, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../../src/app/services/testing/fake-network'
import { FIXTURES, installFakeConnect, stubNetwork } from '../fake-services'
import { nowPlaying, titles, trackMediaElements, waitUntilPlaying } from '../playing'

// The queue while music plays, in the Full tier (a fake FXM Connect): Next and Previous in the
// player bar, Previous restarting a song once it is more than 3 s in, and a song moved to the top
// of the queue playing next. Every song streams from the fake googlevideo host as a tone long
// enough that none ends by itself meanwhile; what plays is read from the media elements.

const GOOGLEVIDEO = 'rr1---sn-fxmfixture.googlevideo.com'
const TRACK_SECONDS = 30

/** The titles of the songs up next, in order. */
function upNext(page: Page): Promise<string[]> {
  return page
    .getByRole('region', { name: 'Next up' })
    .getByRole('listitem')
    .locator('span.truncate.font-semibold')
    .allTextContents()
}

test('plays the next and the previous song, and the queue in the order the user made', async ({
  page,
}) => {
  const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
  await stubNetwork(page, network)
  await trackMediaElements(page)
  await installFakeConnect(page)

  await page.goto('search?q=radiohead%20creep')
  const songs = page.getByRole('list', { name: 'Songs' })
  await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible()
  const results = await titles(page, 'Songs')
  expect(results.length).toBeGreaterThanOrEqual(4)
  const [first, second] = results
  await songs
    .getByRole('button', { name: /^Play / })
    .first()
    .click()
  await waitUntilPlaying(page, first, GOOGLEVIDEO)

  const player = page.getByRole('region', { name: 'Player' })
  await player.getByRole('button', { name: 'Next' }).click()
  await waitUntilPlaying(page, second, GOOGLEVIDEO)

  // Previous at the start of a song goes back to the song before it.
  await player.getByRole('button', { name: 'Previous' }).click()
  await waitUntilPlaying(page, first, GOOGLEVIDEO)

  // More than 3 s in, Previous starts the same song again.
  await expect
    .poll(async () => (await nowPlaying(page)).currentTime ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(3.5)
  await player.getByRole('button', { name: 'Previous' }).click()
  await expect
    .poll(async () => {
      const now = await nowPlaying(page)
      return now.title === first && now.currentTime !== null && now.currentTime < 3
    })
    .toBe(true)

  // The queue, opened from the player bar while the music goes on: a song from the end of the
  // songs up next (one whose title no other result has) moves to the top from the keyboard, and
  // Next plays it.
  await player.getByRole('link', { name: 'Queue' }).click()
  const queued = results.slice(1)
  await expect.poll(() => upNext(page)).toEqual(queued)
  const moved = queued.findLast(
    (title, index) => index > 0 && results.filter((other) => other === title).length === 1,
  )
  if (moved === undefined) throw new Error('No song up next has a title of its own')
  await page.getByRole('button', { name: `Move ${moved}`, exact: true }).focus()
  await page.keyboard.press('Home')
  await expect
    .poll(() => upNext(page))
    .toEqual([moved, ...queued.filter((title) => title !== moved)])
  expect((await nowPlaying(page)).title).toBe(first)

  await player.getByRole('button', { name: 'Next' }).click()
  const url = await waitUntilPlaying(page, moved, GOOGLEVIDEO)
  // It played from its own /player answer.
  expect(network.players).toContain(url.searchParams.get('id'))
})
