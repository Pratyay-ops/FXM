import {
  memoryStorage,
  memoryUpdateStore,
  type UpdateCheckOptions,
  type UpdateReport,
} from '@fxm/platform'
import { createTestSigner, fakeUpdateSite } from '@fxm/platform/testing'
import {
  createYouTubeModuleHost,
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_CONFIG_SCHEMA,
  youtubeModule,
} from '@fxm/sources/youtube/module'
import { describe, expect, it, vi } from 'vitest'
import {
  createYouTubeUpdatesStore,
  useYouTubeUpdatesStore,
} from '../../features/youtube-updates/youtube-updates-store'
import { followYouTubeUpdatesOptIn, startYouTubeUpdates } from './updates'

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

describe('F-Droid builds', () => {
  /** The reasons in a report, each once. */
  const reasons = (report: { problems: readonly { reason: string }[] } | undefined) => [
    ...new Set(report?.problems.map((problem) => problem.reason)),
  ]

  /** What the updater reported for the module. */
  async function moduleReport(options: { allowCode?: () => boolean }) {
    const site = fakeUpdateSite()
    const signer = await createTestSigner()
    const report = await startYouTubeUpdates({
      host: createYouTubeModuleHost(),
      environment: 'capacitor',
      fetch: site.fetch,
      baseUrls: [BASE],
      store: memoryUpdateStore(),
      state: memoryStorage(),
      keys: [signer.trusted],
      distribution: 'fdroid',
      ...options,
    })?.done
    return {
      site,
      module: report?.artifacts.find((artifact) => artifact.kind === 'youtube-module'),
    }
  }

  it('leave the module alone until the user opts in, and still take the config', async () => {
    // The app's own setting, off by default.
    expect(useYouTubeUpdatesStore.getState().optedIn).toBe(false)
    const { site, module } = await moduleReport({})
    expect(module?.outcome).toBe('skipped')
    // The restore and the check both report it.
    expect(reasons(module)).toEqual(['needs-opt-in'])
    expect(site.requests.some((url) => url.includes('youtube-module'))).toBe(false)
    expect(site.requests).toContain(`${BASE}${YOUTUBE_CONFIG_FILE}.sig`)
  })

  it('go on to the module once the user has opted in', async () => {
    // Node can't load code from blob:, so the updater stops at that, past the opt-in.
    const { module } = await moduleReport({ allowCode: () => true })
    expect(reasons(module)).toEqual(['code-unsupported'])
  })

  it('apply a change of the opt-in at once, and nothing else', () => {
    const store = createYouTubeUpdatesStore({ storage: () => undefined })
    const updater = { start: vi.fn(async () => ({ artifacts: [] })) }
    const unsubscribe = followYouTubeUpdatesOptIn(updater, store)
    store.getState().setOptedIn(true)
    store.getState().setOptedIn(true)
    expect(updater.start).toHaveBeenCalledOnce()
    store.getState().setOptedIn(false)
    expect(updater.start).toHaveBeenCalledTimes(2)
    unsubscribe()
    store.getState().setOptedIn(true)
    expect(updater.start).toHaveBeenCalledTimes(2)
  })

  it('cancel the start of an answer the user took back, from the app’s first start on', async () => {
    const store = createYouTubeUpdatesStore({ storage: () => undefined })
    const signals: AbortSignal[] = []
    // Starts that never end, like one whose module download is still under way.
    const updater = {
      start: vi.fn((options?: UpdateCheckOptions) => {
        if (options?.signal !== undefined) signals.push(options.signal)
        return new Promise<UpdateReport>((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))
        })
      }),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = new AbortController()
    const unsubscribe = followYouTubeUpdatesOptIn(updater, store, first)

    store.getState().setOptedIn(true)
    expect(first.signal.aborted).toBe(true)
    expect(signals.map((signal) => signal.aborted)).toEqual([false])
    store.getState().setOptedIn(false)
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    unsubscribe()
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true])
    // Cancelled on purpose: nothing to warn about.
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
  })
})
