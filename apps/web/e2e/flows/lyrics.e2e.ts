import { expect, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../../src/app/services/testing/fake-network'
import { FIXTURES, installFakeConnect, stubNetwork } from '../fake-services'
import {
  type MediaRecord,
  nowPlaying,
  titles,
  trackMediaElements,
  waitUntilPlaying,
} from '../playing'

// Synced lyrics while a song plays (stage 2.5 with stage 1.8's LRCLIB lyrics), in the Full tier:
// the current line follows the media element's position, and a tap on a line seeks there. LRCLIB
// answers with made-up synced lyrics timed for the tone the song streams as.

const GOOGLEVIDEO = 'rr1---sn-fxmfixture.googlevideo.com'
const TRACK_SECONDS = 40

/**
 * Synced lyrics as LRCLIB's `/api/get` answers, for whatever song is asked for (made up), with the
 * song's own duration: FXM trusts synced lyrics only when theirs fits the song's.
 */
function lyricsFor(title: string, artist: string, durationSeconds: number) {
  return {
    id: 1,
    trackName: title,
    artistName: artist,
    albumName: 'Fixture',
    duration: durationSeconds,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: [
      '[00:00.20]The first line starts at once',
      '[00:03.00]The second line, three seconds in',
      '[00:08.00]The third line waits a little longer',
      '[00:30.00]The last line, thirty seconds in',
    ].join('\n'),
  }
}

test('follows the song with synced lyrics, and seeks to a line', async ({ page }) => {
  const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(TRACK_SECONDS) })
  await stubNetwork(page, network)
  const lookups: string[] = []
  await page.route('https://lrclib.net/**', (route) => {
    const url = new URL(route.request().url())
    lookups.push(`${url.pathname}${url.search}`)
    const record = lyricsFor(
      url.searchParams.get('track_name') ?? '',
      url.searchParams.get('artist_name') ?? '',
      Number(url.searchParams.get('duration') ?? TRACK_SECONDS),
    )
    return route.fulfill({
      json: url.pathname === '/api/search' ? [record] : record,
      headers: { 'access-control-allow-origin': '*' },
    })
  })
  await trackMediaElements(page)
  await installFakeConnect(page)

  await page.goto('search?q=radiohead%20creep')
  const songs = page.getByRole('list', { name: 'Songs' })
  await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible()
  const [first] = await titles(page, 'Songs')
  await songs
    .getByRole('button', { name: /^Play / })
    .first()
    .click()
  await waitUntilPlaying(page, first, GOOGLEVIDEO)

  // Now playing, opened from the player bar while the song goes on: its lyrics show.
  await page
    .getByRole('region', { name: 'Player' })
    .getByRole('link', { name: /^Open now playing/ })
    .click()
  const line = (text: string) => page.getByRole('button', { name: text, exact: true })
  await expect(line('The second line, three seconds in')).toBeVisible({ timeout: 15_000 })
  // Looked up by the song's title, artist and duration.
  expect(lookups[0]).toMatch(/^\/api\/get\?.*duration=\d+/u)

  // The current line follows the media element's position: both read at the same moment.
  const sample = () =>
    page.evaluate(() => {
      const media = [...(window as unknown as MediaRecord).fxmMedia].find(
        (element) => !element.paused && element.currentTime > 0,
      )
      const current = document.querySelector('[role="tabpanel"] button[aria-current="true"]')
      return { line: current?.textContent?.trim() ?? null, at: media?.currentTime ?? null }
    })
  await expect
    .poll(
      async () => {
        const { line, at } = await sample()
        return line === 'The second line, three seconds in' && at !== null && at >= 3 && at < 8
      },
      { timeout: 15_000 },
    )
    .toBe(true)

  // A tap on a line seeks there, and the song plays on from it.
  await line('The last line, thirty seconds in').click()
  await expect(line('The last line, thirty seconds in')).toHaveAttribute('aria-current', 'true')
  await expect
    .poll(async () => (await nowPlaying(page)).currentTime ?? 0, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(30)
  await expect(line('The second line, three seconds in')).not.toHaveAttribute(
    'aria-current',
    'true',
  )
  expect((await nowPlaying(page)).title).toBe(first)
})
