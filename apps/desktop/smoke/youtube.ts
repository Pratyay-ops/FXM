/**
 * The smoke test's touch-points with two stages that had not merged when stage 7.2 was built:
 * the YouTube Music provider (1.3) and the YouTube stream resolver (1.4). This is the one place
 * the swap happens.
 *
 * Until then, {@link interimYouTube} stands in. Its search is one plain InnerTube call in the
 * CORS-simple shape, enough to show that the native networking reaches YouTube Music, and its
 * resolve is pending. Once both stages have merged, replace it with the real providers, along
 * these lines:
 *
 * ```ts
 * import { DEFAULT_QUALITY_PREFS, parseId } from '@fxm/core'
 * import { createYouTubeProviders } from '@fxm/sources/youtube' // 1.3
 *
 * const { music } = createYouTubeProviders()
 * export const youtube: SmokeYouTube = {
 *   async search(query, ctx) {
 *     const track = (await music.search(query, { types: ['track'] }, ctx)).tracks?.items[0]
 *     if (track === undefined) throw new Error('no songs')
 *     return { videoId: String(parseId(track.id)?.nativeId), title: track.title }
 *   },
 *   resolve: (videoId, ctx) => // 1.4's AudioSource for `ytm`
 *     audio.resolve(
 *       { source: 'ytm', ref: videoId, kind: 'song', title: '', artists: [], confidence: 1, evidence: [] },
 *       ctx,
 *       DEFAULT_QUALITY_PREFS,
 *     ),
 * }
 * ```
 *
 * Protocol facts the interim search relies on, seen on 2026-10-26 through this test, in YouTube
 * Music's own page and responses: YouTube Music's web client is `WEB_REMIX`; its page's
 * configuration names the client version as `"INNERTUBE_CLIENT_VERSION"` (`1.20261020.10.00`
 * that day); `/youtubei/v1/search` answers a `text/plain` POST without an `Origin` with JSON whose
 * results carry `videoId` keys. They belong in the YouTube clean-room log
 * (`packages/sources/src/youtube/CLEAN-ROOM.md`) once stage 1.3 has created it.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import { Pending, type SmokeYouTube } from './steps'

/** YouTube Music's web page, whose configuration names its InnerTube client version. */
export const MUSIC_PAGE_URL = 'https://music.youtube.com/'

/** InnerTube's search endpoint on YouTube Music. */
export const MUSIC_SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search'

/**
 * The client version to use when the page names none: a WEB_REMIX version of the form
 * YouTube Music's page used on 2026-10-26 (`1.<date>.<build>.00`).
 */
export const FALLBACK_CLIENT_VERSION = '1.20261020.01.00'

/** The InnerTube client version in YouTube Music's page configuration, if it names one. */
export function pageClientVersion(html: string): string | undefined {
  return /"INNERTUBE_CLIENT_VERSION":"(1\.\d{8}\.\d{2}\.\d{2})"/.exec(html)?.[1]
}

/** Every `videoId` in an InnerTube response, in document order, without repeats. */
export function videoIds(json: unknown): string[] {
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'videoId' && typeof item === 'string' && /^[\w-]{11}$/.test(item)) {
          found.add(item)
        } else {
          visit(item)
        }
      }
    }
  }
  visit(json)
  return [...found]
}

/**
 * Searches YouTube Music with one InnerTube call, as YouTube Music's own web client (WEB_REMIX)
 * would, in the CORS-simple shape the transport checks. The client version comes from YouTube
 * Music's page, which costs one more request.
 */
export async function plainMusicSearch(query: string, ctx: ProviderContext) {
  const page = await ctx.fetch(MUSIC_PAGE_URL)
  const clientVersion =
    (page.ok ? pageClientVersion(await page.text()) : undefined) ?? FALLBACK_CLIENT_VERSION
  const response = await ctx.fetch(MUSIC_SEARCH_URL, {
    method: 'POST',
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion, hl: 'en', gl: 'US' } },
      query,
    }),
  })
  if (!response.ok) throw new Error(`InnerTube's search answered ${response.status}`)
  const found = videoIds(await response.json())
  const first = found[0]
  if (first === undefined) throw new Error('InnerTube’s search found nothing')
  return { videoId: first, title: `${found.length} results, client ${clientVersion}` }
}

/** What stands in for stages 1.3 and 1.4 until they merge. */
export const interimYouTube: SmokeYouTube = {
  search: plainMusicSearch,
  async resolve() {
    throw new Pending('needs stage 1.4’s VISIONOS resolver, which has not merged yet')
  },
}
