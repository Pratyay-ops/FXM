import { DEFAULT_QUALITY_PREFS, type Track } from '@fxm/core'
import {
  createMemoryDownloadStorage,
  createMemoryDownloadStore,
  DownloadManager,
  type DownloadRecord,
  downloadAvailability,
} from '@fxm/downloads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadEnvironment } from '../../features/downloads/environment'
import { createSources } from '../../features/search/sources'
import { createAppDownloadEnvironment, startAppDownloads } from './downloads'
import { APP_URL, servicesOnTier, type TierServices } from './testing/tiers'

let setups: TierServices[] = []

afterEach(() => {
  for (const setup of setups) setup.dispose()
  setups = []
})

async function downloadsOn(
  ...args: Parameters<typeof servicesOnTier>
): Promise<{ setup: TierServices; environment: DownloadEnvironment }> {
  const setup = servicesOnTier(...args)
  setups.push(setup)
  await setup.ready()
  // happy-dom's media elements play nothing: say this device plays every stream, as a browser
  // with Opus and AAC does.
  return {
    setup,
    environment: createAppDownloadEnvironment(setup.services, { canPlay: () => 'probably' }),
  }
}

async function firstTrack(
  setup: TierServices,
  source: 'ytm' | 'archive',
  query: string,
): Promise<Track> {
  const provider = setup.sources.getSnapshot().providers.get(source)
  const results = await provider?.search(
    query,
    { types: ['track'] },
    setup.sources.context({ mode: 'music' }),
  )
  const track = results?.tracks?.items[0]
  if (track === undefined) throw new Error(`No ${source} track`)
  return track
}

function resolveRequest(environment: DownloadEnvironment) {
  return {
    ctx: environment.context(),
    prefs: DEFAULT_QUALITY_PREFS,
    reason: 'start' as const,
    attempt: 0,
    exclude: new Set<string>(),
    signal: new AbortController().signal,
  }
}

/** Downloads `track` with a manager over the app's environment, until it ends one way or another. */
async function download(environment: DownloadEnvironment, track: Track): Promise<DownloadRecord> {
  const store = createMemoryDownloadStore()
  const manager = new DownloadManager({
    store,
    storage: createMemoryDownloadStorage(),
    resolver: environment.resolver,
    context: () => environment.context(),
  })
  await manager.start()
  try {
    await manager.enqueue(track)
    await vi.waitFor(
      async () => {
        const status = (await manager.get(track))?.status
        expect(status === 'completed' || status === 'failed').toBe(true)
      },
      { timeout: 10_000, interval: 50 },
    )
    return (await manager.get(track)) as DownloadRecord
  } finally {
    await manager.destroy()
  }
}

/** The FXM page's origin, the exact Access-Control-Allow-Origin of FXM Connect 0.2.0. */
const FXM_ORIGIN = new URL(APP_URL).origin

describe('YouTube downloads when googlevideo redirects to another host (cms_redirect)', () => {
  it('fail within seconds, saying so, where FXM Connect 0.2.0 leaves the bytes unreadable', async () => {
    // FXM Connect 0.2.0 answers with the exact FXM origin, which the Origin: null the browser
    // sends after a redirect to another host doesn't match. Songs still play (a plain <audio>),
    // but a download used to stay at "Starting" for minutes, resolving again and again, and then
    // fail as a server problem.
    const { setup, environment } = await downloadsOn('full', {
      googlevideo: { googlevideo: 'redirected', googlevideoAllowOrigin: FXM_ORIGIN },
    })
    const song = await firstTrack(setup, 'ytm', 'radiohead creep')
    const started = Date.now()
    const record = await download(environment, song)
    expect(record).toMatchObject({ status: 'failed', error: { code: 'redirected' } })
    expect(Date.now() - started).toBeLessThan(5_000)
    // One /player call: no fallback URL and no fresh resolution, which couldn't be read either.
    expect(setup.network.players).toHaveLength(1)
  })

  it('complete with FXM Connect 0.2.1, whose answers allow any origin', async () => {
    const { setup, environment } = await downloadsOn('full', {
      googlevideo: { googlevideo: 'redirected' },
    })
    const song = await firstTrack(setup, 'ytm', 'radiohead creep')
    expect(await download(environment, song)).toMatchObject({ status: 'completed' })
    // The bytes came from the host googlevideo redirected to.
    expect(setup.network.requests.some((request) => request.url.includes('cms_redirect=yes'))).toBe(
      true,
    )
  })

  it("fail at once, saying so, where the browser won't let FXM read googlevideo at all", async () => {
    const { setup, environment } = await downloadsOn('full', {
      googlevideo: { googlevideo: 'refused' },
    })
    const song = await firstTrack(setup, 'ytm', 'radiohead creep')
    expect(await download(environment, song)).toMatchObject({
      status: 'failed',
      error: { code: 'unreadable' },
    })
    expect(setup.network.players).toHaveLength(1)
  })
})

