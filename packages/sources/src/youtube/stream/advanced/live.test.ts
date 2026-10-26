/**
 * Live checks of the experimental rungs from Node on a residential connection. They run only with
 * `FXM_LIVE=1`; with `FXM_RECORD=1` as well, they write the sanitized `/player` answers into
 * `fixtures/`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/stream/advanced/live.test.ts
 * ```
 *
 * The evaluator is the committed `eval.html` in Playwright's Chromium at
 * `https://www.youtube.com/`, as the Android app loads it (`fixtures/browser-evaluator.ts`).
 * Requests go out from Node in FXM's request shape with a desktop browser's `User-Agent`, as the
 * desktop and Android transports send them, except where the TV rung sets its own.
 *
 * About ten requests to YouTube (one `sw.js_data` read, `iframe_api`, the player script, the home
 * page, `GenerateIT` and four `/player` calls), one to Google for BotGuard's interpreter, and
 * about six to googlevideo (four end-of-file probes and the first SABR answers).
 */

import { DEFAULT_QUALITY_PREFS, type ProviderContext, type QualityPrefs } from '@fxm/core'
import { SabrStream } from 'googlevideo/sabr-stream'
import { EnabledTrackTypes } from 'googlevideo/utils'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FULL } from '../../fixtures/testing'
import { createYouTubeSession } from '../../session'
import type { StreamConfig } from '../config'
import { candidate, VIDEOS } from '../fixtures/testing'
import { createYouTubeAudioSource } from '../resolver'
import { type BrowserEvaluator, launchBrowserEvaluator } from './fixtures/browser-evaluator'
import { sanitizeAdvancedResponse } from './fixtures/sanitize'
import { ADVANCED_STREAM_CONFIG } from './fixtures/testing'
import { type AdvancedRungsHook, createAdvancedRungs } from './rungs'
import type { YouTubeSabrPlayback } from './sabr'

/** Node's environment and `fs`, without Node's types. */
const node = (
  globalThis as unknown as {
    process?: {
      env?: Record<string, string | undefined>
      getBuiltinModule(id: 'node:fs'): { writeFileSync(path: URL, text: string): void }
    }
  }
).process
const live = node?.env?.FXM_LIVE === '1'
const recording = node?.env?.FXM_RECORD === '1'

/** A desktop browser's user agent, as FXM's native transports send. */
const BROWSER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** The fixture each client's answer is recorded into. */
const FIXTURE_OF: Readonly<Record<string, string>> = {
  TVHTML5: 'tv-samsung-song',
  MWEB: 'mweb-song',
  WEB_REMIX: 'web-remix-song',
  WEB: 'web-sabr-song',
}

const PREFS = DEFAULT_QUALITY_PREFS as QualityPrefs

/**
 * The bundled config, with the experimental rungs, with only `id` on, offering `itags` (fewer
 * probes).
 */
function only(id: string, itags: number[]): StreamConfig {
  return {
    ...ADVANCED_STREAM_CONFIG,
    rungs: ADVANCED_STREAM_CONFIG.rungs.map((rung) =>
      rung.id === id ? { ...rung, enabled: true, itags } : { ...rung, enabled: false },
    ),
  }
}

describe.skipIf(!live)('the experimental YouTube rungs, live', { timeout: 180_000 }, () => {
  let browser: BrowserEvaluator | undefined
  let advanced: AdvancedRungsHook
  const session = createYouTubeSession()
  const answers = new Map<string, unknown>()
  const sent: string[] = []

  /** Node's fetch with a browser's user agent where a request sets none, recording `/player`. */
  const fetchLive: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    if (!headers.has('user-agent')) headers.set('user-agent', BROWSER_AGENT)
    const response = await fetch(url, { ...init, headers })
    sent.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname} ${response.status}`)
    if (url.pathname === '/youtubei/v1/player' && typeof init?.body === 'string') {
      const client = (JSON.parse(init.body) as { context?: { client?: { clientName?: string } } })
        .context?.client?.clientName
      if (client !== undefined) answers.set(client, await response.clone().json())
    }
    return response
  }

  const ctx = (): ProviderContext => ({
    fetch: fetchLive,
    platform: 'desktop',
    capabilities: FULL,
    mode: 'music',
    locale: 'en',
  })

  const resolveWith = (id: string, itags: number[]) =>
    createYouTubeAudioSource({
      session,
      streamConfig: only(id, itags),
      rungKinds: advanced.kinds,
    }).resolve(candidate(VIDEOS.song), ctx(), PREFS)

  beforeAll(async () => {
    browser = await launchBrowserEvaluator()
    advanced = createAdvancedRungs({ evaluator: browser.evaluator, sendsUserAgent: true })
  }, 120_000)

  afterAll(async () => {
    console.info(`Requests:\n${sent.join('\n')}`)
    await browser?.close()
    if (!recording) return
    for (const [client, answer] of answers) {
      const name = FIXTURE_OF[client]
      if (name === undefined) continue
      node
        ?.getBuiltinModule('node:fs')
        .writeFileSync(
          new URL(`./fixtures/${name}.json`, import.meta.url),
          `${JSON.stringify(sanitizeAdvancedResponse(answer), null, 2)}\n`,
        )
    }
  }, 60_000)

  it('tv-samsung: its deciphered URLs serve the end of the file, given its TV user agent', async () => {
    const options = await resolveWith('tv-samsung', [251, 140])
    expect(options.map((option) => [option.rung, option.itag, option.fullLength])).toEqual([
      ['tv-samsung', 251, 'verified'],
      ['tv-samsung', 140, 'verified'],
    ])
  })

  it('mweb: with a web PO token from BotGuard, its URL serves the end of the file', async () => {
    const [opus] = await resolveWith('mweb', [251])
    expect(opus).toMatchObject({ rung: 'mweb', itag: 251, fullLength: 'verified' })
    expect(new URL(opus?.url ?? '').searchParams.get('pot')).toBeTruthy()
  })

  it('web-remix: with the same token, its URL serves the end of the file', async () => {
    const [opus] = await resolveWith('web-remix', [251])
    expect(opus).toMatchObject({ rung: 'web-remix', itag: 251, fullLength: 'verified' })
  })

  it("web-sabr: the session's first SABR answers carry the song's audio", async () => {
    const [option] = await resolveWith('web-sabr', [251])
    expect(option).toMatchObject({ rung: 'web-sabr', protocol: 'sabr', itag: 251 })
    const playback = option?.playback as YouTubeSabrPlayback
    const stream = new SabrStream({
      fetch: fetchLive,
      serverAbrStreamingUrl: option?.url ?? '',
      videoPlaybackUstreamerConfig: playback.ustreamerConfig,
      poToken: playback.poToken,
      clientInfo: { clientName: playback.client.nameId, clientVersion: playback.client.version },
      durationMs: playback.durationMs,
      formats: [playback.audio, playback.video],
    })
    const { audioStream } = await stream.start({
      audioFormat: playback.audio.itag,
      videoFormat: playback.video.itag,
      enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    })
    const reader = audioStream.getReader()
    let bytes = 0
    while (bytes < 256 * 1024) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
    }
    stream.abort()
    // The first chunk of a WebM file starts with its EBML header.
    expect(bytes).toBeGreaterThanOrEqual(256 * 1024)
  })
})
