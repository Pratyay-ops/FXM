/**
 * Records the stream fixtures in this folder from YouTube and googlevideo, through the
 * resolver's own `/player` call, so that every fixture answers exactly the request the resolver
 * sends. It runs only with both `FXM_LIVE=1` and `FXM_RECORD=1`, makes 12 InnerTube requests
 * (one `sw.js_data` read and eleven `/player` calls) and 16 ranged GETs to googlevideo, and
 * overwrites the fixtures when Vitest updates snapshots:
 *
 * ```sh
 * FXM_LIVE=1 FXM_RECORD=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/fixtures/record -u
 * make format   # Biome formats the new JSON
 * ```
 *
 * Run it from a residential connection: datacenter IPs get bot checks. The live stream and the
 * scheduled one in `VIDEOS` change over time (see `PLAYER_RECORDINGS`).
 */

import { describe, expect, it } from 'vitest'
import { context, FULL } from '../../fixtures/testing'
import { createYouTubeSession } from '../../session'
import { recordPlayers, recordProbes } from './record'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const recording = env?.FXM_LIVE === '1' && env?.FXM_RECORD === '1'

describe.skipIf(!recording)('recording the stream fixtures', { timeout: 180_000 }, () => {
  it('records the /player responses and the probes', async () => {
    const ctx = context(fetch, { capabilities: FULL })
    const { raw, sanitized } = await recordPlayers(ctx, createYouTubeSession())
    for (const [name, json] of Object.entries(sanitized)) {
      await expect(`${JSON.stringify(json, null, 2)}\n`).toMatchFileSnapshot(`./${name}.json`)
    }
    const probes = {
      recorded: new Date().toISOString().slice(0, 10),
      note: "googlevideo's answers to ranged GETs of the URLs in the player fixtures, from Node on a residential connection. Bodies are not kept; 'bytes' is how many arrived.",
      answers: await recordProbes(ctx, raw),
    }
    await expect(`${JSON.stringify(probes, null, 2)}\n`).toMatchFileSnapshot('./probes.json')
  })
})
