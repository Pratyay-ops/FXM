import {
  type AudioCandidate,
  type FxmError,
  formatId,
  isFxmError,
  type MetadataProvider,
  type SourceId,
  type Track,
} from '@fxm/core'
import type { PlatformOptions } from '@fxm/platform'
import { createStaticNetworkMonitor, Player } from '@fxm/player'
import { FakeEngine } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMediaActionsStore } from '../../features/search/actions'
import { createSources, sourceAvailability } from '../../features/search/sources'
import { createAppServices } from './app-services'
import { createMemoryStore, RUNG_HEALTH_KEY, VISITOR_DATA_KEY } from './device-store'
import { FAKE_VISITOR_DATA } from './testing/fake-network'
import { servicesOnTier, type TierServices } from './testing/tiers'

let setups: TierServices[] = []

afterEach(() => {
  for (const setup of setups) setup.dispose()
  setups = []
})

function setUp(...args: Parameters<typeof servicesOnTier>): TierServices {
  const setup = servicesOnTier(...args)
  setups.push(setup)
  return setup
}

function provider(setup: TierServices, id: SourceId): MetadataProvider {
  const found = setup.sources.getSnapshot().providers.get(id)
  if (found === undefined) throw new Error(`No ${id} provider`)
  return found
}

/** A player on a fake engine, connected to the services as the app's is. */
function playerFor(setup: TierServices) {
  const engine = new FakeEngine()
  const player = new Player({ engine, resolver: setup.services.resolver, retryDelaysMs: [0] })
  const disconnect = setup.services.connectPlayer(player)
  return { engine, player, disconnect }
}

/** Plays `tracks` from the first, as a tap on a catalog page does. */
function play(setup: TierServices, tracks: readonly Track[]): void {
  const { playback } = setup.actions.get()
  if (playback === undefined) throw new Error('No playback actions')
  playback.play(tracks, { startIndex: 0 })
}

/** Waits until `check` passes, on real timers. */
async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The videoId of a YouTube track. */
function videoId(track: Track | undefined): string | undefined {
  return track?.id.split(':')[2]
}

async function searchSongs(setup: TierServices): Promise<Track[]> {
  const results = await provider(setup, 'ytm').search(
    'radiohead creep',
    { types: ['track'] },
    setup.sources.context({ mode: 'music' }),
  )
  return results.tracks?.items ?? []
}

async function searchArchive(setup: TierServices): Promise<Track[]> {
  const results = await provider(setup, 'archive').search(
    'nine inch nails ghosts',
    { types: ['track'] },
    setup.sources.context({ mode: 'music' }),
  )
  return results.tracks?.items ?? []
}

/** A Spotify track, which has no audio of its own: it plays its matched song. */
const SPOTIFY_CREEP: Track = {
  id: formatId('spotify', 'track', '70LcF31zb1H0PyJoS1Sx1r'),
  source: 'spotify',
  title: 'Creep',
  artists: [{ name: 'Radiohead' }],
  durationMs: 238_640,
  artwork: [],
  kind: 'song',
}

