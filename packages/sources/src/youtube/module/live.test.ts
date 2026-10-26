/**
 * Live check of the YouTube module as the desktop and Android apps download it: the built
 * bundle, imported from its bytes alone, searches YouTube Music and resolves the first song from
 * Node, in the CORS-simple shape. Three requests to YouTube (`sw.js_data`, a search, one
 * `/player`), and none to googlevideo. Only with `FXM_LIVE=1` (`make live-smoke`), from a
 * residential connection:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/module/live.test.ts
 * ```
 */
import { DEFAULT_QUALITY_PREFS, parseId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { candidate } from '../stream/fixtures/testing'
import { buildYouTubeModule } from './build.mjs'
import { DESKTOP, importModuleCode } from './testing'

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

describe.skipIf(!live)('The YouTube module bundle, live', () => {
  it('searches and resolves a song from its bytes alone', async () => {
    const module = await importModuleCode((await buildYouTubeModule()).code)
    const { music, audio } = module.create({ config: module.config })
    const ctx = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
      platform: 'desktop',
      capabilities: DESKTOP,
      mode: 'music',
      locale: 'en',
    } as const
    const { tracks } = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    const song = tracks?.items.find((track) => track.kind === 'song')
    expect(song).toBeDefined()
    const videoId = parseId(song?.id)?.nativeId ?? ''
    const options = await audio.resolve(candidate(videoId), ctx, DEFAULT_QUALITY_PREFS)
    expect(options[0]?.url).toMatch(/^https:\/\/[^/]+\.googlevideo\.com\//u)
  }, 120_000)
})
