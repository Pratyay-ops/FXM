// @vitest-environment node
// Build-time config: no DOM.
import type { ResolvedConfig } from 'vite'
import type { VitePWAOptions } from 'vite-plugin-pwa'
import { describe, expect, it } from 'vitest'
import { APP_BASE } from './manifest.ts'
import { CACHE_ID, PRECACHE_IGNORES, PRECACHE_PATTERNS, pwaOptions } from './options.ts'

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

  it('caches nothing at runtime: media, googlevideo and API responses go to the network', () => {
    expect(workbox.runtimeCaching).toBeUndefined()
    expect(workbox.navigationPreload).toBeUndefined()
    expect(workbox.cacheId).toBe(CACHE_ID)
    expect(workbox.cleanupOutdatedCaches).toBe(true)
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
})