describe('the Full tier (FXM Connect)', () => {
  it('searches YouTube Music, plays a song and then the next one', async () => {
    const setup = setUp('full')
    await setup.ready()
    expect(setup.sources.getSnapshot().capabilities.youtube).toBe('full')

    const songs = await searchSongs(setup)
    expect(songs.length).toBeGreaterThan(2)
    const { engine, player } = playerFor(setup)
    play(setup, songs)

    await until(() => engine.loadedUrls.length === 1, 'the first stream')
    const first = new URL(engine.loadedUrls[0] ?? '')
    expect(first.hostname).toMatch(/\.googlevideo\.com$/)
    expect(first.searchParams.get('id')).toBe(videoId(songs[0]))
    // FXM Connect makes googlevideo's bytes readable, so the end-of-file probe ran.
    expect(player.getState().stream?.fullLength).toBe('verified')

    engine.end()
    await until(() => engine.loadedUrls.length === 2, 'the next stream')
    expect(new URL(engine.loadedUrls[1] ?? '').searchParams.get('id')).toBe(videoId(songs[1]))
  })

  it('keeps one server-issued visitorData for the device, saved for the next visit', async () => {
    const setup = setUp('full')
    await setup.ready()
    await searchSongs(setup)
    await searchSongs(setup)

    const swJsData = setup.network.requests.filter((request) => request.url.endsWith('sw.js_data'))
    expect(swJsData).toHaveLength(1)
    expect(await setup.store.get(VISITOR_DATA_KEY)).toBe(FAKE_VISITOR_DATA)
  })

  it('remembers the rung that played, for the next visit', async () => {
    const setup = setUp('full')
    await setup.ready()
    const { engine } = playerFor(setup)
    play(setup, (await searchSongs(setup)).slice(0, 1))
    await until(() => engine.loadedUrls.length === 1, 'the stream')

    // VISIONOS's URL passed the end-of-file probe: the rung worked, and the device keeps that.
    await until(async () => (await setup.store.get(RUNG_HEALTH_KEY)) !== undefined, 'the health')
    expect(JSON.stringify(await setup.store.get(RUNG_HEALTH_KEY))).toContain('visionos')
  })

  it('offers Spotify while its switch is on, and not once it is off', async () => {
    const setup = setUp('full')
    await setup.ready()
    expect(sourceAvailability(setup.sources.getSnapshot(), 'spotify').status).toBe('available')

    setup.sources.setSpotifyEnabled(false)

    expect(sourceAvailability(setup.sources.getSnapshot(), 'spotify').status).toBe('spotify-off')
  })

  it('plays a Spotify track as its matched song after a tap, and marks it for review', async () => {
    const setup = setUp('full')
    await setup.ready()
    const { engine } = playerFor(setup)
    const reviewed: [Track, AudioCandidate][] = []
    setup.services.policy.onNeedsReview((track, guess) => reviewed.push([track, guess]))

    play(setup, [SPOTIFY_CREEP])

    await until(() => engine.loadedUrls.length === 1, 'the matched song')
    const played = new URL(engine.loadedUrls[0] ?? '').searchParams.get('id')
    const songs = await searchSongs(setup)
    expect(songs.map(videoId)).toContain(played)
    // The Auto band is off until stage 1.12's report allows it, so the match is a best guess:
    // it played because the user asked for this very track, and it waits for their review.
    expect(reviewed.map(([track, guess]) => [track.id, guess.ref])).toEqual([
      [SPOTIFY_CREEP.id, played],
    ])
    const alternatives = await setup.services.policy.alternatives(
      SPOTIFY_CREEP,
      new AbortController().signal,
    )
    expect(alternatives[0]?.ref).toBe(played)
  })

  it('takes the play buttons away again when the player disconnects', async () => {
    const setup = setUp('full')
    await setup.ready()
    const { disconnect } = playerFor(setup)
    expect(setup.actions.get().playback).toBeDefined()

    disconnect()

    expect(setup.actions.get().playback).toBeUndefined()
  })
})

