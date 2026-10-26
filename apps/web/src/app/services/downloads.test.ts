import { DEFAULT_QUALITY_PREFS, type Track } from '@fxm/core'
import { downloadAvailability } from '@fxm/downloads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadEnvironment } from '../../features/downloads/environment'
import { createAppDownloadEnvironment } from './downloads'
import { servicesOnTier, type TierServices } from './testing/tiers'

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
