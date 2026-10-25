/**
 * Live checks of the stream ladder from Node, in the CORS-simple request shape: seven requests
 * to YouTube (one `sw.js_data` read, five `/player` calls and the first call of a Lite-style
 * session) and six ranged GETs to googlevideo. They run only with `FXM_LIVE=1`, from a
 * residential connection (datacenter IPs get bot checks):
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/live.test.ts
 * ```
 */

import { DEFAULT_QUALITY_PREFS, type NetworkCapabilities, type ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { FULL, preflightReason, type Recorded, SIMPLE } from '../fixtures/testing'
import { createYouTubeSession } from '../session'
import { BUNDLED_STREAM_CONFIG, type StreamConfig } from './config'
import { candidate, VIDEOS } from './fixtures/testing'
import { createYouTubeAudioSource } from './resolver'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

const INNERTUBE =
  /^https:\/\/(?:www|music)\.youtube\.com\/youtubei\/v1\/[a-z_/]+\?prettyPrint=false$/u

describe.skipIf(!live)('YouTube streams, live', { timeout: 120_000 }, () => {
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
  const at = (capabilities: NetworkCapabilities): ProviderContext => ({
    fetch: recordingFetch,
    platform: 'web',
    capabilities,
    mode: 'music',
    locale: 'en',
  })
  const session = createYouTubeSession()
  const withoutVisionos: StreamConfig = {
    ...BUNDLED_STREAM_CONFIG,
    rungs: BUNDLED_STREAM_CONFIG.rungs.map((rung) =>
      rung.id === 'visionos' ? { ...rung, enabled: false } : rung,
    ),
  }

  it('resolves a YouTube Music song to VISIONOS URLs that pass the end-of-file probe', async () => {
    const audio = createYouTubeAudioSource({ session })
    const options = await audio.resolve(candidate(VIDEOS.song), at(FULL), DEFAULT_QUALITY_PREFS)
    expect(options.map((option) => option.itag)).toEqual(
      expect.arrayContaining([251, 140, 250, 249, 139]),
    )
    expect(options.every((option) => option.rung === 'visionos')).toBe(true)
    // The best Opus and the best AAC are probed; caps belong to a client, not a format.
    const verified = options.filter((option) => option.fullLength === 'verified')
    expect(verified.map((option) => option.itag).sort()).toEqual([140, 251])
    expect(options.find((option) => option.itag === 251)).toMatchObject({
      codec: 'opus',
      tier: 'high',
      ipBound: true,
    })
    expect(options[0]?.expiresAt).toBeGreaterThan(Date.now() + 5 * 3_600_000)

    const calls = sent.splice(0)
    const innertube = calls.filter((call) => call.url.pathname.startsWith('/youtubei/'))
    expect(innertube).toHaveLength(1)
    for (const call of innertube) {
      expect(call.url.href).toMatch(INNERTUBE)
      expect(preflightReason(call)).toBeUndefined()
      expect([...call.headers.keys()]).toEqual(['content-type'])
      expect(call.credentials).toBe('omit')
    }
    const probes = calls.filter((call) => call.url.hostname.endsWith('.googlevideo.com'))
    expect(probes).toHaveLength(2)
    for (const probe of probes) {
      // A single range with a start is CORS-safelisted (Fetch standard), so no preflight.
      expect([...probe.headers.keys()]).toEqual(['range'])
      expect(probe.headers.get('range')).toMatch(/^bytes=\d+-\d+$/u)
      expect(probe.credentials).toBe('omit')
    }
  })

  it('resolves it to an itag 18 URL that passes the probe when VISIONOS is off', async () => {
    const audio = createYouTubeAudioSource({ session, streamConfig: withoutVisionos })
    const options = await audio.resolve(candidate(VIDEOS.song), at(FULL), DEFAULT_QUALITY_PREFS)
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      itag: 18,
      rung: 'android-muxed',
      media: 'muxed-video',
      container: 'mp4',
      codec: 'aac',
      fullLength: 'verified',
    })
    expect(options[0]?.contentLength).toBeGreaterThan(1_048_576)
    sent.splice(0)
  })

  it('plays a video made for kids, which VISIONOS refuses, through itag 18 in full', async () => {
    const audio = createYouTubeAudioSource({ session })
    const options = await audio.resolve(candidate(VIDEOS.kids), at(FULL), DEFAULT_QUALITY_PREFS)
    expect(options.map((option) => [option.rung, option.itag, option.fullLength])).toEqual([
      ['android-muxed', 18, 'verified'],
    ])
    const players = sent.splice(0).filter((call) => call.url.pathname === '/youtubei/v1/player')
    const clients = players.map(
      (call) => (call.body.context as { client: { clientName: string } }).client.clientName,
    )
    expect(clients).toEqual(['VISIONOS', 'ANDROID'])
  })

  it('gets a Lite session a visitorData before its first /player call', async () => {
    const audio = createYouTubeAudioSource({ session: createYouTubeSession() })
    const options = await audio.resolve(candidate(VIDEOS.song), at(SIMPLE), DEFAULT_QUALITY_PREFS)
    expect(options[0]).toMatchObject({ rung: 'visionos', fullLength: 'unverified' })
    const calls = sent.splice(0)
    expect(calls.map((call) => call.url.pathname)).toEqual([
      '/youtubei/v1/music/get_search_suggestions',
      '/youtubei/v1/player',
    ])
    expect(calls[0]?.rawBody).not.toContain('visitorData')
    expect(calls[1]?.rawBody).toContain('visitorData')
  })
})
