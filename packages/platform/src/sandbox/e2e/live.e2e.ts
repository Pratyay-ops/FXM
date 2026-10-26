/**
 * The Lite tier against the real YouTube, from a residential connection: FXM_LIVE=1 only. The
 * proxy tunnels InnerTube's hosts and googlevideo to the internet and still serves the FXM
 * origin (the harness and the sandbox documents) from this checkout; every other host stays
 * refused.
 *
 * Both tests play a song as the app will: stage 1.3's YouTube Music search, then stage 1.4's
 * stream resolver (its VISIONOS `/player` request, its formats, and core's `pickStream`), all
 * through the platform's `fetch` and so through the sandbox (`fxmHarness.playSong`).
 *
 * - `FXM_LIVE=1`: the self-test, the search, the resolver's calls (a search suggestion that
 *   gets the session a visitorData, then `/player`), then a few seconds of `<audio>`: about four
 *   InnerTube calls per browser. Chromium must reach `playing`; the Firefox result is recorded.
 * - `FXM_LIVE=1 FXM_FULL_PLAYBACK=1`: the same, played to its end in each browser (muted), the
 *   "manual test" whose results the README records.
 *
 * Each run attaches its findings as `lite-live.json` and prints them. The record holds no URL,
 * visitorData or host name: run output ends up in reports and issues.
 */

import { expect, test } from './fixtures.ts'
import { INNERTUBE_HOSTS, type TestNetwork } from './network.ts'

const LIVE = process.env.FXM_LIVE === '1'
const FULL = process.env.FXM_FULL_PLAYBACK === '1'
/** A short, well-known song, so the full-length run takes about two minutes per browser. */
const QUERY = process.env.FXM_LIVE_QUERY ?? 'Ramones Blitzkrieg Bop'

/** How many connections the proxy tunnelled, per kind of host: counts, never host names. */
function tunnelled(network: TestNetwork) {
  const hosts = network.log
    .filter((entry) => entry.decision === 'tunnelled')
    .map((entry) => entry.host)
  return {
    innertube: hosts.filter((host) => INNERTUBE_HOSTS.includes(host)).length,
    googlevideo: hosts.filter((host) => host.endsWith('.googlevideo.com')).length,
  }
}

test.describe('live', () => {
  test.skip(!LIVE, 'Live test: run with FXM_LIVE=1, from a residential connection')

  test('a YouTube Music search and a VISIONOS /player call through the sandbox, then <audio>', async ({
    harness,
    network,
    browser,
    browserName,
  }, testInfo) => {
    test.skip(FULL, 'FXM_FULL_PLAYBACK=1 runs the full-length test only')
    test.setTimeout(120_000)
    network.state.mode = 'live'
    const capabilities = await harness.start()
    const song = await harness.playSong({ query: QUERY, stallMs: 20_000, playMs: 3000 })
    const record = {
      date: new Date().toISOString(),
      browser: `${browserName} ${browser.version()}`,
      selfTest: capabilities.youtube,
      query: QUERY,
      song,
      tunnelled: tunnelled(network),
      budget: await harness.budget(),
    }
    await testInfo.attach('lite-live.json', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    })
    console.log(`lite-live ${JSON.stringify(record)}`)

    expect(capabilities.youtube).toBe('simple')
    expect(song.songs).toBeGreaterThan(0)
    if (browserName === 'chromium') {
      expect(song).toMatchObject({ rung: 'visionos', outcome: 'playing' })
    }
  })

  test('full-length Lite playback of one song (FXM_FULL_PLAYBACK=1)', async ({
    harness,
    network,
    browser,
    browserName,
  }, testInfo) => {
    test.skip(!FULL, 'Full-length playback: run with FXM_LIVE=1 FXM_FULL_PLAYBACK=1')
    test.setTimeout(15 * 60_000)
    network.state.mode = 'live'
    const capabilities = await harness.start()
    const started = Date.now()
    // A stall of a minute anywhere ends the run.
    const song = await harness.playSong({ query: QUERY, stallMs: 60_000, playMs: 'end' })
    const record = {
      date: new Date().toISOString(),
      browser: `${browserName} ${browser.version()}`,
      selfTest: capabilities.youtube,
      query: QUERY,
      song,
      wallSeconds: Math.round((Date.now() - started) / 1000),
      tunnelled: tunnelled(network),
      budget: await harness.budget(),
    }
    await testInfo.attach('lite-live.json', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    })
    console.log(`lite-full ${JSON.stringify(record)}`)
    if (browserName === 'chromium') expect(song.outcome).toBe('ended')
  })
})
