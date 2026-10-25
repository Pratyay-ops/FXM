/**
 * The Lite tier against the real YouTube, from a residential connection: FXM_LIVE=1 only. The
 * proxy tunnels InnerTube's hosts and googlevideo to the internet and still serves the FXM
 * origin (the harness and the sandbox documents) from this checkout; every other host stays
 * refused.
 *
 * - `FXM_LIVE=1`: the self-test, a YouTube Music search, one call each to `next` and `browse`,
 *   and a VISIONOS `/player` call through the sandbox, then a few seconds of `<audio>`. About five
 *   InnerTube calls per browser. Chromium must reach `playing`; the Firefox result is recorded.
 * - `FXM_LIVE=1 FXM_FULL_PLAYBACK=1`: one song played to its end in each browser (muted), the
 *   "manual test" whose results the README records.
 *
 * Each run attaches its findings as `lite-live.json` and prints them.
 */

import { expect, type Harness, test } from './fixtures.ts'
import type { Rung, RungResult } from './harness/harness.ts'

const LIVE = process.env.FXM_LIVE === '1'
const FULL = process.env.FXM_FULL_PLAYBACK === '1'
/** A short, well-known song, so the full-length run takes about two minutes per browser. */
const QUERY = process.env.FXM_LIVE_QUERY ?? 'Ramones Blitzkrieg Bop'

/** YouTube Music's web client, as stage 1.3's `youtube-config.json` has it (2026-10-25). */
const WEB_REMIX = { clientName: 'WEB_REMIX', clientVersion: '1.20261020.10.00', hl: 'en' }
/** The songs filter of a YouTube Music search (1.3's config). */
const SONGS = 'EgWKAQIIAWoQEBAQCRAEEAMQBRAKEBUQEQ%3D%3D'
/** VISIONOS, as youtubei.js 18.1.0 presents it (CLEAN-ROOM.md). */
const VISIONOS: Rung = {
  name: 'VISIONOS',
  url: 'https://www.youtube.com/youtubei/v1/player',
  client: {
    clientName: 'VISIONOS',
    clientVersion: '1.02',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice17,1',
    osName: 'visionOS',
    osVersion: '26.5.23O471',
    hl: 'en',
  },
  pick: 'audio',
}

/** The first value of `key` anywhere in `value`, depth first. */
function findFirst(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirst(item, key)
      if (found !== undefined) return found
    }
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    if (key in record) return record[key]
    for (const item of Object.values(record)) {
      const found = findFirst(item, key)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** One InnerTube call through the sandbox, summed up for the record. */
async function call(harness: Harness, url: string, fields: Record<string, unknown>) {
  const result = await harness.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: WEB_REMIX }, ...fields }),
  })
  if (!result.ok) return { summary: `failed: ${result.error.message}`, json: undefined }
  let json: unknown
  try {
    json = JSON.parse(result.text)
  } catch {
    json = undefined
  }
  return { summary: `${result.status}, ${result.text.length} characters`, json }
}

/** The song to play: the first song of a YouTube Music search, and the visitorData it issued. */
async function searchSong(harness: Harness) {
  const search = await call(harness, 'https://music.youtube.com/youtubei/v1/search', {
    query: QUERY,
    params: SONGS,
  })
  const videoId = findFirst(search.json, 'videoId')
  const visitorData = findFirst(search.json, 'visitorData')
  return {
    search: search.summary,
    videoId: typeof videoId === 'string' ? videoId : undefined,
    visitorData: typeof visitorData === 'string' ? visitorData : undefined,
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
    const song = await searchSong(harness)
    const record: Record<string, unknown> = {
      date: new Date().toISOString(),
      browser: `${browserName} ${browser.version()}`,
      selfTest: capabilities.youtube,
      query: QUERY,
      ...song,
    }
    if (song.videoId !== undefined) {
      const next = await call(harness, 'https://music.youtube.com/youtubei/v1/next', {
        videoId: song.videoId,
        playlistId: `RDAMVM${song.videoId}`,
        params: 'wAEB',
      })
      const browse = await call(harness, 'https://music.youtube.com/youtubei/v1/browse', {
        browseId: 'FEmusic_home',
      })
      record.next = next.summary
      record.browse = browse.summary
      record.rungs = await harness.resolveAndPlay({
        videoId: song.videoId,
        ...(song.visitorData === undefined ? {} : { visitorData: song.visitorData }),
        ladder: [VISIONOS],
        stallMs: 20_000,
        playMs: 3000,
      })
    }
    record.tunnelled = [
      ...new Set(
        network.log.filter((entry) => entry.decision === 'tunnelled').map((entry) => entry.host),
      ),
    ]
    record.budget = await harness.budget()
    await testInfo.attach('lite-live.json', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    })
    console.log(`lite-live ${JSON.stringify(record)}`)

    expect(capabilities.youtube).toBe('simple')
    expect(song.videoId).toBeDefined()
    if (browserName === 'chromium') {
      expect((record.rungs as RungResult[]).at(-1)?.outcome).toBe('playing')
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
    const song = await searchSong(harness)
    expect(song.videoId).toBeDefined()
    const started = Date.now()
    const rungs = await harness.resolveAndPlay({
      videoId: song.videoId as string,
      ...(song.visitorData === undefined ? {} : { visitorData: song.visitorData }),
      ladder: [VISIONOS],
      // A stall of a minute anywhere ends the run.
      stallMs: 60_000,
      playMs: 'end',
    })
    const record = {
      date: new Date().toISOString(),
      browser: `${browserName} ${browser.version()}`,
      selfTest: capabilities.youtube,
      query: QUERY,
      videoId: song.videoId,
      rungs,
      wallSeconds: Math.round((Date.now() - started) / 1000),
      budget: await harness.budget(),
    }
    await testInfo.attach('lite-live.json', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    })
    console.log(`lite-full ${JSON.stringify(record)}`)
    if (browserName === 'chromium') expect(rungs.at(-1)?.outcome).toBe('ended')
  })
})
