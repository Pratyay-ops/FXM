/**
 * Where the web app's downloads meet the rest of FXM: one interface, {@link DownloadEnvironment},
 * which the app's composition root (stage 2.9, `src/app/services/downloads.ts`) builds from its
 * platform and the stream lifecycle's own pieces and connects with
 * {@link connectDownloadEnvironment}. Tests pass their own.
 *
 * - **The provider context** (stage 1.2): the platform's `fetch` at the request budget's `bulk`
 *   priority, and what this device reaches, which decides what is offered: YouTube songs only
 *   where their bytes are readable (`mediaBytes`: FXM Connect, the desktop and Android apps,
 *   never the Lite tier), Internet Archive and Jamendo everywhere.
 * - **The stream sources** (1.4, the YouTube ladder with its end-of-file probe; 1.6, Internet
 *   Archive and Jamendo), **the matching engine** (1.7) and **the match cache** (2.6): the same
 *   instances the stream lifecycle uses, under `createPolicyDownloadResolver` from
 *   `@fxm/downloads`.
 *
 * Until the composition root connects its environment (it loads beside the first render), and
 * where it doesn't run, the stand-in {@link createPendingEnvironment} applies: the free tier and
 * a resolver without sources, so nothing is offered for download rather than offered and then
 * failed.
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
 * everywhere), for the stand-in only: the composition root's environment sends its requests
 * through the platform's transport (stage 1.2).
 */
const pageFetch: ProviderContext['fetch'] = (input, init) =>
  globalThis.fetch(input, { ...init, credentials: 'omit' })

/**
 * The stand-in before the composition root connects its environment, and where it doesn't run
 * (the development fake catalog) or couldn't start: the free tier, the page's `fetch`, the
 * catalog mode from the settings, and a resolver without sources, so nothing is offered.
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

/** The environment {@link connectDownloadEnvironment} connected last, until it is disconnected. */
let connected: DownloadEnvironment | undefined
/** Hears when another environment is connected. */
const connections = new Set<() => void>()

/**
 * Makes the app's downloads run on `environment`: the composition root's (stage 2.9), with the
 * app's platform, stream sources, matching engine and match cache. Returns a function that
 * disconnects it, which leaves an environment connected after it alone.
 */
export function connectDownloadEnvironment(environment: DownloadEnvironment): () => void {
  connected = environment
  for (const listener of [...connections]) listener()
  return () => {
    if (connected !== environment) return
    connected = undefined
    for (const listener of [...connections]) listener()
  }
}

/**
 * The environment the app's downloads use: the one {@link connectDownloadEnvironment} connected,
 * read afresh on every call, and the stand-in ({@link createPendingEnvironment}) until then. A
 * change of environment counts as a change of context, so what is offered follows.
 */
export function createAppDownloadEnvironment(): DownloadEnvironment {
  const pending = createPendingEnvironment()
  const current = () => connected ?? pending
  return {
    context: () => current().context(),
    resolver: {
      resolve: (track, request) => current().resolver.resolve(track, request),
      canResolve: (track) => current().resolver.canResolve?.(track) ?? true,
    },
    subscribe(listener) {
      let stop = current().subscribe(listener)
      const follow = () => {
        stop()
        stop = current().subscribe(listener)
        listener()
      }
      connections.add(follow)
      return () => {
        stop()
        connections.delete(follow)
      }
    },
  }
}
