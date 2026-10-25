/**
 * Live checks against lrclib.net, five requests in all. They run only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/lrclib/live.test.ts
 * ```
 *
 * They print nothing of the lyrics themselves.
 */

import { lineAt } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LRCLIB_CLIENT, LRCLIB_ORIGIN } from './api'
import { contextFor, creep } from './fixtures/testing'
import { createLrclibProvider } from './provider'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

describe.skipIf(!live)('LRCLIB, live', { timeout: 30_000 }, () => {
  const lyricsProvider = createLrclibProvider()
  const ctx = contextFor(globalThis.fetch.bind(globalThis))

  it("finds synced lyrics for Radiohead's Creep with one exact lookup", async () => {
    const lyrics = await lyricsProvider.getLyrics(creep(), ctx)
    expect(lyrics).toMatchObject({
      synced: true,
      source: 'lrclib',
      metadata: { artist: 'Radiohead' },
    })
    expect(lyrics?.metadata?.title).toMatch(/creep/i)
    const lines = lyrics?.lines ?? []
    expect(lines.filter((line) => line.text !== '').length).toBeGreaterThan(20)
    const firstMs = lines[0]?.timeMs ?? 0
    expect(firstMs).toBeGreaterThan(5_000)
    expect(firstMs).toBeLessThan(40_000)
    expect(lyrics && lineAt(lyrics, 120_000)).toBeGreaterThan(0)
  })

  it('falls back to a search, and only syncs lyrics that keep time', async () => {
    // A music video runs longer than the album track, so the exact lookup misses.
    const video = creep({
      title: 'Radiohead - Creep (Official Music Video)',
      artists: [{ name: 'RadioheadVEVO' }],
      durationMs: 256_000,
      kind: 'music-video',
    })
    const lyrics = await lyricsProvider.getLyrics(video, ctx)
    expect(lyrics?.lines.length).toBeGreaterThan(10)
    if (lyrics?.synced) {
      // Only a record of the video's own length may give synced lyrics.
      expect(Math.abs((lyrics.metadata?.lengthMs ?? 0) - 256_000)).toBeLessThanOrEqual(2_000)
    }
  })

  it('lets any web page call it, with the Lrclib-Client header', async () => {
    const origin = 'https://fxm-music.pages.dev'
    const url = `${LRCLIB_ORIGIN}/api/search?q=${encodeURIComponent('Radiohead Creep')}`
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'lrclib-client',
      },
    })
    expect(preflight.ok).toBe(true)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/\blrclib-client\b/i)
    const response = await fetch(url, {
      headers: { Origin: origin, 'Lrclib-Client': DEFAULT_LRCLIB_CLIENT },
    })
    await response.body?.cancel()
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-expose-headers')).toMatch(/retry-after/i)
  })
})
