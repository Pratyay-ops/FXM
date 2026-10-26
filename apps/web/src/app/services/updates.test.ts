import { memoryStorage, memoryUpdateStore } from '@fxm/platform'
import { createTestSigner, fakeUpdateSite } from '@fxm/platform/testing'
import {
  createYouTubeModuleHost,
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_CONFIG_SCHEMA,
  youtubeModule,
} from '@fxm/sources/youtube/module'
import { describe, expect, it, vi } from 'vitest'
import { startYouTubeUpdates } from './updates'

const ORIGIN = 'https://fxmusic.pages.dev'
const BASE = `${ORIGIN}/updates/`

/** The bundled config with a higher revision and the Lite tier switched off. */
function newerConfig() {
  const bundled = youtubeModule.config as { revision: number }
  return { ...bundled, revision: bundled.revision + 1, killSwitches: { lite: true } }
}

/** A fake site that serves a newer config, signed with a throwaway key the test trusts. */
async function siteWithNewerConfig() {
  const signer = await createTestSigner()
  const site = fakeUpdateSite()
  const config = newerConfig()
  const bytes = JSON.stringify(config)
  const signed = await signer.sign({
    kind: YOUTUBE_CONFIG_KIND,
    version: config.revision,
    file: YOUTUBE_CONFIG_FILE,
    api: YOUTUBE_CONFIG_SCHEMA,
    bytes: new TextEncoder().encode(bytes),
  })
  site.publish(BASE, YOUTUBE_CONFIG_FILE, bytes, signed)
  return { site, signer, config }
}

describe('startYouTubeUpdates', () => {
  it("takes a newer signed config from the page's own origin, and no code, in a browser", async () => {
    const { site, signer, config } = await siteWithNewerConfig()
    const host = createYouTubeModuleHost()
    const changed = vi.fn()
    host.subscribe(changed)

    const updates = startYouTubeUpdates({
      host,
      environment: 'browser',
      origin: ORIGIN,
      fetch: site.fetch,
      store: memoryUpdateStore(),
      state: memoryStorage(),
      keys: [signer.trusted],
    })
    await updates?.done

    expect(host.current().configRevision).toBe(config.revision)
    expect((host.current().config as { killSwitches: unknown }).killSwitches).toEqual({
      lite: true,
    })
    expect(changed).toHaveBeenCalledOnce()
    // Only the config: the web app's policy never lets it load code from blob:.
    expect(site.requests.every((url) => url.startsWith(BASE))).toBe(true)
    expect(site.requests.some((url) => url.includes('youtube-module'))).toBe(false)
  })

  it('keeps the config it ships with when the site has nothing signed, or a key it does not trust', async () => {
    const { site } = await siteWithNewerConfig()
    const host = createYouTubeModuleHost()
    const bundled = host.current().configRevision

    // The build's own keys never signed this throwaway config.
    const report = await startYouTubeUpdates({
      host,
      environment: 'browser',
      origin: ORIGIN,
      fetch: site.fetch,
      store: memoryUpdateStore(),
      state: memoryStorage(),
    })?.done
    const empty = fakeUpdateSite()
    await startYouTubeUpdates({
      host,
      environment: 'browser',
      origin: ORIGIN,
      fetch: empty.fetch,
      store: memoryUpdateStore(),
      state: memoryStorage(),
    })?.done

    expect(host.current().configRevision).toBe(bundled)
    expect(report?.artifacts.flatMap((artifact) => artifact.problems).length).toBeGreaterThan(0)
    expect(empty.requests).toEqual([`${BASE}${YOUTUBE_CONFIG_FILE}.sig`])
  })

  it('also keeps the module current in the desktop and Android apps, from the site', async () => {
    const site = fakeUpdateSite()
    const signer = await createTestSigner()

    const report = await startYouTubeUpdates({
      host: createYouTubeModuleHost(),
      environment: 'tauri',
      fetch: site.fetch,
      store: memoryUpdateStore(),
      state: memoryStorage(),
      keys: [signer.trusted],
    })?.done

    // The module first, then the config, from FXM's site whatever the webview's origin. (Node
    // can't import code from blob:, so the module is checked for, not downloaded, here.)
    expect(report?.artifacts.map((artifact) => artifact.kind)).toEqual([
      'youtube-module',
      'youtube-config',
    ])
    expect(site.requests).toContain(`${BASE}${YOUTUBE_CONFIG_FILE}.sig`)
    expect(site.requests.every((url) => url.startsWith(BASE))).toBe(true)
  })

  it('does nothing where there is nowhere to update from', () => {
    const host = createYouTubeModuleHost()
    expect(startYouTubeUpdates({ host, environment: 'node' })).toBeUndefined()
    expect(startYouTubeUpdates({ host, environment: 'browser', origin: 'null' })).toBeUndefined()
  })
})