describe('the Lite tier (the sandbox documents of stage 1.10)', () => {
  it('searches through the sandbox, plays without a probe and then the next song', async () => {
    const setup = setUp('lite')
    await setup.ready()
    expect(setup.sources.getSnapshot().capabilities.youtube).toBe('simple')

    const songs = await searchSongs(setup)
    expect(setup.sandbox?.requests.map((request) => new URL(request.url).pathname)).toContain(
      '/youtubei/v1/search',
    )
    const { engine, player } = playerFor(setup)
    play(setup, songs)

    await until(() => engine.loadedUrls.length === 1, 'the first stream')
    expect(new URL(engine.loadedUrls[0] ?? '').searchParams.get('id')).toBe(videoId(songs[0]))
    // googlevideo's bytes can't be read here: the media element's first request is the probe.
    expect(player.getState().stream?.fullLength).toBe('unverified')
    expect(setup.network.requests.some((request) => request.url.includes('googlevideo'))).toBe(
      false,
    )

    engine.end()
    await until(() => engine.loadedUrls.length === 2, 'the next stream')
    expect(new URL(engine.loadedUrls[1] ?? '').searchParams.get('id')).toBe(videoId(songs[1]))
  })

  it('tells the ladder which rung started playing', async () => {
    const setup = setUp('lite')
    await setup.ready()
    const { engine } = playerFor(setup)
    play(setup, (await searchSongs(setup)).slice(0, 1))
    await until(() => engine.loadedUrls.length === 1, 'the stream')

    const ctx = setup.services.context({ priority: 'interactive' })
    const youtube = await setup.services.youtube.load()
    await until(() => engine.count('play') > 0, 'the first play')
    const health = await youtube.audio.health(ctx)
    expect(health.scope).toBe('web/simple')
    expect(health.lastWorking).toBe('visionos')
  })

  it("can't reach Spotify", async () => {
    const setup = setUp('lite')
    await setup.ready()

    expect(sourceAvailability(setup.sources.getSnapshot(), 'spotify').status).toBe(
      'spotify-unreachable',
    )
  })
})

describe('the Free tier (no FXM Connect, no Lite)', () => {
  it('plays Internet Archive tracks, then the next one', async () => {
    const setup = setUp('free')
    await setup.ready()
    expect(setup.sources.getSnapshot().capabilities.youtube).toBe('none')

    const tracks = await searchArchive(setup)
    expect(tracks.length).toBeGreaterThan(1)
    const { engine } = playerFor(setup)
    play(setup, tracks)

    await until(() => engine.loadedUrls.length === 1, 'the first stream')
    const first = new URL(engine.loadedUrls[0] ?? '')
    expect(first.hostname).toBe('archive.org')
    engine.end()
    await until(() => engine.loadedUrls.length === 2, 'the next stream')
    expect(new URL(engine.loadedUrls[1] ?? '').pathname).not.toBe(first.pathname)
  })

  it('never calls YouTube: searching it is refused before any request', async () => {
    const setup = setUp('free')
    await setup.ready()

    const search = searchSongs(setup)

    await expect(search).rejects.toSatisfy((error: unknown) => isFxmError(error, 'Unsupported'))
    expect(setup.network.requests.filter((request) => request.url.includes('youtube'))).toEqual([])
    expect(sourceAvailability(setup.sources.getSnapshot(), 'ytm').status).toBe('needs-youtube')
  })

  it('stops on a YouTube song until the user acts, instead of skipping through the queue', async () => {
    const full = setUp('full')
    await full.ready()
    const songs = await searchSongs(full)
    const setup = setUp('free')
    await setup.ready()
    const { player, engine } = playerFor(setup)

    play(setup, songs)

    await until(() => player.getState().status === 'error', 'the stop')
    expect(player.getState().error?.reason).toBe('action-required')
    expect((player.getState().error?.error as FxmError | undefined)?.code).toBe('Unsupported')
    expect(engine.loadedUrls).toEqual([])
  })
})

describe('the platform', () => {
  it('is created with the options the services need', async () => {
    const created: PlatformOptions[] = []
    const sources = createSources()
    const services = createAppServices({
      createPlatform: async (options) => {
        created.push(options)
        throw new Error('no platform in this test')
      },
      sources,
      actions: createMediaActionsStore(),
      deviceStore: createMemoryStore(),
      jamendoClientId: undefined,
      network: createStaticNetworkMonitor(),
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    // A platform that fails to start leaves the app in the Free tier's stand-in, with its
    // sources listed, rather than with no app at all.
    await expect(services.start()).resolves.toBeUndefined()
    services.dispose()

    const [options] = created
    // The stream ladder reports the bot checks it tells apart from age gates; the transport
    // must not count them again.
    expect(options?.reportLoginRequired).toBe(false)
    expect(options?.killSwitches).toBeDefined()
    expect(typeof options?.userHosts).toBe('function')
    expect(error).toHaveBeenCalledOnce()
  })
})
