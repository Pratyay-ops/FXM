import { expect, type Page, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../../src/app/services/testing/fake-network'
import { FIXTURES, fixture, installFakeConnect, stubNetwork } from '../fake-services'
import { titles, trackMediaElements, waitUntilPlaying } from '../playing'

// YouTube Music through the stream ladder (stages 1.4 and 2.3): the top rung (VISIONOS) serves
// capped URLs, as googlevideo caps some, and the lifecycle falls back to the ANDROID client's
// itag 18, which plays. In the Full tier (a fake FXM Connect, so googlevideo's bytes are
// readable) the end-of-file probe finds the cap before anything plays; in the Lite tier, with the
// deployed sandbox document, nothing can read the bytes, so the media element's first request is
// the probe. Each client's `/player` answer is a recorded one.

const GOOGLEVIDEO = 'rr1---sn-fxmfixture.googlevideo.com'

/** The fake network, with ANDROID's recorded `/player` answer (itag 18) next to VISIONOS's. */
function ladderNetwork() {
  return createFakeNetwork({
    fixtures: {
      ...FIXTURES,
      players: { ANDROID: fixture('youtube/stream/fixtures/android-song.json') },
    },
    audio: wavTone(20),
  })
}

/** Plays the first song of a YouTube Music search, and returns its title. */
async function playFirstSong(page: Page): Promise<string | undefined> {
  await page.goto('search?q=radiohead%20creep')
  const songs = page.getByRole('list', { name: 'Songs' })
  await expect(songs.getByRole('button', { name: /^Play / }).first()).toBeVisible({
    timeout: 15_000,
  })
  const [first] = await titles(page, 'Songs')
  await songs
    .getByRole('button', { name: /^Play / })
    .first()
    .click()
  return first
}

/** The clients whose `/player` InnerTube was asked, in order. */
function playerClients(network: ReturnType<typeof ladderNetwork>): string[] {
  return network.requests
    .filter((request) => request.url.includes('/youtubei/v1/player'))
    .map((request) => JSON.parse(request.body ?? '{}').context?.client?.clientName)
}

test('falls back to itag 18 in Full when the end-of-file probe finds the top rung capped', async ({
  page,
}) => {
  const network = ladderNetwork()
  await stubNetwork(page, network)
  // VISIONOS's URLs are capped: googlevideo answers past their first bytes with 403, which FXM
  // Connect lets the page read. A media element's request from the start would still pass.
  const capped: string[] = []
  await page.route(/^https:\/\/[^/]+\.googlevideo\.com\/videoplayback\?/u, (route) => {
    const request = route.request()
    const itag = new URL(request.url()).searchParams.get('itag')
    if (itag === '18' || !/^bytes=[1-9]\d*-/u.test(request.headers().range ?? '')) {
      return route.fallback()
    }
    capped.push(itag ?? '')
    return route.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*' } })
  })
  await trackMediaElements(page)
  await installFakeConnect(page)

  const first = await playFirstSong(page)

  const url = await waitUntilPlaying(page, first, GOOGLEVIDEO, 20_000)
  expect(url.searchParams.get('itag')).toBe('18')
  // VISIONOS's probes met the cap, so its URLs never reached the player; ANDROID's itag 18 passed
  // its own probe first: one byte for its length, then its last bytes.
  expect(capped.length).toBeGreaterThan(0)
  expect(playerClients(network).slice(0, 2)).toEqual(['VISIONOS', 'ANDROID'])
  const itag18 = network.requests.filter(
    (request) => request.url.includes('itag=18') && request.headers.range !== undefined,
  )
  expect(itag18.map((request) => request.headers.range)).toContain('bytes=0-0')
})

test('falls back to itag 18 in Lite when the top rung’s URL is capped', async ({ page }) => {
  const network = ladderNetwork()
  await stubNetwork(page, network)
  // VISIONOS's audio-only URLs refuse the media element, as a capped URL does past its cap.
  const capped: string[] = []
  await page.route(/^https:\/\/[^/]+\.googlevideo\.com\/videoplayback\?/u, (route) => {
    const itag = new URL(route.request().url()).searchParams.get('itag')
    if (itag === '18') return route.fallback()
    capped.push(itag ?? '')
    return route.fulfill({ status: 403, body: '' })
  })
  await trackMediaElements(page)

  const first = await playFirstSong(page)

  const url = await waitUntilPlaying(page, first, GOOGLEVIDEO, 20_000)
  expect(url.searchParams.get('itag')).toBe('18')
  // The top rung was tried first, and its URL refused; then ANDROID's /player answered.
  expect(capped.length).toBeGreaterThan(0)
  expect(playerClients(network).slice(0, 2)).toEqual(['VISIONOS', 'ANDROID'])
  // Lite: every InnerTube call came from the sandbox document's opaque origin, and nothing read
  // googlevideo's bytes (no end-of-file probe).
  const innerTube = network.requests.filter((request) => request.url.includes('/youtubei/v1/'))
  expect(innerTube.map((request) => request.headers.origin)).toEqual(innerTube.map(() => 'null'))
  expect(
    network.requests.filter((request) => /^bytes=\d+-\d+$/u.test(request.headers.range ?? '')),
  ).toEqual([])
})
