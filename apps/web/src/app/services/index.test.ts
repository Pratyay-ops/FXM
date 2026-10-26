import type { QueueItem } from '@fxm/core'
import type { ResolveRequest } from '@fxm/player'
import { testTrack } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

// startAppServices wires the app's module-wide registry, actions, player and policy, so each
// test imports the modules afresh, and takes the services it started down again.
let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  vi.resetModules()
  window.history.replaceState(null, '', '/')
  sessionStorage.clear()
})

/** A module's replacement, as `vi.doMock` takes it. */
type Replacement = Parameters<typeof vi.doMock>[1]

/** Replaces the module at `path` for the next import, or puts the real one back. */
function replaceModule(path: string, replacement: Replacement | undefined): void {
  if (replacement === undefined) vi.doUnmock(path)
  else vi.doMock(path, replacement)
}

/** The modules a test may replace: the services themselves, and the download queue's runtime. */
interface Replacements {
  readonly appServices?: Replacement
  readonly downloads?: Replacement
}

async function load(replace: Replacements = {}) {
  // All of this file's mocks and unmocks are queued here, right before the import that applies
  // them, and none in afterEach. Vitest applies its queue at the next import, whoever makes it,
  // and keeps the order only among what one import took: an unmock queued in afterEach went
  // with an import of the teardown that nothing waits for (the setup file's resetPlayback has
  // the player store make the next player, whose play recorder preloads the library), and on a
  // busy machine it could land after the next test's mock of the same module.
  replaceModule('./app-services', replace.appServices)
  replaceModule('../../features/downloads/runtime', replace.downloads)
  // The signed updates of stage 1.13 would ask this page's origin, which nothing serves here.
  const keepYouTubeCurrent = vi.fn()
  vi.doMock('./updates', () => ({ keepYouTubeCurrent }))
  // Stage 2.7's app platform, without the Lite tier's sandbox documents, which this page can't
  // frame: one platform for the test, as the app has one.
  const userHosts: (() => Iterable<string>)[] = []
  vi.doMock('../../features/connect/app-platform', async () => {
    const { createPlatform } = await import('@fxm/platform')
    let pending: ReturnType<typeof createPlatform> | undefined
    return {
      APP_PLATFORM_REACHES_USER_HOSTS: true,
      setAppUserHosts: (source: (() => Iterable<string>) | undefined) => {
        if (source !== undefined) userHosts.push(source)
      },
      getAppPlatform: () => (pending ??= createPlatform({ reportLoginRequired: false })),
    }
  })
  const services = await import('./index')
  stop = services.stopAppServices
  const { appSources } = await import('../../features/search/sources-context')
  const { appActions } = await import('../../features/search/actions')
  const { createAppPolicy } = await import('../../features/now-playing/playback-policy')
  const { getPlayer } = await import('../../features/now-playing/playback')
  const { getAppPlatform } = await import('../../features/connect/app-platform')
  const { appHomeServices } = await import('../../features/home/services')
  const { loadAppImportServices } = await import('../../features/import/services')
  const { createAppDownloadEnvironment } = await import('../../features/downloads/environment')
  const { appContext } = await import('../../lib/app-context')
  const { spotifyAccountForHome } = await import('../../features/spotify-account/start')
  return {
    ...services,
    appSources,
    appActions,
    appPolicy: createAppPolicy(),
    getPlayer,
    getAppPlatform,
    appHomeServices,
    loadAppImportServices,
    createAppDownloadEnvironment,
    appContext,
    keepYouTubeCurrent,
    userHosts,
    spotifyAccountForHome,
  }
}

const ITEM: QueueItem = { uid: 0, track: testTrack('a') }

function request(): ResolveRequest {
  return {
    reason: 'play',
    attempt: 0,
    signal: AbortSignal.timeout(5000),
    canPlay: () => 'probably',
  }
}

