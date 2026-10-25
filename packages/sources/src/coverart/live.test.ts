/**
 * Live checks against the Cover Art Archive, four requests counting redirects. They run only
 * with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/coverart/live.test.ts
 * ```
 */

import { describe, expect, it } from 'vitest'
import { liveTestsEnabled, testContext } from '../shared/fake-network'
import { createCoverArtClient } from './api'

/** Radiohead's "Pablo Honey" (UK CD), which has a front cover. */
const PABLO_HONEY = '07aab296-9a40-42a9-8d1f-6b06aa032e8a'
const ORIGIN = 'https://fxmusic.pages.dev'

describe.skipIf(!liveTestsEnabled())('Cover Art Archive, live', { timeout: 30_000 }, () => {
  it('lists a release’s front cover, with CORS on every redirect', async () => {
    // A browser checks CORS on each hop of a redirect, so follow them one by one.
    const hops: Array<{ status: number; allowOrigin: string | null }> = []
    let url = `https://coverartarchive.org/release/${PABLO_HONEY}`
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetch(url, { headers: { Origin: ORIGIN }, redirect: 'manual' })
      hops.push({
        status: response.status,
        allowOrigin: response.headers.get('access-control-allow-origin'),
      })
      const next = response.headers.get('location')
      await response.body?.cancel()
      if (response.status < 300 || response.status >= 400 || next === null) break
      url = new URL(next, url).href
    }
    expect(hops.at(-1)?.status).toBe(200)
    expect(hops.every((hop) => hop.allowOrigin === '*')).toBe(true)

    const artwork = await createCoverArtClient().releaseArtwork(PABLO_HONEY, testContext({ fetch }))
    expect(artwork.map((art) => art.width)).toEqual([250, 500, 1200])
    expect(artwork.every((art) => art.url.startsWith('https://coverartarchive.org/release/'))).toBe(
      true,
    )
  })
})
