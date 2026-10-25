/**
 * Live checks against iTunes Search, two requests (one to Apple's image server). They run only
 * with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/itunes/live.test.ts
 * ```
 */

import { describe, expect, it } from 'vitest'
import { liveTestsEnabled, testContext, withOrigin } from '../recommend/testing'
import { createItunesClient, itunesArtwork } from './api'
import { bestSong } from './match'

describe.skipIf(!liveTestsEnabled())('iTunes Search, live', { timeout: 30_000 }, () => {
  it('finds a song’s cover for any origin, in the sizes FXM offers', async () => {
    const { fetch, records } = withOrigin(globalThis.fetch.bind(globalThis))
    const itunes = createItunesClient()
    const songs = await itunes.searchSongs(
      'Daft Punk Get Lucky',
      testContext({ fetch, tier: 'free' }),
    )
    expect(records[0]?.allowOrigin).toBe('*')
    const song = bestSong(songs, { title: 'Get Lucky', artists: ['Daft Punk'] })
    expect(song?.artworkUrl).toBeDefined()
    const artwork = itunesArtwork(song?.artworkUrl ?? '')
    expect(artwork.map((art) => art.width)).toEqual([100, 300, 600])
    const largest = await globalThis.fetch(artwork[2]?.url ?? '', { method: 'HEAD' })
    expect(largest.status).toBe(200)
    expect(largest.headers.get('content-type')).toMatch(/^image\//)
  })
})
