/**
 * The embed's providers (stage 5.2, wired by stage 2.9b): the real YouTube Music and YouTube
 * providers and stream ladder (stages 1.3 and 1.4) and the Internet Archive source (1.6), on the
 * embed's own platform, through the app's composition-root adapters (`youtube.ts`,
 * `matcher.ts`, `updates.ts` in `src/app/services`).
 *
 * | Touch-point | Stage | Here |
 * |---|---|---|
 * | `catalog`: YouTube Music and YouTube metadata | 1.3 | `ytm` and `yt`, loaded with the first YouTube content |
 * | `catalog`: Internet Archive metadata and credits | 1.6 | `archive`, with each track's credits (its item page and licence) |
 * | `sources`: YouTube streams | 1.4 | The ladder as the `ytm` stream source; the lifecycle gives its calls their budget priority |
 * | `sources`: free-source streams | 1.6 | `fromAudioSource(archive)` |
 * | `matcher`: songs for official videos in Music mode | 1.7 | The app's matcher over YouTube Music, loaded with the first such video |
 * | `killSwitches`: the Lite tier's remote kill switch | 1.3, 1.13 | The YouTube config in use: the bundled one, or a newer signed one from FXM's site |
 * | `selfTestRequest`: the Lite self-test's client | 1.3 | The YouTube Music client of the config |
 *
 * Jamendo stays out: it needs a `client_id`, which the build has none of today. `WIRED_SOURCES`
 * (`wired.ts`) names exactly the sources wired here; `integration.test.ts` keeps them in step.
 *
 * The `/embed/*` header rule is stage 2.8's (`appPolicy({ embeddable: true })` there): no
 * `frame-ancestors`, so any site may frame the player, no worker, and only the hosts of the
 * services wired here, YouTube's and Internet Archive's, plus
 * `Cross-Origin-Opener-Policy: same-origin` (README, "Headers").
 *
 * @module
 */

import { type MetadataProvider, type ProviderContext, parseId, type Track } from '@fxm/core'
import {
  createKillSwitchStore,
  type PlatformOptions,
  type SandboxTransportOptions,
  SIMPLE_CONTENT_TYPE,
  type SimpleInnerTubeRequest,
} from '@fxm/platform'
import { fromAudioSource, type TrackMatcher } from '@fxm/player'
import type { ArchiveSource } from '@fxm/sources/archive'
// The config FXM ships with, as data only: importing `@fxm/sources/youtube` for it would bring
// the providers and youtubei.js into the player's first chunk.
import bundledConfig from '../../../../packages/sources/src/youtube/youtube-config.json'
import { createIndexedDbStore } from '../app/services/device-store'
import { createLoader, lazyProvider } from '../app/services/lazy-provider'
import {
  createYouTubeLoader,
  keepYouTubeCurrentLater,
  platformStreamBudget,
  type YouTube,
  youtubeStreamSource,
} from '../app/services/youtube'
import { createProviderCatalog, type EmbedAttribution, type EmbedCatalog } from './catalog'
import type { EmbedPlatform, EmbedServices } from './controller'

/**
 * The embed's kill switches: the YouTube config's, the bundled one until YouTube's code has
 * loaded, then the config in use, which follows signed updates (stage 1.13).
 */
const killSwitches = createKillSwitchStore({ lite: bundledConfig.killSwitches.lite === true })

/** The YouTube Music client the Lite self-test asks as: the config's (its version stays current). */
let musicClient: { readonly name: string; readonly version: string } = bundledConfig.clients.music

/** The platform options that come from other stages: the YouTube config's kill switches. */
export function embedPlatformOptions(): Pick<PlatformOptions, 'killSwitches'> {
  return { killSwitches }
}

/**
 * The Lite self-test's request: YouTube Music's search suggestions, the smallest call on the
 * sandbox's allowlist, as the YouTube config's own client.
 */
export function liteSelfTestRequest(): SimpleInnerTubeRequest {
  return {
    url: 'https://music.youtube.com/youtubei/v1/music/get_search_suggestions?prettyPrint=false',
    init: {
      method: 'POST',
      headers: { 'content-type': SIMPLE_CONTENT_TYPE },
      body: JSON.stringify({
        context: {
          client: { clientName: musicClient.name, clientVersion: musicClient.version, hl: 'en' },
        },
        input: 'music',
      }),
      credentials: 'omit',
    },
  }
}

