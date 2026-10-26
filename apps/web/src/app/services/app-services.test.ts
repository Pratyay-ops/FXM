import {
  type AudioCandidate,
  type CatalogMode,
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
import {
  createSources,
  type SourcesSnapshot,
  searchSourceIds,
  sourceAvailability,
} from '../../features/search/sources'
import { useQualityStore } from '../../features/settings/quality-store'
import { createAppServices } from './app-services'
import { createMemoryStore, RUNG_HEALTH_KEY, VISITOR_DATA_KEY } from './device-store'
import type { LibraryMatchDecision, LibraryRepository } from './library'
import { FAKE_VISITOR_DATA } from './testing/fake-network'
import { servicesOnTier, type TierServices, untilSources } from './testing/tiers'
import type { YouTubeModule } from './youtube'

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
function playerFor(setup: TierServices, mode: CatalogMode = 'music') {
  const engine = new FakeEngine()
  const player = new Player({
    engine,
    resolver: setup.services.resolver,
    retryDelaysMs: [0],
    queue: { mode },
  })
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

/** A YouTube video that isn't a catalog song: Music + Video mode plays it as music. */
const CREEP_VIDEO: Track = {
  id: formatId('ytm', 'track', 'XFkzRNyygfk'),
  source: 'ytm',
  title: 'Radiohead - Creep (live)',
  artists: [{ name: 'Radiohead' }],
  durationMs: 241_000,
  artwork: [],
  kind: 'video',
}

/** A user-host document that answers every request with a 404, like a secret that moved. */
const missingSecret = () => new Response('{}', { status: 404 })

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

  it('streams at the quality chosen in Settings (stage 4.3)', async () => {
    const setup = setUp('full')
    await setup.ready()
    const songs = (await searchSongs(setup)).slice(0, 2)
    const { engine, player } = playerFor(setup)
    play(setup, songs.slice(0, 1))
    await until(() => engine.loadedUrls.length === 1, 'the first stream')
    expect(player.getState().stream?.tier).not.toBe('low')

    useQualityStore.getState().setDataSaver(true)
    play(setup, songs.slice(1))

    // The data saver streams at Low on every connection, from the next stream on.
    await until(() => engine.loadedUrls.length === 2, 'the next stream')
    expect(player.getState().stream?.tier).toBe('low')
  })

  it("tells the app once YouTube's code has loaded, with its config and ladder", async () => {
    const loaded: string[] = []
    const setup = setUp('full', {
      onYouTube: (youtube) => loaded.push(`${typeof youtube.killSwitches()}:${youtube.audio.id}`),
    })
    await setup.ready()

    await setup.services.youtube.load()
    await setup.services.youtube.load()

    expect(loaded).toEqual(['object:ytm'])
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

  it("doesn't offer Spotify in a browser without the sandbox's user-host document", async () => {
    const setup = setUp('full')
    await setup.ready()
    const snapshot = setup.sources.getSnapshot()

    // FXM Connect reaches Spotify, but its anonymous token needs the TOTP secret, whose hosts
    // only the user-host document of stage 1.10 reaches: every call would fail at once. So the
    // search page has no Spotify chip, and a Spotify link says this version can't read it.
    expect(snapshot.capabilities.spotify).toBe('anonymous')
    expect(searchSourceIds(snapshot)).toEqual(['ytm', 'archive'])
    expect(sourceAvailability(snapshot, 'spotify').status).toBe('missing')
  })

  it('offers Spotify with the user-host document, while its switch is on', async () => {
    const setup = setUp('full', { userHost: missingSecret })
    await setup.ready()
    expect(searchSourceIds(setup.sources.getSnapshot())).toEqual(['ytm', 'spotify', 'archive'])

    setup.sources.setSpotifyEnabled(false)

    expect(sourceAvailability(setup.sources.getSnapshot(), 'spotify').status).toBe('spotify-off')
  })

  it("asks for Spotify's secret through the sandbox's user-host document (stage 1.10)", async () => {
    const setup = setUp('full', { userHost: missingSecret })
    await setup.ready()

    await provider(setup, 'spotify')
      .search('creep', { types: ['track'] }, setup.sources.context({ mode: 'music' }))
      .catch(() => {})

    const hosts = setup.sandbox?.userHostRequests.map((request) => new URL(request.url).host)
    expect(hosts).toContain('raw.githubusercontent.com')
    expect(setup.network.requests.filter((request) => request.url.includes('github'))).toEqual([])
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
    // Spotify can't be read here, so MusicBrainz's exact path was asked for the ISRC instead.
    expect(setup.network.requests.some((request) => request.url.includes('musicbrainz'))).toBe(true)
  })

  it("asks Spotify about a track's ISRC only while its switch is on", async () => {
    const on = setUp('full', { userHost: missingSecret })
    const off = setUp('full', { userHost: missingSecret, spotifyEnabled: false })
    for (const setup of [on, off]) {
      await setup.ready()
      const { engine } = playerFor(setup)
      play(setup, [SPOTIFY_CREEP])
      await until(() => engine.loadedUrls.length === 1, 'the matched song')
    }

    // Asking Spotify starts with its secret, through the user-host document. Switched off,
    // Spotify's code isn't even loaded, so its secret's hosts never reach the platform.
    expect(on.sandbox?.userHostRequests).not.toEqual([])
    expect(off.sandbox?.userHostRequests).toEqual([])
    expect(off.platformOptions()?.userHosts?.()).toEqual([])
  })

  it('plays a video as music in Music + Video mode, and hides it in Music mode', async () => {
    const all = setUp('full', { mode: 'all' })
    await all.ready()
    const { engine } = playerFor(all, 'all')

    play(all, [CREEP_VIDEO])

    await until(() => engine.loadedUrls.length === 1, 'the video')
    expect(new URL(engine.loadedUrls[0] ?? '').searchParams.get('id')).toBe(videoId(CREEP_VIDEO))
    expect(all.network.players).toEqual([videoId(CREEP_VIDEO)])

    const music = setUp('full')
    await music.ready()
    const { player } = playerFor(music)
    play(music, [CREEP_VIDEO])
    expect(player.getState().queue.items).toEqual([])
  })

  it('takes the play buttons away again when the player disconnects', async () => {
    const setup = setUp('full')
    await setup.ready()
    const { disconnect } = playerFor(setup)
    expect(setup.actions.get().playback).toBeDefined()

    disconnect()

    expect(setup.actions.get().playback).toBeUndefined()
  })

  it('leaves the play buttons to a player connected later', async () => {
    const setup = setUp('full')
    await setup.ready()
    const first = playerFor(setup)
    playerFor(setup)
    const playback = setup.actions.get().playback

    // Stage 2.5's player taking over from an earlier one, say.
    first.disconnect()

    expect(setup.actions.get().playback).toBe(playback)
    expect(playback).toBeDefined()
  })
})

describe('detecting FXM Connect', () => {
  it('says the tier is known as soon as FXM Connect answers', async () => {
    const setup = setUp('full')
    expect(setup.sources.getSnapshot().detecting).toBe(true)

    await setup.ready()

    expect(setup.sources.getSnapshot()).toMatchObject({
      detecting: false,
      capabilities: { youtube: 'full' },
    })
  })

  it('waits for an answer that comes after the platform stopped waiting', async () => {
    const setup = setUp('full', { connect: { answerPings: false } })
    const seen: SourcesSnapshot[] = []
    setup.sources.subscribe(() => seen.push(setup.sources.getSnapshot()))

    // A service worker that wakes up slowly: no answer within the platform's 800 ms.
    await setup.ready()
    expect(setup.sources.getSnapshot()).toMatchObject({
      detecting: true,
      capabilities: { youtube: 'none' },
    })
    setup.connect?.update({ answerPings: true, version: '0.1.1' })

    await untilSources(setup.sources, (snapshot) => snapshot.detecting === false)
    expect(setup.sources.getSnapshot().capabilities.youtube).toBe('full')
    // The pages never saw the Free tier as settled meanwhile, so they never offered the install.
    expect(
      seen.filter((snapshot) => !snapshot.detecting && snapshot.capabilities.youtube === 'none'),
    ).toEqual([])
  })

  it("doesn't wait without FXM Connect's marker", async () => {
    const setup = setUp('free')
    expect(setup.sources.getSnapshot().detecting).toBe(false)

    await setup.ready()

    expect(setup.sources.getSnapshot().detecting).toBe(false)
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

  it('creates the platform at once, and runs the self-test once the kill switch is known', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const setup = setUp('lite', {
      importYouTube: async (): Promise<YouTubeModule> => {
        await held
        return import('@fxm/sources/youtube')
      },
    })

    // The YouTube config, which holds the Lite kill switch, hasn't loaded: the platform runs
    // anyway, with the Lite tier switched off and no request sent to YouTube.
    const platform = await setup.services.start()
    expect(platform?.lite?.state).toBe('killed')
    expect(setup.sandbox?.selfTests).toBe(0)

    release()

    await untilSources(setup.sources, (snapshot) => snapshot.capabilities.youtube === 'simple')
    expect(setup.sandbox?.selfTests).toBe(1)
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

  it('counts a rung as working only once the engine says it plays', async () => {
    const setup = setUp('lite')
    await setup.ready()
    const youtube = await setup.services.youtube.load()
    // The live ladder calls the instance in use, whose method the spy replaces.
    const reported = vi.spyOn(youtube.host.providers().audio, 'reportPlaybackSuccess')
    const { engine, player } = playerFor(setup)
    engine.startOnPlay = false
    play(setup, (await searchSongs(setup)).slice(0, 1))
    await until(() => engine.count('play') === 1, 'the first play')
    // Paused before a byte played, e.g. while the stream resolved.
    player.pause()

    // Playing again says `playing` (with `buffering`) at once, before the engine played a byte.
    await player.play()
    expect(player.getState()).toMatchObject({ status: 'playing', buffering: true })
    expect(reported).not.toHaveBeenCalled()

    engine.emit('play', undefined)

    expect(reported).toHaveBeenCalledOnce()
    expect(reported.mock.calls[0]?.[0]).toBe(player.getState().stream)
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

/** A library like stage 2.6's repository, as far as the services use it. */
function fakeLibrary() {
  const decisions = new Map<string, LibraryMatchDecision>()
  const library = {
    getPlaylistList: vi.fn(async () => ({
      items: [
        {
          id: formatId('local', 'playlist', 'liked'),
          origin: 'local' as const,
          system: 'liked' as const,
          name: 'Liked songs',
        },
        { id: formatId('local', 'playlist', 'road-trip'), origin: 'local' as const, name: 'Road' },
      ],
    })),
    addTracks: vi.fn(async () => ({ added: 1 })),
    createPlaylist: vi.fn(async () => formatId('local', 'playlist', 'new')),
    getMatch: vi.fn(async (id: string, mode: CatalogMode) => {
      const decision = decisions.get(`${id}|${mode}`)
      return decision && { ...decision, userPinned: false, decidedAt: 1 }
    }),
    recordMatch: vi.fn(async (decision: LibraryMatchDecision) => {
      decisions.set(`${decision.sourceTrackId}|${decision.mode}`, decision)
      return true
    }),
    pinMatch: vi.fn(async () => {}),
    unpinMatch: vi.fn(async () => {}),
    forgetMatch: vi.fn(async () => true),
  } satisfies LibraryRepository
  return library
}

describe('the library (stage 2.6)', () => {
  it('offers its playlists on the catalog pages, and keeps the matches the engine found', async () => {
    const library = fakeLibrary()
    const setup = setUp('full', { library })
    expect(setup.actions.get().library).toBeUndefined()

    await setup.ready()

    const playlists = await setup.actions.get().library?.playlists()
    expect(playlists?.map((playlist) => playlist.name)).toEqual(['Liked songs', 'Road'])
    const { engine } = playerFor(setup)
    play(setup, [SPOTIFY_CREEP])
    await until(() => engine.loadedUrls.length === 1, 'the matched song')
    const played = new URL(engine.loadedUrls[0] ?? '').searchParams.get('id')
    await until(() => library.recordMatch.mock.calls.length > 0, 'the decision')
    expect(library.recordMatch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTrackId: SPOTIFY_CREEP.id, mode: 'music' }),
    )
    const stored = (await library.getMatch(SPOTIFY_CREEP.id, 'music')) as
      | { candidate?: AudioCandidate }
      | undefined
    expect(stored?.candidate?.ref).toBe(played)
  })

  it('takes "Add to playlist" away again when the services stop', async () => {
    const setup = servicesOnTier('free', { library: fakeLibrary() })
    await setup.ready()
    expect(setup.actions.get().library).toBeDefined()

    setup.dispose()

    expect(setup.actions.get().library).toBeUndefined()
  })
})

describe('the platform', () => {
  it('is created with the options the services need', async () => {
    const created: PlatformOptions[] = []
    const sources = createSources()
    sources.setDetecting(true)
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
    // sources listed, rather than with no app at all, and nothing left to detect.
    await expect(services.start()).resolves.toBeUndefined()
    expect(sources.getSnapshot().detecting).toBe(false)
    services.dispose()

    const [options] = created
    // The stream ladder reports the bot checks it tells apart from age gates; the transport
    // must not count them again.
    expect(options?.reportLoginRequired).toBe(false)
    expect(options?.killSwitches).toBeDefined()
    expect(typeof options?.userHosts).toBe('function')
    expect(error).toHaveBeenCalledOnce()
  })

  it('asks YouTube with the same language and region for search and playback', async () => {
    const setup = setUp('full')
    await setup.ready()

    const forPages = setup.sources.context({ mode: 'music' })
    const forPlayback = setup.services.context({ priority: 'current-track' })

    // Neither: YouTube's defaults, and the region of the IP address that streams play from.
    expect([forPages.locale, forPages.region]).toEqual([undefined, undefined])
    expect([forPlayback.locale, forPlayback.region]).toEqual([undefined, undefined])
  })
})
