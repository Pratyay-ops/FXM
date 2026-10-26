/**
 * A live check of the data export's MusicBrainz leg against musicbrainz.org: a constructed
 * export with two Spotify tracks goes through the parser and the import's MusicBrainz exact
 * path, two requests at one per second. It runs only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/import/live.test.ts
 * ```
 *
 * It acts as the desktop app, which sends FXM's descriptive User-Agent. YouTube Music, the
 * other half of matching, waits for the YouTube providers (stage 1.3).
 */

import type { EntityId, ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createMusicBrainzClient } from '../musicbrainz'
import { lookupOnMusicBrainz } from './lookup'
import { matchSourceOf } from './match'
import { parseSpotifyExport } from './spotify-export'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

describe.skipIf(!live)('imports, live', { timeout: 60_000 }, () => {
  it('fills a data-export row with its ISRC and length through MusicBrainz', async () => {
    const parsed = parseSpotifyExport([
      {
        name: 'Playlist1.json',
        text: JSON.stringify({
          playlists: [
            {
              name: 'Live check',
              items: [
                {
                  track: {
                    trackName: 'Creep',
                    artistName: 'Radiohead',
                    albumName: 'Pablo Honey',
                    trackUri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
                  },
                },
              ],
            },
          ],
        }),
      },
    ])
    const [row] = parsed.collections[0]?.rows ?? []
    expect(row?.durationMs).toBeUndefined()
    const ctx: ProviderContext = {
      fetch: globalThis.fetch.bind(globalThis),
      platform: 'desktop',
      capabilities: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: true },
      mode: 'music',
    }
    const lookups = await lookupOnMusicBrainz(
      createMusicBrainzClient({ maxAttempts: 5 }),
      [{ index: 0, trackId: row?.trackId as EntityId<'track'> }],
      ctx,
    )
    const lookup = lookups.get(0)
    expect(lookup).toMatchObject({
      source: 'musicbrainz',
      isrc: 'GBAYE9200070',
      isrcOrigin: 'musicbrainz-exact',
    })
    expect(Math.abs((lookup?.durationMs ?? 0) - 238_640)).toBeLessThan(5_000)
    // The matching engine then gets a length and a trusted ISRC: no no-duration mode.
    expect(matchSourceOf(row as never, lookup)).toMatchObject({
      isrc: 'GBAYE9200070',
      isrcOrigin: 'musicbrainz-exact',
      durationMs: lookup?.durationMs,
    })
  })
})