/** The sandbox options that come from other stages: the self-test's request (1.3). */
export function embedSandboxOptions(): Pick<SandboxTransportOptions, 'selfTestRequest'> {
  return { selfTestRequest: liteSelfTestRequest }
}

/**
 * The credits of Internet Archive tracks, which Creative Commons licences ask for where a track
 * plays: read with the item when the catalog loads it, so the player can show them at once.
 */
function archiveCredits(archive: () => Promise<ArchiveSource>) {
  const credits = new Map<string, EmbedAttribution>()
  return {
    async remember(tracks: readonly Track[], ctx: ProviderContext): Promise<void> {
      const source = await archive()
      await Promise.all(
        tracks
          .filter((track) => track.source === 'archive' && !credits.has(track.id))
          .map(async (track) => {
            try {
              const { provider, pageUrl, licenseUrl } = await source.attribution(track.id, ctx)
              credits.set(track.id, {
                provider,
                pageUrl,
                ...(licenseUrl === undefined ? {} : { licenseUrl }),
              })
            } catch {
              // Without its credits, the track still plays; the player names the source.
            }
          }),
      )
    },
    of: (track: Track) => credits.get(track.id),
  }
}

/** Options for {@link createEmbedServices}. */
export interface EmbedServicesOptions {
  /**
   * Keeps the YouTube config current from FXM's site once YouTube's code has loaded (stage
   * 1.13), so a kill switch the owner sets reaches players on other sites too. Default:
   * `keepYouTubeCurrent`, loaded only then (`keepYouTubeCurrentLater`); `false` for none (tests).
   */
  readonly updates?: ((youtube: YouTube) => void) | false
}

/**
 * The providers an embed loads and plays through, on `platform`: YouTube Music and YouTube
 * (`ytm`, `yt`) and Internet Archive (`archive`), each loaded with the first content it serves.
 */
export function createEmbedServices(
  platform: EmbedPlatform,
  options: EmbedServicesOptions = {},
): EmbedServices {
  const updates = options.updates ?? keepYouTubeCurrentLater
  const youtube = createYouTubeLoader({
    store: createIndexedDbStore(),
    budget: platformStreamBudget(() => platform.budget),
    onLoad: (loaded) => {
      const follow = () => {
        killSwitches.set(loaded.killSwitches())
        const config = loaded.host.current().config as { clients?: { music?: typeof musicClient } }
        if (config.clients?.music !== undefined) musicClient = config.clients.music
      }
      follow()
      loaded.subscribe(follow)
      if (updates !== false) updates(loaded)
    },
  })
  const archive = createLoader(
    'Internet Archive',
    () => import('@fxm/sources/archive'),
    ({ createArchiveSource }) => createArchiveSource(),
  )
  const report = (error: unknown) => {
    platform.report?.(error)
  }
  const providers: MetadataProvider[] = [
    lazyProvider({
      id: 'ytm',
      getPlaylistTracks: true,
      load: async () => (await youtube.load()).music,
      report,
    }),
    lazyProvider({
      id: 'yt',
      getPlaylistTracks: true,
      load: async () => (await youtube.load()).video,
      report,
    }),
    lazyProvider({ id: 'archive', load: () => archive.load() }),
  ]
  const credits = archiveCredits(() => archive.load())
  const base = createProviderCatalog(providers)
  const catalog: EmbedCatalog = {
    supports: (source) => base.supports(source),
    async load(target, ctx) {
      const entity = await base.load(target, ctx)
      if (parseId(target.id).source === 'archive') await credits.remember(entity.tracks, ctx)
      return entity
    },
    attribution: (track) => credits.of(track),
  }
  // Songs for official videos without a link, in Music mode: the matching engine over YouTube
  // Music's searches, loaded with the first such video. Auto stays off (stage 1.12).
  const engine = createLoader(
    'the matching engine',
    () => import('../app/services/matcher'),
    ({ createTrackMatcher }) =>
      createTrackMatcher({
        youtube: () => youtube.load(),
        lossless: async () => [await archive.load()],
        report,
      }),
  )
  const matcher: TrackMatcher = {
    match: async (track, request) => (await engine.load()).match(track, request),
  }
  return {
    catalog,
    sources: [
      youtubeStreamSource(youtube),
      fromAudioSource({
        id: 'archive',
        match: async (track, ctx) => (await archive.load()).match(track, ctx),
        resolve: async (candidate, ctx, prefs) =>
          (await archive.load()).resolve(candidate, ctx, prefs),
      }),
    ],
    matcher,
  }
}
