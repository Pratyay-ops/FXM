/**
 * Live checks against Last.fm, two requests (three with an API key). They run only with
 * `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/lastfm/live.test.ts
 * FXM_LIVE=1 FXM_LASTFM_API_KEY=… scripts/run.sh pnpm exec vitest run packages/sources/src/lastfm/live.test.ts
 * ```
 *
 * A key is never committed: it comes from the environment.
 */

import { describe, expect, it } from 'vitest'
import { liveEnv, liveTestsEnabled, testContext, withOrigin } from '../shared/fake-network'
import { createLastfmApiClient } from './api'
import { createLastfmStations } from './station'

const apiKey = liveEnv('FXM_LASTFM_API_KEY')

describe.skipIf(!liveTestsEnabled())('Last.fm, live', { timeout: 30_000 }, () => {
  it('serves a similar-artists station with YouTube links, without CORS headers', async () => {
    const { fetch, records } = withOrigin(globalThis.fetch.bind(globalThis))
    const stations = createLastfmStations()
    const tracks = await stations.station(
      { type: 'similar', artist: 'Radiohead' },
      testContext({ fetch, tier: 'full' }),
    )
    expect(tracks.length).toBeGreaterThanOrEqual(10)
    const linked = tracks.filter((track) => track.youtubeId !== undefined)
    expect(linked.length).toBeGreaterThanOrEqual(tracks.length * 0.8)
    expect(new Set(tracks.map((track) => track.artists[0])).size).toBeGreaterThan(3)
    expect(tracks.every((track) => track.url.startsWith('https://www.last.fm/music/'))).toBe(true)
    // Only FXM Connect's rule (or a native app) lets the app read this answer.
    expect(records).toHaveLength(1)
    expect(records[0]?.allowOrigin).toBeNull()
  })

  it('answers any origin on its API, which needs a key', async () => {
    const response = await fetch(
      'https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=Radiohead&format=json',
      { headers: { Origin: 'https://fxmusic.pages.dev' } },
    )
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toMatchObject({ error: 6 })
  })

  it.skipIf(apiKey === undefined)('lists similar artists with an API key', async () => {
    const api = createLastfmApiClient({ apiKey: apiKey ?? '' })
    const artists = await api.similarArtists('Radiohead', testContext({ tier: 'free', fetch }), {
      limit: 10,
    })
    expect(artists.length).toBeGreaterThanOrEqual(5)
    expect(artists[0]?.match).toBeGreaterThan(0.5)
    expect(artists.every((artist) => artist.url.startsWith('https://www.last.fm/music/'))).toBe(
      true,
    )
  })
})
