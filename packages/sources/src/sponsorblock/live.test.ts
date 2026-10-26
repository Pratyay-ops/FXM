/**
 * Live checks against sponsor.ajay.app, three requests in all. They run only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/sponsorblock/live.test.ts
 * ```
 *
 * They check the protocol facts in `CLEAN-ROOM.md` and print none of SponsorBlock's data.
 */

import { describe, expect, it } from 'vitest'
import { createSponsorBlockClient, NON_MUSIC_CATEGORY, SPONSORBLOCK_ORIGIN } from './api'
import { contextFor } from './fixtures/testing'
import { hashPrefix } from './hash'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

/** Michael Jackson's "Thriller" short film, whose story parts are marked as non-music. */
const THRILLER = 'sOnqjkJTMaA'

/** Any page's origin: SponsorBlock answers them all. */
const ORIGIN = 'https://fxmusic.pages.dev'

describe.skipIf(!live)('SponsorBlock, live', { timeout: 30_000 }, () => {
  it('finds the non-music parts of a long music video by its hash prefix', async () => {
    const client = createSponsorBlockClient()
    const segments = await client.nonMusicSegments(
      THRILLER,
      contextFor(globalThis.fetch.bind(globalThis)),
    )
    expect(segments.length).toBeGreaterThan(0)
    for (const segment of segments) {
      expect(segment.endMs).toBeGreaterThan(segment.startMs)
      // The short film runs for about 13 minutes.
      expect(segment.videoDurationMs).toBeGreaterThan(600_000)
      expect(segment.endMs).toBeLessThanOrEqual(segment.videoDurationMs ?? 0)
    }
  })

  it('lets any web page ask, and answers in the documented shape', async () => {
    const prefix = await hashPrefix(THRILLER)
    const url = `${SPONSORBLOCK_ORIGIN}/api/skipSegments/${prefix}?category=${NON_MUSIC_CATEGORY}`
    const response = await fetch(url, { headers: { Origin: ORIGIN } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await response.json()) as { videoID: string; segments: unknown[] }[]
    expect(body.length).toBeGreaterThan(1)
    expect(body.every((entry) => typeof entry.videoID === 'string')).toBe(true)
    expect(body.find((entry) => entry.videoID === THRILLER)?.segments[0]).toMatchObject({
      category: NON_MUSIC_CATEGORY,
      actionType: 'skip',
      segment: [expect.any(Number), expect.any(Number)],
      UUID: expect.any(String),
      videoDuration: expect.any(Number),
    })
  })

  it('answers 404 with an empty list when no video of a prefix has segments', async () => {
    // A 32-character prefix that no video has: the endpoint takes 4 to 32 characters.
    const prefix = 'bde40d7ff0bd3b458a5e1103c6fc198a'
    const url = `${SPONSORBLOCK_ORIGIN}/api/skipSegments/${prefix}?category=${NON_MUSIC_CATEGORY}`
    const response = await fetch(url, { headers: { Origin: ORIGIN } })
    expect(response.status).toBe(404)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toEqual([])
  })
})
