/**
 * The provider context for the services every tier reaches straight from the page: lyrics
 * (LRCLIB), SponsorBlock and scrobbling (ListenBrainz, Last.fm). The app's composition root
 * (stage 2.9) connects its platform's context with {@link connectAppContext}, so the desktop
 * and Android apps send these requests through their native HTTP (stages 7.2 and 6.2), and every
 * request passes the platform's host table, like the providers'. Until then, and where the
 * composition root doesn't run, the page's own `fetch` without cookies stands in, with the
 * capabilities at their most limited: these services answer any origin.
 *
 * A module of its own with nothing heavy in it, so the features that read it keep their code in
 * their own chunks.
 *
 * @module
 */

import type { CatalogMode, ProviderContext } from '@fxm/core'

/** What one context is for. */
export interface AppContextRequest {
  /** The catalog mode. */
  readonly mode: CatalogMode
  /** Cancels the call. */
  readonly signal?: AbortSignal | undefined
}

/** Where contexts come from: the app platform's, at the budget's `interactive` priority. */
export type AppContextSource = (request: AppContextRequest) => ProviderContext

let source: AppContextSource | undefined

/**
 * Makes {@link appContext} come from `next`: the composition root's platform. Returns a
 * function that disconnects it, which leaves a source connected after it alone.
 */
export function connectAppContext(next: AppContextSource): () => void {
  source = next
  return () => {
    if (source === next) source = undefined
  }
}

/** The page's own `fetch`, never with cookies (ARCHITECTURE.md §8: `credentials: 'omit'`). */
const pageFetch: ProviderContext['fetch'] = (input, init) =>
  globalThis.fetch(input, { ...init, credentials: 'omit' })

/** A context for one call to a service any tier reaches (see the module documentation). */
export function appContext(mode: CatalogMode, signal?: AbortSignal): ProviderContext {
  if (source !== undefined) return source({ mode, signal })
  return {
    fetch: pageFetch,
    platform: 'web',
    capabilities: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
    mode,
    ...(signal === undefined ? {} : { signal }),
  }
}