describe("downloads on the app's services", () => {
  it('download a YouTube Music song with FXM Connect: a URL that passed the end-of-file probe', async () => {
    const { setup, environment } = await downloadsOn('full')
    const song = await firstTrack(setup, 'ytm', 'radiohead creep')
    const ctx = environment.context()

    expect(ctx.capabilities.mediaBytes).toBe(true)
    expect(downloadAvailability(song, ctx, environment.resolver)).toEqual({ available: true })
    const found = await environment.resolver.resolve(song, resolveRequest(environment))

    expect(found.candidate).toMatchObject({ source: 'ytm', ref: song.id.split(':')[2] })
    expect(found.stream.fullLength).toBe('verified')
    // The same ladder the player uses: one /player call, then the probe of the file's end.
    expect(setup.network.players).toEqual([song.id.split(':')[2]])
    expect(
      setup.network.requests.some((request) => request.headers.range?.startsWith('bytes=')),
    ).toBe(true)
  })

  it('never offer YouTube songs in the Lite tier, where their bytes are unreadable', async () => {
    const { setup, environment } = await downloadsOn('lite')
    const song = await firstTrack(setup, 'ytm', 'radiohead creep')
    const archive = await firstTrack(setup, 'archive', 'nine inch nails ghosts')
    const ctx = environment.context()

    expect(ctx.capabilities.mediaBytes).toBe(false)
    expect(downloadAvailability(song, ctx, environment.resolver).available).toBe(false)
    // Internet Archive's files are readable on every tier.
    expect(downloadAvailability(archive, ctx, environment.resolver)).toEqual({ available: true })
  })

  it('download Internet Archive tracks in the Free tier, from the item’s own file', async () => {
    const { setup, environment } = await downloadsOn('free')
    const archive = await firstTrack(setup, 'archive', 'nine inch nails ghosts')

    const found = await environment.resolver.resolve(archive, resolveRequest(environment))

    expect(found.candidate.source).toBe('archive')
    expect(new URL(found.stream.url).hostname).toMatch(/archive\.org$/)
    expect(setup.network.players).toEqual([])
  })

  it('say when what the platform reaches changes', async () => {
    const { setup, environment } = await downloadsOn('full', { connect: {} })
    const listener = vi.fn()
    const stop = environment.subscribe(listener)

    setup.connect?.uninstall()
    await vi.waitFor(() =>
      expect(setup.sources.getSnapshot().capabilities.youtube).not.toBe('full'),
    )

    expect(listener).toHaveBeenCalled()
    expect(environment.context().capabilities.mediaBytes).toBe(false)
    stop()
  })
})

describe('the download queue', () => {
  /** The runtime of stage 4.1, as far as starting the queue goes. */
  function fakeRuntime() {
    const stop = vi.fn()
    const startDownloads = vi.fn(() => stop)
    const load = vi.fn(async () => ({ startDownloads }))
    return { load, startDownloads, stop }
  }

  it('starts at once when the tier is known, loading its code right away', async () => {
    const sources = createSources()
    const runtime = fakeRuntime()

    const stop = startAppDownloads(sources, runtime.load)

    expect(runtime.load).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(runtime.startDownloads).toHaveBeenCalledOnce())
    stop()
    expect(runtime.stop).toHaveBeenCalledOnce()
  })

  it('waits while FXM Connect is still answering, so no download meets the Free tier', async () => {
    const sources = createSources()
    sources.setDetecting(true)
    const runtime = fakeRuntime()

    startAppDownloads(sources, runtime.load)
    // Its code loads meanwhile, so a Download click finds it there.
    expect(runtime.load).toHaveBeenCalledOnce()
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.startDownloads).not.toHaveBeenCalled()

    sources.setDetecting(false)
    await vi.waitFor(() => expect(runtime.startDownloads).toHaveBeenCalledOnce())
    // Later changes of the registry start nothing more.
    sources.setDetecting(true)
    sources.setDetecting(false)
    await Promise.resolve()
    expect(runtime.startDownloads).toHaveBeenCalledOnce()
  })

  it('never starts once stopped, also while its code is still loading', async () => {
    const sources = createSources()
    sources.setDetecting(true)
    const waiting = fakeRuntime()
    startAppDownloads(sources, waiting.load)()
    sources.setDetecting(false)

    let release: () => void = () => {}
    const loading = fakeRuntime()
    const slow = () =>
      new Promise<{ startDownloads: () => () => void }>((resolve) => {
        release = () => resolve({ startDownloads: loading.startDownloads })
      })
    startAppDownloads(createSources(), slow)()
    release()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(waiting.startDownloads).not.toHaveBeenCalled()
    expect(loading.startDownloads).not.toHaveBeenCalled()
  })

  it('says when its code could not be loaded, without throwing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    startAppDownloads(createSources(), () => Promise.reject(new Error('Chunk gone')))
    await vi.waitFor(() =>
      expect(logged).toHaveBeenCalledWith('FXM: could not start the downloads', expect.any(Error)),
    )
  })
})
