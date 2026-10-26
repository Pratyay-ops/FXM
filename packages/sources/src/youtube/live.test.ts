/**
 * Live checks against YouTube Music from Node, in the CORS-simple request shape, eight requests
 * in all. They run only with `FXM_LIVE=1`, from a residential connection (datacenter IPs get
 * bot checks):
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/live.test.ts
 * ```
 */

import { formatId, modePolicy, type ProviderContext, parseId, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { FULL, preflightReason, type Recorded, SIMPLE } from './fixtures/testing'
import { createYouTubeProviders } from './index'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

const INNERTUBE =
  /^https:\/\/(?:www|music)\.youtube\.com\/youtubei\/v1\/[a-z_/]+\?prettyPrint=false$/u

describe.skipIf(!live)('YouTube Music, live', { timeout: 60_000 }, () => {
  const sent: Recorded[] = []
  /** Node's fetch, recording each request so that its shape can be checked. */
  const recordingFetch: typeof fetch = (input, init) => {
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      rawBody,
      body: rawBody === undefined ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
      credentials: init?.credentials,
    })
    return fetch(input, init)
  }
  const at = (capabilities: ProviderContext['capabilities'], mode: ProviderContext['mode']) =>
    ({ fetch: recordingFetch, platform: 'web', capabilities, mode, locale: 'en' }) as const
  const videoId = (track: Track) => parseId(track.id).nativeId

  it("searches 'Radiohead Creep' and loads its radio, with a visitorData YouTube issued", async () => {
    const { music, session } = createYouTubeProviders()
    const ctx = at(SIMPLE, 'music')
    const { tracks } = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    const creep = tracks?.items.find(
      (track) =>
        /^creep$/iu.test(track.title) &&
        track.artists.some((artist) => artist.name === 'Radiohead'),
    )
    expect(creep, "Radiohead's Creep among the songs").toBeDefined()
    expect(creep?.kind).toBe('song')
    expect(session.visitorData.current, 'the visitorData of the first answer').toBeDefined()
    if (creep === undefined) return

    const first = await music.radioPage(creep, {}, ctx)
    expect(first.items.length).toBeGreaterThanOrEqual(20)
    expect(first.items.every((track) => track.kind === 'song')).toBe(true)
    expect(first.items.map(videoId)).not.toContain(videoId(creep))
    expect(new Set(first.items.map(videoId)).size).toBe(first.items.length)
    const second = await music.radioPage(creep, { cursor: first.nextCursor ?? '' }, ctx)
    expect(second.items.length).toBeGreaterThan(0)
    const before = new Set(first.items.map(videoId))
    expect(second.items.some((track) => before.has(videoId(track)))).toBe(false)

    const calls = sent.splice(0)
    expect(calls).toHaveLength(3)
    expect(calls[0]?.rawBody).not.toContain('visitorData')
    for (const call of calls) {
      expect(call.url.href).toMatch(INNERTUBE)
      expect(preflightReason(call)).toBeUndefined()
      expect([...call.headers.keys()]).toEqual(['content-type'])
      expect(call.credentials).toBe('omit')
    }
    expect(
      calls.slice(1).every((call) => call.rawBody?.includes(session.visitorData.current ?? '?')),
    ).toBe(true)
  })

  it("reads Pablo Honey's songs from its audio playlist, and links its official videos", async () => {
    const { music } = createYouTubeProviders()
    const id = formatId('ytm', 'album', 'MPREb_DciERiuADkS')
    const songs = await music.getAlbum(id, at(SIMPLE, 'music'))
    expect(songs.name).toBe('Pablo Honey')
    expect(songs.tracks?.length).toBe(12)
    expect(songs.tracks?.every((track) => track.kind === 'song')).toBe(true)
    expect(songs.tracks?.find((track) => track.title === 'Creep')).toBeDefined()
    const rows = await music.getAlbum(id, at(SIMPLE, 'all'))
    for (const [index, row] of (rows.tracks ?? []).entries()) {
      if (row.kind !== 'music-video') continue
      expect(row.songId, `the song of ${row.title}`).toBe(songs.tracks?.[index]?.id)
      expect(modePolicy(row, 'music')).toBe('plays-linked-song')
    }
    expect(sent.splice(0).map((call) => call.body.browseId)).toEqual([
      'MPREb_DciERiuADkS',
      expect.stringMatching(/^VLOLAK5uy_/u),
      'MPREb_DciERiuADkS',
    ])
  })

  it('reads a visitorData from sw.js_data in the full tier', async () => {
    const { music, session } = createYouTubeProviders()
    const suggestions = await music.suggest('radiohead', at(FULL, 'all'))
    expect(suggestions.length).toBeGreaterThan(0)
    const [swJsData, call] = sent.splice(0)
    expect(swJsData?.url.pathname).toBe('/sw.js_data')
    expect(call?.rawBody).toContain(session.visitorData.current ?? '?')
  })
})
