/**
 * Where the embed meets the stages that hadn't merged when stage 5.2 was built (an early start,
 * owner decision of 2026-10-26). Everything the embed needs from them comes through the two
 * functions below, behind interfaces the embed already uses with fakes in its tests
 * (`./testing`). When a stage merges, its integration changes only the body named for it here:
 *
 * | Touch-point | Stage | What to wire in |
 * |---|---|---|
 * | `catalog`: YouTube Music and YouTube metadata | 1.3 | `createYouTubeProviders()`'s `music` and `video` (`@fxm/sources/youtube`), in `createProviderCatalog([...])` |
 * | `catalog`: Internet Archive and Jamendo metadata, and their credits | 1.6 | `createArchiveSource()` and `createJamendoSource()`, plus their attribution, in `createProviderCatalog([...], { attribution })` |
 * | `sources`: YouTube streams | 1.4 | The resolution ladder as a `StreamSource` for `ytm` (`hasFallback: true`); the controller adds the budget priority itself |
 * | `sources`: free-source streams | 1.6 | `fromAudioSource(archive)`, `fromAudioSource(jamendo)` from `@fxm/player` |
 * | `matcher`: songs for official videos in Music mode | 1.7 with 1.3's searches | A `TrackMatcher`; optional, without it only linked songs play |
 * | `killSwitches`: the Lite tier's remote kill switch | 1.3's config | `() => ({ lite: youtubeConfig.killSwitches.lite })` |
 * | `selfTestRequest`: the Lite self-test's client version | 1.3's config | The provider's own request, as the sandbox README suggests |
 *
 * The `/embed/*` header rule is stage 2.8's (`appPolicy({ embeddable: true })` there): the
 * app's policy without `frame-ancestors`, so any site may frame the player. 2.8's
 * `embedPart.build()` runs `vite build -c vite.embed.config.ts --sourcemap hidden --outDir <dir>`
 * from `apps/web`.
 *
 * @module
 */

import type { KillSwitches, PlatformOptions, SandboxTransportOptions } from '@fxm/platform'
import { createProviderCatalog } from './catalog'
import type { EmbedPlatform, EmbedServices } from './controller'

/** The platform options that come from other stages: the remote config's switches (1.3). */
export function embedPlatformOptions(): Pick<PlatformOptions, 'killSwitches'> {
  // 1.3: read `killSwitches.lite` from the YouTube config, so the remote config can turn the
  // Lite tier off in embeds too.
  const killSwitches = (): KillSwitches => ({})
  return { killSwitches }
}

/** The sandbox options that come from other stages: the self-test's request (1.3). */
export function embedSandboxOptions(): Pick<SandboxTransportOptions, 'selfTestRequest'> {
  // 1.3: the YouTube provider's own self-test request, so its client version stays current.
  // Until then the sandbox's default request (`defaultSelfTestRequest`) runs.
  return {}
}

/**
 * The providers an embed loads and plays through. Until 1.3, 1.4 and 1.6 are wired in, the
 * catalog has no providers (every embed reports that it can't play its content here) and there
 * are no stream sources.
 */
export function createEmbedServices(_platform: EmbedPlatform): EmbedServices {
  return {
    // 1.3: music and video providers; 1.6: the Internet Archive and Jamendo sources, with
    // their attribution.
    catalog: createProviderCatalog([]),
    // 1.4: the YouTube ladder; 1.6: fromAudioSource(archive), fromAudioSource(jamendo).
    sources: [],
  }
}
