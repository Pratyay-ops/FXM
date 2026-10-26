// @vitest-environment node
// Build-time config: no DOM.
import type { ResolvedConfig } from 'vite'
import type { VitePWAOptions } from 'vite-plugin-pwa'
import { describe, expect, it } from 'vitest'
import { APP_BASE } from './manifest.ts'
import {
  CACHE_ID,
  CORE_CACHE,
  coreCachePattern,
  PRECACHE_IGNORES,
  PRECACHE_PATTERNS,
  pwaOptions,
  revisionPageWithHeaders,
} from './options.ts'

const options = pwaOptions()
const workbox = options.workbox ?? {}

/** Whether a build file would be precached (enough of glob syntax for PRECACHE_PATTERNS). */
function precached(file: string): boolean {
  const ignored = PRECACHE_IGNORES.some((pattern) => file.startsWith(pattern.replace('**', '')))
  const extensions = /\{([^}]+)\}$/.exec(PRECACHE_PATTERNS[0])?.[1]?.split(',') ?? []
  return !ignored && extensions.some((extension) => file.endsWith(`.${extension}`))
}

/** Runs the integration hook the plugin calls once Vite knows the final `base`. */
function optionsForBase(base: string): Partial<VitePWAOptions> {
  const resolved = pwaOptions()
  void resolved.integration?.configureOptions?.({ base } as ResolvedConfig, resolved)
  return resolved
}

describe('PWA plugin options', () => {
  it('generates a Workbox service worker that waits for the user before updating', () => {
    expect(options).toMatchObject({ strategies: 'generateSW', registerType: 'prompt' })
    expect(workbox).toMatchObject({ skipWaiting: false, clientsClaim: true })
  })

  it('registers from the bundle, so the page needs no inline script', () => {
    expect(options.injectRegister).toBe(false)
    expect(workbox.inlineWorkboxRuntime).toBe(true)
  })

  it("writes the service worker's source map when the build writes the app's", () => {
    // Unset, the plugin follows Vite's build.sourcemap: make dist's hidden maps list the
    // packages in sw.js (source-map.ts), and a plain build writes none.
    expect(workbox.sourcemap).toBeUndefined()
  })

  it('precaches the app shell and nothing that plays', () => {
    for (const file of [
      'index.html',
      'assets/index-abc123.js',
      'assets/index-abc123.css',
      'icons/icon-192.png',
      'apple-touch-icon.png',
    ]) {
      expect(precached(file), file).toBe(true)
    }
    for (const file of [
      'song.mp3',
      'track.webm',
      'track.m4a',
      'track.opus',
      'track.flac',
      'ffmpeg-core.wasm',
      'config.json',
      'embed/index.html',
      'sandbox/innertube.html',
    ]) {
      expect(precached(file), file).toBe(false)
    }
  })

  it('caches nothing at runtime but the ffmpeg core: media and API responses go past it', () => {
    expect(workbox.runtimeCaching).toHaveLength(1)
    expect(workbox.navigationPreload).toBeUndefined()
    expect(workbox.cacheId).toBe(CACHE_ID)
    expect(workbox.cleanupOutdatedCaches).toBe(true)
  })

  it('keeps the ffmpeg core for offline saves: network first, a few versions at most', () => {
    const [rule] = workbox.runtimeCaching ?? []
    expect(rule).toMatchObject({
      handler: 'NetworkFirst',
      options: {
        cacheName: CORE_CACHE,
        expiration: { maxEntries: 6 },
        cacheableResponse: { statuses: [200] },
      },
    })
    expect(CORE_CACHE).toBe('fxm-app-ffmpeg-core')
    const pattern = coreCachePattern()
    expect(rule?.urlPattern).toEqual(pattern)
    const origin = 'https://fxmusic.pages.dev'
    for (const path of [
      '/app/ffmpeg/ffmpeg-core.json',
      '/app/ffmpeg/ffmpeg-core.js?v=0123456789abcdef',
      '/app/ffmpeg/ffmpeg-core.wasm?v=0123456789abcdef',
    ]) {
      expect(pattern.test(`${origin}${path}`), path).toBe(true)
    }
    for (const url of [
      `${origin}/app/ffmpeg/licenses/Opus-COPYING.txt`,
      `${origin}/app/ffmpeg/ffmpeg-core.wasm`,
      `${origin}/app/ffmpeg/ffmpeg-core.js`,
      `${origin}/app/ffmpeg/ffmpeg-core.json?v=0123456789abcdef`,
      `${origin}/app/ffmpeg/ffmpeg-core.wasm?v=other`,
      `${origin}/app/assets/index-abc123.js`,
      `${origin}/ffmpeg/ffmpeg-core.json`,
      'https://rr1---sn-fxm.googlevideo.com/videoplayback?id=fxm',
    ]) {
      expect(pattern.test(url), url).toBe(false)
    }
    // Workbox takes a match of another origin only from the URL's start, which this never is.
    const elsewhere = pattern.exec('https://evil.example/app/ffmpeg/ffmpeg-core.json')
    expect(elsewhere?.index).toBeGreaterThan(0)
  })

  it('answers navigations inside the app, and only those, with the cached page', () => {
    expect(workbox.navigateFallback).toBe('index.html')
    const allowed = (path: string) =>
      (workbox.navigateFallbackAllowlist ?? []).some((pattern) => pattern.test(path))
    expect(allowed('/app/')).toBe(true)
    expect(allowed('/app/library')).toBe(true)
    expect(allowed('/app/search?q=lofi')).toBe(true)
    expect(allowed('/')).toBe(false)
    expect(allowed('/embed/track/1')).toBe(false)
    expect(allowed('/sandbox/innertube.html')).toBe(false)
    expect(allowed('/privacy')).toBe(false)
  })

  it('stays on for the web build at /app/', () => {
    expect(optionsForBase(APP_BASE).disable).toBeUndefined()
  })

  it('turns off for the Android and desktop builds, which use base /', () => {
    expect(optionsForBase('/').disable).toBe(true)
  })

  it('keeps the icons out of the plugin, which would list them twice', () => {
    expect(options.includeManifestIcons).toBe(false)
  })

  it("folds the host's header rule into the page's revision", async () => {
    expect(workbox.manifestTransforms).toBeUndefined()
    const transforms = pwaOptions(APP_BASE, { headersRevision: 'h1' }).workbox?.manifestTransforms
    expect(transforms).toHaveLength(1)

    const entries = [
      { url: 'index.html', revision: 'abc', size: 1 },
      { url: 'assets/index-abc123.js', revision: null, size: 2 },
      { url: 'manifest.webmanifest', revision: 'def', size: 3 },
    ]
    const result = await transforms?.[0]?.(entries)
    expect(result?.manifest).toEqual([
      { url: 'index.html', revision: 'abc-h1', size: 1 },
      { url: 'assets/index-abc123.js', revision: null, size: 2 },
      { url: 'manifest.webmanifest', revision: 'def', size: 3 },
    ])
  })
})

describe('revisionPageWithHeaders', () => {
  it('gives the page a new revision when only the headers change', async () => {
    const page = [{ url: 'index.html', revision: 'same-content', size: 1 }]
    const before = await revisionPageWithHeaders('old-rule')(page)
    const after = await revisionPageWithHeaders('new-rule')(page)
    expect(before.manifest[0]?.revision).not.toBe(after.manifest[0]?.revision)
    expect(before.warnings).toEqual([])
  })
})
