/**
 * vite-plugin-pwa options: the manifest, and a Workbox service worker that stores the app shell
 * and nothing else.
 *
 * @module
 */

import type { VitePWAOptions } from 'vite-plugin-pwa'
import { APP_BASE, webManifest } from './manifest.ts'

/**
 * The files the service worker stores at install, so the player opens without a connection:
 * the app's own HTML, code, styles and icons, all from the app's build (the plugin adds the
 * manifest). Media (audio, video, wasm) is never among them.
 */
export const PRECACHE_PATTERNS = ['**/*.{html,js,css,svg,png}'] as const

/**
 * Build output that is served elsewhere, if it ever lands in the app's folder: the embed
 * (`/embed/`, stage 5.2) and the sandbox documents (`/sandbox/`, stage 1.10) are not part of
 * the app shell.
 */
export const PRECACHE_IGNORES = ['embed/**', 'sandbox/**'] as const

/** Prefix of the service worker's cache names, which keeps them apart from any other cache. */
export const CACHE_ID = 'fxm-app'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** What Workbox's `manifestTransforms` take: the precache list of the build. */
type ManifestTransform = NonNullable<
  NonNullable<VitePWAOptions['workbox']>['manifestTransforms']
>[number]

/**
 * Adds `headersRevision` to the precache revision of the page, `index.html`. The service worker
 * serves its stored copy of the page with the headers it was stored with, the CSP among them,
 * and stores it again only when that revision changes. Tying the revision to the host's header
 * rule (pwa/host.ts) makes a deploy that changes only the headers ship a new service worker.
 */
export function revisionPageWithHeaders(headersRevision: string): ManifestTransform {
  return (entries) => ({
    manifest: entries.map((entry) =>
      entry.url === 'index.html'
        ? { ...entry, revision: `${entry.revision ?? ''}-${headersRevision}` }
        : entry,
    ),
    warnings: [],
  })
}

export interface PwaOptionsInput {
  /**
   * Fingerprint of the host's header rule for the app (`headersRevision` in pwa/host.ts), folded
   * into the page's precache revision ({@link revisionPageWithHeaders}).
   */
  headersRevision?: string
}

/**
 * The plugin options for an app served from `base`.
 *
 * - **Shell only.** The service worker precaches {@link PRECACHE_PATTERNS} and answers
 *   navigations inside `base` with the cached `index.html`. It has no runtime caching: media,
 *   googlevideo, the music services' APIs, artwork and everything else go to the network
 *   untouched, and nothing it fetches is stored. The page's revision includes the host's header
 *   rule (`headersRevision`), so a new policy reaches installed apps.
 * - **Updates ask first** (`registerType: 'prompt'`): a new version waits until the user
 *   chooses Reload in the update toast, because reloading stops the music. `clientsClaim`
 *   only matters for the first visit, which the service worker then controls at once.
 * - **No inline script:** the app registers the worker from its bundle
 *   (src/features/pwa/service-worker.ts), so the page's CSP needs no extra hash, and the
 *   Workbox runtime is inlined into one `sw.js`.
 * - **Source map as the build's** (the plugin's default): none from `vite build`, a hidden one
 *   from `make dist`, which reads it to list the Workbox packages in `sw.js` and never deploys
 *   it (source-map.ts).
 * - **Only on the web.** `build:mobile` and `build:desktop` build the app with base `/` for the
 *   Android and desktop shells, which load it from the app package: those builds get no
 *   service worker and no manifest, and registering does nothing.
 */
export function pwaOptions(
  base: string = APP_BASE,
  { headersRevision }: PwaOptionsInput = {},
): Partial<VitePWAOptions> {
  return {
    strategies: 'generateSW',
    registerType: 'prompt',
    injectRegister: false,
    manifest: webManifest(base),
    // PRECACHE_PATTERNS already picks the icons up from the build; listing them twice would
    // precache them twice.
    includeManifestIcons: false,
    workbox: {
      cacheId: CACHE_ID,
      globPatterns: [...PRECACHE_PATTERNS],
      globIgnores: [...PRECACHE_IGNORES],
      navigateFallback: 'index.html',
      navigateFallbackAllowlist: [new RegExp(`^${escapeRegExp(base)}`)],
      cleanupOutdatedCaches: true,
      clientsClaim: true,
      skipWaiting: false,
      inlineWorkboxRuntime: true,
      disableDevLogs: true,
      ...(headersRevision
        ? { manifestTransforms: [revisionPageWithHeaders(headersRevision)] }
        : {}),
    },
    integration: {
      configureOptions(viteConfig, options) {
        if (viteConfig.base !== base) options.disable = true
      },
    },
  }
}
