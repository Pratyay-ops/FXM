/**
 * Live checks against archive.org, about ten requests in all. They run only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/archive/live.test.ts
 * ```
 *
 * The known item is Nine Inch Nails' "Ghosts I - IV" (`nineinchnails_ghosts_I_IV`), released
 * under CC BY-NC-SA 3.0 with FLAC files.
 */

import {
  type AudioCandidate,
  DEFAULT_QUALITY_PREFS,
  formatId,
  type ProviderContext,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createArchiveSource } from './provider'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

const NIN = 'nineinchnails_ghosts_I_IV'
const ORIGIN = 'https://fxm-music.pages.dev'

describe.skipIf(!live)('Internet Archive, live', { timeout: 60_000 }, () => {
  const archive = createArchiveSource({ probeFlac: true })
  const ctx: ProviderContext = {
    fetch: globalThis.fetch.bind(globalThis),
    platform: 'web',
    capabilities: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
    mode: 'music',
  }

  it('finds the known item among the most downloaded FLAC albums for its words', async () => {
    const results = await archive.search(
      'nine inch nails ghosts',
      { types: ['album'], limit: 5 },
      ctx,
    )
    expect(results.albums?.items.map((album) => album.id)).toContain(
      formatId('archive', 'album', NIN),
    )
    expect(results.albums?.total).toBeGreaterThan(5)
  })

  it('resolves a known track to a lossless FLAC original, with its sample rate and depth', async () => {
    const candidate: AudioCandidate = {
      source: 'archive',
      ref: `${NIN}/01_Ghosts_I.flac`,
      kind: 'song',
      title: '1 Ghosts I',
      artists: ['Nine Inch Nails'],
      confidence: 1,
      evidence: [],
    }
    const options = await archive.resolve(candidate, ctx, DEFAULT_QUALITY_PREFS)
    const [best] = options
    expect(best).toMatchObject({
      url: `https://archive.org/download/${NIN}/01_Ghosts_I.flac`,
      codec: 'flac',
      container: 'flac',
      tier: 'lossless',
      fullLength: 'unverified',
      ipBound: false,
    })
    expect([44_100, 48_000, 88_200, 96_000]).toContain(best?.sampleRateHz)
    expect([16, 24]).toContain(best?.bitDepth)
    expect(options.some((option) => option.codec === 'mp3')).toBe(true)
  })

  it('matches the Spotify track to the same file, below the Auto band', async () => {
    const [found] = await archive.match(
      {
        id: formatId('spotify', 'track', '2KcYOmnZ4oexHQRO8aYcfW'),
        source: 'spotify',
        title: '1 Ghosts I',
        artists: [{ name: 'Nine Inch Nails' }],
        album: { name: 'Ghosts I-IV' },
        durationMs: 168_000,
        artwork: [],
        kind: 'song',
      },
      ctx,
    )
    expect(found).toMatchObject({ source: 'archive', ref: `${NIN}/01_Ghosts_I.flac` })
    expect(found?.confidence).toBeGreaterThanOrEqual(0.6)
    expect(found?.confidence).toBeLessThan(0.8)
  })

  it('lets any web page read search results, metadata and file bytes', async () => {
    const search = await fetch(
      `https://archive.org/advancedsearch.php?q=identifier%3A${NIN}&fl%5B%5D=identifier&rows=1&output=json`,
      { headers: { Origin: ORIGIN } },
    )
    await search.body?.cancel()
    expect(search.headers.get('access-control-allow-origin')).toBe('*')
    // The download URL redirects to a storage host; both send ACAO: *, and a single range
    // header needs no preflight.
    const file = await fetch(`https://archive.org/download/${NIN}/01_Ghosts_I.flac`, {
      headers: { Origin: ORIGIN, Range: 'bytes=0-41' },
    })
    const bytes = new Uint8Array(await file.arrayBuffer())
    expect(file.status).toBe(206)
    expect(file.url).toMatch(/^https:\/\/[a-z0-9.-]+\.archive\.org\//u)
    expect(file.headers.get('access-control-allow-origin')).toBe('*')
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('fLaC')
  })
})
