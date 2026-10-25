/**
 * Live checks against ListenBrainz's labs API, two requests. They run only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/listenbrainz/live.test.ts
 * ```
 */

import { describe, expect, it } from 'vitest'
import { liveTestsEnabled, testContext, withOrigin } from '../recommend/testing'
import { createListenBrainzClient } from './api'

describe.skipIf(!liveTestsEnabled())('ListenBrainz, live', { timeout: 30_000 }, () => {
  it('finds a recording’s artist, then similar artists, for any origin', async () => {
    const { fetch, records } = withOrigin(globalThis.fetch.bind(globalThis))
    const ctx = testContext({ fetch, tier: 'free' })
    const listenbrainz = createListenBrainzClient()
    const lookup = await listenbrainz.lookupRecording('Radiohead', 'Creep', ctx)
    expect(lookup).toMatchObject({
      artistCredit: 'Radiohead',
      artistMbids: ['a74b1b7f-71a5-4011-9441-d0b5e4122711'],
    })
    expect(lookup?.releaseMbid).toMatch(/^[0-9a-f-]{36}$/)
    const similar = await listenbrainz.similarArtists(lookup?.artistMbids[0] ?? '', ctx, {
      limit: 20,
    })
    expect(similar).toHaveLength(20)
    expect(similar[0]?.similarity).toBe(1)
    expect(similar.map((artist) => artist.name)).not.toContain('Radiohead')
    expect(records.map((record) => record.allowOrigin)).toEqual(['*', '*'])
  })
})
