import { expect, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../../src/app/services/testing/fake-network'
import { HOME_FIXTURES, installFakeConnect, stubNetwork } from '../fake-services'
import { titles, trackMediaElements, waitUntilPlaying } from '../playing'

// Home (stage 3.3) on a first visit in the Full tier: it asks what the user likes, builds its
// shelves from the artists picked, with the recommendation sources of stage 3.2 answered from
// recorded fixtures (YouTube Music's artist search, Radiohead's artist page and radio; Last.fm's
// station and the rest find nothing), and plays from a shelf.

const GOOGLEVIDEO = 'rr1---sn-fxmfixture.googlevideo.com'

test("builds Home's shelves from the artists picked on a first visit, and plays from them", async ({
  page,
}) => {
  const network = createFakeNetwork({ fixtures: HOME_FIXTURES, audio: wavTone(30) })
  await stubNetwork(page, network)
  await trackMediaElements(page)
  await installFakeConnect(page)

  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'What do you like to listen to?' })).toBeVisible({
    timeout: 15_000,
  })
  const artist = page.getByRole('textbox', { name: 'Add an artist' })
  for (const name of ['Radiohead', 'Portishead', 'Massive Attack']) {
    await artist.fill(name)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Build my Home' }).click()

  // The shelves, from what the sources suggested for the picks.
  const quickPicks = page.getByRole('list', { name: 'Quick picks' })
  await expect(quickPicks.getByRole('button', { name: /^Play / }).first()).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('heading', { name: 'What do you like to listen to?' })).toHaveCount(0)
  const shelves = await page.getByRole('main').getByRole('heading', { level: 2 }).allTextContents()
  expect(shelves).toEqual(expect.arrayContaining(['Quick picks', 'Your artists']))
  // Radiohead, the one pick YouTube Music's artist search knows by that name, seeded its radio.
  const radios = network.requests.filter((request) => request.url.includes('/youtubei/v1/next'))
  expect(radios.map((request) => JSON.parse(request.body ?? '{}').playlistId)).toContain(
    'RDEMk8jEIzOyB2trfXZrSEVz_Q',
  )

  // A song from Quick picks plays, with the shelf as its queue.
  const [first] = await titles(page, 'Quick picks')
  await quickPicks
    .getByRole('button', { name: /^Play / })
    .first()
    .click()
  await waitUntilPlaying(page, first, GOOGLEVIDEO)
})
