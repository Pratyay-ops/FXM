/**
 * The YouTube module itself: the entry point of the module that `build.mjs` bundles into one
 * self-contained ES module for the desktop and Android apps to download, and also the copy every
 * app ships with. Both export the same `youtubeModule`.
 *
 * Everything YouTube-specific is inside: the metadata providers (youtubei.js and FXM's parsers),
 * the stream ladder, the request shape and the config checks. The module reaches the network
 * only through the `ctx.fetch` each call gets, so the platform's host allow-lists apply to it;
 * `bundle.test.ts` checks this by making every other way out throw while the bundle works.
 *
 * @module
 */

import { parseYouTubeConfig } from '../config'
import { createYouTubeProviders } from '../index'
import { parseStreamConfig } from '../stream/config'
import { createYouTubeAudioSource } from '../stream/resolver'
import bundledConfig from '../youtube-config.json'
import type { YouTubeModule } from './api'
import { YOUTUBE_MODULE_API, YOUTUBE_MODULE_VERSION } from './version'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Checks both parts of a config document, the metadata and the stream ladder. */
function checkConfig(document: unknown): number {
  const { revision } = parseYouTubeConfig(document)
  parseStreamConfig(document)
  return revision
}

/** The YouTube module of this build. */
export const youtubeModule: YouTubeModule = Object.freeze({
  api: YOUTUBE_MODULE_API,
  version: YOUTUBE_MODULE_VERSION,
  config: deepFreeze(structuredClone(bundledConfig)),
  checkConfig,
  create(options) {
    const metadata = parseYouTubeConfig(options.config)
    const streams = parseStreamConfig(options.config)
    const providers = createYouTubeProviders({
      config: metadata,
      ...(options.visitorDataStore === undefined
        ? {}
        : { visitorDataStore: options.visitorDataStore }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    const audio = createYouTubeAudioSource({
      session: providers.session,
      streamConfig: streams,
      ...(options.healthStore === undefined ? {} : { healthStore: options.healthStore }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.timeoutMs === undefined ? {} : { playerTimeoutMs: options.timeoutMs }),
    })
    // Only what the contract names: youtubei.js's session stays inside the module.
    return { music: providers.music, video: providers.video, audio }
  },
} satisfies YouTubeModule)
