/**
 * Live checks against musicbrainz.org, five requests in all, one per second at most. They run
 * only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/musicbrainz/live.test.ts
 * ```
 *
 * They act as the desktop app, which sends FXM's descriptive User-Agent.
 */

import { formatId, type ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { MUSICBRAINZ_USER_AGENT, MusicBrainzClient } from './api'
import { findExactIsrc, findIsrcHint } from './isrc'
import { RequestQueue } from './queue'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

const CREEP_SPOTIFY = '70LcF31zb1H0PyJoS1Sx1r'
const CREEP_ISRC = 'GBAYE9200070'
const CREEP_MBID = '70595637-9310-45f2-a266-58f8de4874a7'

describe.skipIf(!live)('MusicBrainz, live', { timeout: 60_000 }, () => {
  const queue = new RequestQueue(1000)
  const client = new MusicBrainzClient({ queue, maxAttempts: 5 })
  const ctx: ProviderContext = {
    fetch: globalThis.fetch.bind(globalThis),
    platform: 'desktop',
    capabilities: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: true },
    mode: 'music',
  }

  it('finds the ISRC of a Spotify track through its URL relationship (exact path)', async () => {
    const finding = await findExactIsrc(client, formatId('spotify', 'track', CREEP_SPOTIFY), ctx)
    expect(finding?.origin).toBe('musicbrainz-exact')
    expect(finding?.isrc).toBe(CREEP_ISRC)
    expect(finding?.isrcs).toContain(CREEP_ISRC)
    expect(finding?.recording.id).toBe(CREEP_MBID)
    expect(Math.abs((finding?.recording.lengthMs ?? 0) - 238_640)).toBeLessThan(5_000)
  })

  it('finds the canonical recording by title, artist and duration (fuzzy path, a hint)', async () => {
    const finding = await findIsrcHint(
      client,
      { title: 'Creep', artists: [{ name: 'Radiohead' }], durationMs: 238_640 },
      ctx,
    )
    expect(finding?.origin).toBe('musicbrainz-fuzzy')
    expect(finding?.isrcs).toContain(CREEP_ISRC)
  })

  it('looks recordings up by ISRC', async () => {
    const recordings = await client.lookupIsrc(CREEP_ISRC, ctx)
    expect(recordings.map((recording) => recording.id)).toContain(CREEP_MBID)
  })

  it('lets any web page read its answers', async () => {
    const response = await queue.run(() =>
      fetch(`https://musicbrainz.org/ws/2/isrc/${CREEP_ISRC}?fmt=json`, {
        headers: { Origin: 'https://fxmusic.pages.dev', 'User-Agent': MUSICBRAINZ_USER_AGENT },
      }),
    )
    await response.body?.cancel()
    expect([200, 503]).toContain(response.status)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})