describe('startAppServices', () => {
  it("wires the real providers, the app's player and the library into the app", async () => {
    const { startAppServices, getAppServices, appSources, appActions } = await load()

    await startAppServices()

    // This page has no FXM Connect and no Lite tier: the Free tier. Spotify is registered, since
    // the app's platform reaches its secret through the sandbox's user-host document (stage
    // 1.10), but it can't be reached here, so the pages don't offer it. No music files were
    // added, so there is no catalog of them (stage 4.4).
    expect(getAppServices().platform?.environment).toBe('browser')
    expect(appSources.getSnapshot().capabilities.youtube).toBe('none')
    expect([...appSources.getSnapshot().providers.keys()].sort()).toEqual([
      'archive',
      'spotify',
      'yt',
      'ytm',
    ])
    expect(appSources.getSnapshot().capabilities.spotify).toBe('unreachable')
    expect(appActions.get().playback).toBeDefined()
    // "Add to playlist" lists the library's playlists (stage 2.6): Liked songs, not Downloads.
    const playlists = await appActions.get().library?.playlists()
    expect(playlists?.map((playlist) => playlist.name)).toEqual(['Liked songs'])
  })

  it("runs on the app's one platform, which stage 2.7's connection store follows too", async () => {
    const { startAppServices, getAppServices, getAppPlatform } = await load()

    await startAppServices()

    expect(getAppServices().platform).toBe(await getAppPlatform())
  })

  it("shares YouTube's kill switches and stream ladder with stage 2.7", async () => {
    const { startAppServices, getAppServices } = await load()
    const { appKillSwitches } = await import('../../features/connect/kill-switches')
    const { getSongResolver, unavailableResolver } = await import('../../features/connect/resolver')
    await startAppServices()
    expect(getSongResolver()).toBe(unavailableResolver)

    // The Diagnostics self-test resolves with the ladder once YouTube's code is in.
    const youtube = await getAppServices().youtube.load()

    expect(getSongResolver()).not.toBe(unavailableResolver)
    expect(getSongResolver().hasFallback).toBe(youtube.fallbackRung() !== undefined)
    expect(appKillSwitches()).toEqual(youtube.killSwitches())
  })

  it("keeps YouTube's config current from FXM's site, and follows its kill switches", async () => {
    const { startAppServices, getAppServices, keepYouTubeCurrent } = await load()
    const { appKillSwitches } = await import('../../features/connect/kill-switches')
    await startAppServices()
    expect(keepYouTubeCurrent).not.toHaveBeenCalled()

    const youtube = await getAppServices().youtube.load()

    // The updater loads only now, in a chunk of its own.
    await vi.waitFor(() => expect(keepYouTubeCurrent).toHaveBeenCalledWith(youtube))
    expect(appKillSwitches()).toEqual({ lite: false })
    // A newer signed config that switches the Lite tier off (what the updater activates).
    const { youtubeModule } = await import('@fxm/sources/youtube/module')
    const bundled = youtubeModule.config as { revision: number }
    const next = { ...bundled, revision: bundled.revision + 1, killSwitches: { lite: true } }
    const spec = youtube.host.updates.config
    spec.activate(spec.accept(next, { version: next.revision }), {
      origin: 'fetched',
      version: next.revision,
    })
    expect(appKillSwitches()).toEqual({ lite: true })
  })

  it("passes the Spotify secret's hosts to the app's platform", async () => {
    const { startAppServices, userHosts } = await load()
    await startAppServices()

    expect(userHosts).toHaveLength(1)
    // Known once Spotify's code has loaded, before its first fetch from them.
    expect([...(userHosts[0]?.() ?? [])]).toEqual([])
  })

  it("hands the lifecycle to the plugins' resolvers, and takes it back", async () => {
    const { startAppServices, stopAppServices, getAppServices } = await load()
    const { pluginAudioTarget } = await import('../../features/plugins/audio-target')
    await startAppServices()

    // Stage 8.3: the plugins that are on add their resolvers to the app's stream lifecycle.
    expect(pluginAudioTarget()).toBe(getAppServices().lifecycle)
    stopAppServices()
    expect(pluginAudioTarget()).toBeUndefined()
  })

  it("connects imports to the app's platform and providers", async () => {
    const { startAppServices, getAppServices, loadAppImportServices } = await load()
    const imports = loadAppImportServices()
    await startAppServices()

    const services = await imports
    const platform = getAppServices().platform
    // The app's one platform: here, the Free tier, so imports say what would find songs.
    expect(services.capabilities()).toBe(platform?.capabilities.current)
    expect(services.matching()).toBe('needs-connect')
    expect(services.context('music').capabilities).toEqual(platform?.capabilities.current)
    expect(services.autoMatch()).toBe(false)
    // Spotify follows the switch and the tier: unreachable here.
    expect(services.spotify?.isAvailable(services.context('music'))).toBe(false)
  })

  it("gives Home the app's sources, recommendations, catalog and playback", async () => {
    const { startAppServices, appHomeServices, appSources, appActions, spotifyAccountForHome } =
      await load()
    await startAppServices()

    const home = appHomeServices.get()
    // The registry's state, with the tier known now that the platform's first detection ended.
    expect(home.sources.getSnapshot()).toBe(appSources.getSnapshot())
    expect(home.sources.context({ mode: 'music' }).capabilities).toEqual(
      appSources.getSnapshot().capabilities,
    )
    expect(home.recommendations).toBeDefined()
    expect(home.catalog?.findArtist).toBeDefined()
    expect(home.catalog?.artistTracks).toBeDefined()
    expect(home.catalog?.findSong).toBeDefined()
    expect(home.playback).toBe(appActions.get().playback)
    // Stage 3.5's view of the account, with the sections its sync keeps, not the bare status.
    expect(home.spotifyAccount).toBe(spotifyAccountForHome)
  })

  it('gives Home the sources and the player at once, the tier unknown until it is', async () => {
    const { startAppServices, getAppServices, appHomeServices, appActions } = await load()
    let release: () => void = () => {}
    vi.spyOn(getAppServices(), 'start').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined)
        }),
    )

    // The platform's first detection runs (FXM Connect's answer, the Lite self-test).
    const started = startAppServices()

    await vi.waitFor(() => expect(appHomeServices.get().playback).toBeDefined())
    const home = appHomeServices.get()
    expect(home.playback).toBe(appActions.get().playback)
    // Home shows a placeholder rather than the Free tier's install pitch meanwhile.
    expect(home.sources.getSnapshot().detecting).toBe(true)
    expect(home.recommendations).toBeUndefined()
    release()
    await started
    await vi.waitFor(() => expect(home.sources.getSnapshot().detecting).not.toBe(true))
  })

  it('leaves Home to its development fakes when a tab asks for them', async () => {
    window.history.replaceState(null, '', '/app/?fake-home=full')
    const { startAppServices, appHomeServices } = await load()
    const fakeTier = () => appHomeServices.get().sources.getSnapshot().capabilities.youtube
    // The fakes plug themselves in once their module has loaded.
    await vi.waitFor(() => expect(fakeTier()).toBe('full'))
    const fakes = appHomeServices.get()

    await startAppServices()

    expect(appHomeServices.get()).toBe(fakes)
  })

  it('runs the download queue once the tier is known', async () => {
    const startDownloads = vi.fn(() => () => {})
    const { startAppServices, appSources } = await load({
      downloads: async (importOriginal) => ({
        ...(await importOriginal<object>()),
        startDownloads,
      }),
    })
    // FXM Connect's marker is on the page, and its service worker is still waking up.
    appSources.setDetecting(true)

    await startAppServices()
    await vi.dynamicImportSettled()

    // A queue that ran now would meet the Free tier, and fail the YouTube downloads it resumed.
    expect(startDownloads).not.toHaveBeenCalled()
    appSources.setDetecting(false)
    await vi.waitFor(() => expect(startDownloads).toHaveBeenCalledOnce())
  })

  it('offers the music files on this device as a catalog once there are any', async () => {
    const { startAppServices, stopAppServices, appSources } = await load()
    const { getLocalFiles, resetLocalFiles } = await import(
      '../../features/local-files/local-files'
    )
    await startAppServices()
    expect(appSources.getSnapshot().providers.has('local')).toBe(false)

    try {
      await getLocalFiles().repo.putRoot({
        id: 'root-1',
        kind: 'picked-files',
        name: 'Chosen files',
        addedAt: Date.now(),
      })

      await vi.waitFor(() => expect(appSources.getSnapshot().providers.has('local')).toBe(true))
    } finally {
      stopAppServices()
      await resetLocalFiles()
    }
  })

  it("runs downloads, lyrics, SponsorBlock and scrobbles on the app's platform", async () => {
    const {
      startAppServices,
      getAppServices,
      appActions,
      createAppDownloadEnvironment,
      appContext,
    } = await load()
    await startAppServices()
    const app = getAppServices()
    const context = vi.spyOn(app, 'context')

    // Downloads: the platform's context at the bulk priority, and the catalog's Download entry.
    expect(appActions.get().downloads).toBeDefined()
    createAppDownloadEnvironment().context()
    expect(context).toHaveBeenLastCalledWith({ priority: 'bulk' })
    // Lyrics, SponsorBlock and scrobbles: the platform's context, which the desktop and Android
    // apps send through their native HTTP.
    const signal = new AbortController().signal
    appContext('all', signal)
    expect(context).toHaveBeenLastCalledWith({ priority: 'interactive', mode: 'all', signal })
  })

  it("keeps a song resolver set before YouTube's code loaded, such as the fake mode's", async () => {
    const { startAppServices, getAppServices } = await load()
    const { getSongResolver, setSongResolver, unavailableResolver } = await import(
      '../../features/connect/resolver'
    )
    const fake = { ...unavailableResolver, hasFallback: true }
    setSongResolver(fake)
    await startAppServices()

    await getAppServices().youtube.load()

    expect(getSongResolver()).toBe(fake)
  })

  it("makes the app's player play through the services' policy", async () => {
    const { startAppServices, getAppServices, appActions, appPolicy, getPlayer } = await load()
    const services = getAppServices()
    const stream = { url: 'https://media.test/a' }
    const resolve = vi
      .spyOn(services.policy.resolver, 'resolve')
      .mockResolvedValue({ stream } as never)
    const connect = vi.spyOn(services, 'connectPlayer')

    await startAppServices()

    // The one player of stage 2.5, which the player bars and Now playing show.
    expect(connect).toHaveBeenCalledWith(getPlayer())
    expect(appActions.get().playback).toBeDefined()
    await expect(appPolicy.resolver.resolve(ITEM, request())).resolves.toEqual({ stream })
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('does it once, however often it is called', async () => {
    const { startAppServices, getAppServices } = await load()
    const services = getAppServices()
    const connect = vi.spyOn(services, 'connectPlayer')
    const start = vi.spyOn(services, 'start')

    await Promise.all([startAppServices(), startAppServices()])
    await startAppServices()

    // One player, connected once: one lifecycle attach, one set of play buttons.
    expect(connect).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
  })

  it('offers the play buttons before the platform is ready', async () => {
    const { startAppServices, getAppServices, appActions } = await load()
    let release: () => void = () => {}
    vi.spyOn(getAppServices(), 'start').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined)
        }),
    )

    // FXM Connect is still answering, say: the player's resolver waits for the platform itself.
    const started = startAppServices()

    await vi.waitFor(() => expect(appActions.get().playback).toBeDefined())
    release()
    await started
  })

  it('takes everything down again', async () => {
    const { startAppServices, stopAppServices, getAppServices, appSources, appActions } =
      await load()
    await startAppServices()
    const services = getAppServices()

    stopAppServices()

    expect(appActions.get().playback).toBeUndefined()
    expect(appActions.get().library).toBeUndefined()
    expect(appActions.get().downloads).toBeUndefined()
    expect(appSources.getSnapshot().providers.size).toBe(0)
    expect(getAppServices()).not.toBe(services)
  })

  it("lets the app's player stop with a reason when the services can't start", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { startAppServices, appSources, appPolicy } = await load({
      appServices: () => ({
        createAppServices: () => {
          throw new Error('A bug')
        },
      }),
    })

    await startAppServices()

    expect(logged).toHaveBeenCalledWith(
      'FXM: could not start the music services',
      expect.any(Error),
    )
    expect(appSources.getSnapshot().detecting).not.toBe(true)
    // Rather than wait for a policy that never comes.
    await expect(appPolicy.resolver.resolve(ITEM, request())).rejects.toMatchObject({
      name: 'FxmError',
      code: 'Unsupported',
    })
  })

  it('leaves the app to the development fake catalog when a tab asks for it', async () => {
    window.history.replaceState(null, '', '/app/search?fake=full')
    const { startAppServices, getAppServices, appSources, appPolicy } = await load()
    const start = vi.spyOn(getAppServices(), 'start')

    await startAppServices()

    expect(start).not.toHaveBeenCalled()
    expect(getAppServices().platform).toBeUndefined()
    // Its play buttons play nothing: the app's player plays local files only.
    await expect(appPolicy.resolver.resolve(ITEM, request())).rejects.toMatchObject({
      code: 'Unsupported',
    })
    // The fake catalog plugs itself in: wait for it, so it isn't still loading after the test.
    await vi.waitFor(() => expect(appSources.getSnapshot().providers.size).toBeGreaterThan(0))
  })
})
