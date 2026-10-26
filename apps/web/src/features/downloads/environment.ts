/**
 * Every place where the web app's downloads meet stages that had not merged when 4.1 was built:
 * one interface, {@link DownloadEnvironment}, and the stand-in the app uses until then,
 * {@link createPendingEnvironment}. Tests pass their own.
 *
 * - **The provider context** (stage 1.2, platform transports and capability detection): the
 *   `fetch` downloads use and what this browser can reach. Until it is wired in, the stand-in
 *   reports the free tier (no YouTube), so YouTube downloads are not offered.
 * - **The stream sources** (1.4, the YouTube ladder with its end-of-file probe; 1.6, Internet
 *   Archive and Jamendo), **the matching engine** (1.7) and **the match cache** (2.6): the
 *   pieces `createPolicyDownloadResolver` from `@fxm/downloads` is built from, the same ones the
 *   stream lifecycle gets. Until then the stand-in has no sources: its resolver's `canResolve`
 *   says no for every track, so nothing is offered for download (Internet Archive and Jamendo
 *   tracks included) rather than offered and then failed.
 *
 * Integration: in {@link createAppDownloadEnvironment}, return the real context (and its change
 * events) and `createPolicyDownloadResolver({ sources, matcher, matches, settings, canPlay })`.
 * Downloads are background work: the context's `fetch` must draw on the request budget at the
 * `bulk` priority, which the resolver also asks its sources for by default, e.g. with 1.2's
 * platform `context: () => platform.context({ mode, priority: 'bulk' })`. Nothing else in the
 * feature changes.
 *
 * @module
 */

import type { NetworkCapabilities, ProviderContext, StreamOption, StreamSupport } from '@fxm/core'
import { createPolicyDownloadResolver, type DownloadResolver } from '@fxm/downloads'
import { mimeTypeOf } from '@fxm/player'
import { useSettingsStore } from '../settings/settings-store'

/** What the app's downloads need from the rest of FXM. */
export interface DownloadEnvironment {
  /**
   * The provider context downloads run with, read afresh for every attempt: its `fetch` makes
   * the resolver's calls at the request budget's `bulk` priority and fetches the bytes, and its
   * capabilities and catalog mode decide what may be downloaded.
   */
  context(): ProviderContext
  /**
   * Finds what to download for a track. Its `canResolve` decides which tracks are offered for
   * download at all.
   */
  readonly resolver: DownloadResolver
  /**
   * Calls `listener` when what {@link context} returns changes, e.g. FXM Connect appeared or
   * the catalog mode changed. Returns a function that stops it.
   */
  subscribe(listener: () => void): () => void
}

/** What a browser page without FXM Connect or the Lite tier reaches: free sources only. */
export const FREE_TIER: NetworkCapabilities = Object.freeze({
  youtube: 'none',
  spotify: 'unreachable',
  mediaBytes: false,
  fileSystem: false,
})

let probe: HTMLAudioElement | undefined

/**
 * How sure this browser is that it can play a stream, as `canPlayType` says for its MIME type:
 * a download should be a file that plays offline here.
 */
export function browserCanPlay(stream: Pick<StreamOption, 'codec' | 'container'>): StreamSupport {
  const type = mimeTypeOf(stream)
  if (type === undefined || typeof document === 'undefined') return 'maybe'
  probe ??= document.createElement('audio')
  const answer = probe.canPlayType(type)
  return answer === 'probably' || answer === 'maybe' ? answer : 'no'
}

/**
 * The page's own `fetch`, never with cookies (ARCHITECTURE.md §8: `credentials: 'omit'`
 * everywhere). Stage 1.2's transport replaces it.
 */
const pageFetch: ProviderContext['fetch'] = (input, init) =>
  globalThis.fetch(input, { ...init, credentials: 'omit' })

/**
 * The stand-in until stages 1.2, 1.4, 1.6 and 1.7 are wired in: the free tier, the page's
 * `fetch`, the catalog mode from the settings, and a resolver without sources.
 */
export function createPendingEnvironment(): DownloadEnvironment {
  const resolver = createPolicyDownloadResolver({ sources: [], canPlay: browserCanPlay })
  return {
    context: () => ({
      fetch: pageFetch,
      platform: 'web',
      capabilities: FREE_TIER,
      mode: useSettingsStore.getState().catalogMode,
    }),
    resolver,
    subscribe: (listener) =>
      useSettingsStore.subscribe((state, previous) => {
        if (state.catalogMode !== previous.catalogMode) listener()
      }),
  }
}

/**
 * The environment the app's downloads use. Integration with stages 1.2, 1.4, 1.6 and 1.7:
 * return the real one here (see the module notes).
 */
export function createAppDownloadEnvironment(): DownloadEnvironment {
  return createPendingEnvironment()
}
