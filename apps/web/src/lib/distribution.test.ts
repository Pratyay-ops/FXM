import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugins from '../features/plugins/distribution'
import { BUILD_DISTRIBUTION, distributionOf } from './distribution'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

/**
 * Builds the app again with `flag` naming F-Droid (a fresh module graph), and says whether the
 * plugins and the YouTube code updates each wait for the user's opt-in.
 */
async function gatesWith(flag: string) {
  vi.resetModules()
  vi.stubEnv(flag, 'fdroid')
  const { pluginsNeedOptIn } = await import('../features/plugins/runtime')
  const { startYouTubeUpdates } = await import('../app/services/updates')
  const { memoryStorage, memoryUpdateStore } = await import('@fxm/platform')
  const { createTestSigner, fakeUpdateSite } = await import('@fxm/platform/testing')
  const { createYouTubeModuleHost } = await import('@fxm/sources/youtube/module')
  const report = await startYouTubeUpdates({
    host: createYouTubeModuleHost(),
    environment: 'capacitor',
    fetch: fakeUpdateSite().fetch,
    baseUrls: ['https://fxmusic.pages.dev/updates/'],
    store: memoryUpdateStore(),
    state: memoryStorage(),
    keys: [(await createTestSigner()).trusted],
  })?.done
  const youtubeModule = report?.artifacts.find((artifact) => artifact.kind === 'youtube-module')
  return {
    plugins: pluginsNeedOptIn(),
    youtube: youtubeModule?.problems.some((problem) => problem.reason === 'needs-opt-in'),
  }
}

describe('the build’s distribution', () => {
  it('is standard without flags, and F-Droid when either flag names it', () => {
    expect(distributionOf(undefined, undefined)).toBe('standard')
    expect(distributionOf('', 'standard')).toBe('standard')
    expect(distributionOf('fdroid', undefined)).toBe('fdroid')
    expect(distributionOf(undefined, 'F-Droid')).toBe('fdroid')
    expect(distributionOf('standard', 'fdroid')).toBe('fdroid')
  })

  it('takes a flag it doesn’t know for F-Droid, which asks first', () => {
    expect(distributionOf('fdorid', undefined)).toBe('fdroid')
    expect(distributionOf(undefined, 'github')).toBe('fdroid')
  })

  it('is standard in the test build, which sets neither flag', () => {
    expect(BUILD_DISTRIBUTION).toBe('standard')
  })

  it('is the one gate that plugins and the YouTube code updates read', () => {
    expect(plugins.distributionOf).toBe(distributionOf)
    expect(plugins.BUILD_DISTRIBUTION).toBe(BUILD_DISTRIBUTION)
  })

  it('makes plugins and the YouTube code updates ask first with VITE_FXM_DISTRIBUTION=fdroid', async () => {
    expect(await gatesWith('VITE_FXM_DISTRIBUTION')).toEqual({ plugins: true, youtube: true })
  })

  it('makes both ask first with FXM_DISTRIBUTION=fdroid alone, once stage 6.6 builds it in', async () => {
    // Stage 6.6's vite.config.ts builds FXM_DISTRIBUTION in; Vite alone builds in only VITE_
    // variables (packaging/fdroid/build.sh sets both).
    expect(await gatesWith('FXM_DISTRIBUTION')).toEqual({ plugins: true, youtube: true })
  })

  it('leaves both open in a standard build', async () => {
    expect(await gatesWith('VITE_FXM_DISTRIBUTION_UNUSED')).toEqual({
      plugins: false,
      youtube: false,
    })
  })
})
