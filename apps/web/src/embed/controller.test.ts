import { FxmError, formatId } from '@fxm/core'
import { createStaticNetworkMonitor } from '@fxm/player'
import { FakeMatcher } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import { createProviderCatalog } from './catalog'
import { EmbedController, needsYouTube, playsIn, tierOf } from './controller'
import { CAPABILITIES, createFakePlatform, priorityOf } from './testing/fake-platform'
import { FakeMetadataProvider } from './testing/fake-provider'
import {
  ALBUM,
  ARCHIVE_ATTRIBUTION,
  ARCHIVE_TRACK,
  createHarness,
  PLAYLIST,
  SONG_A as SONG,
  settle,
  targetOf,
  UPLOAD,
  VIDEO,
} from './testing/harness'

describe('tierOf and needsYouTube', () => {
  it('name the tier and say which content needs YouTube', () => {
    expect(tierOf(CAPABILITIES.full)).toBe('full')
    expect(tierOf(CAPABILITIES.lite)).toBe('lite')
    expect(tierOf(CAPABILITIES.free)).toBe('free')
    expect(needsYouTube({ kind: 'track', id: SONG.id })).toBe(true)
    expect(needsYouTube(targetOf(ARCHIVE_TRACK))).toBe(false)
  })

  it('let official videos play in Music mode only through a song', () => {
    expect(playsIn(SONG, 'music', false)).toBe(true)
    expect(playsIn(VIDEO, 'music', false)).toBe(false)
    expect(playsIn(VIDEO, 'music', true)).toBe(true)
    expect(playsIn(UPLOAD, 'music', true)).toBe(false)
    expect(playsIn(UPLOAD, 'all', false)).toBe(true)
    expect(playsIn({ ...VIDEO, songId: SONG.id }, 'music', false)).toBe(true)
  })
})

describe('EmbedController', () => {
  it('loads a YouTube Music song in the Lite tier and plays it on request', async () => {
    const { controller, platformRequests, youtubeProvider, ladder, engine } = createHarness({
      target: { kind: 'track', id: SONG.id },
    })
    expect(controller.getState().phase).toBe('loading')

    await controller.start()

    const state = controller.getState()
    expect(platformRequests).toEqual([{ youtube: true }])
    expect(state).toMatchObject({ phase: 'ready', tier: 'lite', entity: { title: SONG.title } })
    expect(state.player?.queue.items.map((item) => item.track.id)).toEqual([SONG.id])
    expect(state.started).toBeUndefined()
    // Metadata is interactive work on the budget, in the address's mode.
    expect(youtubeProvider.calls).toEqual([`getTrack ${SONG.id}`])
    expect(youtubeProvider.contexts.map(priorityOf)).toEqual(['interactive'])
    expect(youtubeProvider.contexts[0]?.mode).toBe('music')
    // Nothing resolves before the visitor presses play.
    expect(ladder.calls).toEqual([])

    controller.play()
    await settle()

    expect(controller.getState()).toMatchObject({ started: true, player: { status: 'playing' } })
    expect(ladder.log).toEqual(['songA:top'])
    expect(priorityOf(ladder.calls[0]?.request.ctx ?? ({} as never))).toBe('current-track')
    // Lite can't read media bytes, so the URL is unverified and plays as it is.
    expect(engine.loadedUrls).toEqual(['https://media.test/songA/251?n=1'])
  })

  it('falls back to itag 18 when the first URL fails before playing, as in Lite', async () => {
    const { controller, ladder, engine } = createHarness({ target: { kind: 'track', id: SONG.id } })
    await controller.start()
    engine.startOnPlay = false

    controller.play()
    await settle()
    // The capped URL's first request fails: a media error before any `play` event.
    engine.fail('unsupported')
    await settle()

    expect(ladder.log).toEqual(['songA:top', 'songA:fallback'])
    expect(engine.loadedUrls.at(-1)).toBe('https://media.test/songA/18?n=2')
  })

  it('shows the install hint for YouTube content without Lite, and loads it once Connect appears', async () => {
    const { controller, platform, youtubeProvider, servicesCreated } = createHarness({
      target: { kind: 'track', id: SONG.id },
      capabilities: CAPABILITIES.free,
    })

    await controller.start()

    expect(controller.getState()).toMatchObject({
      phase: 'unavailable',
      problem: 'needs-youtube',
      tier: 'free',
    })
    expect(servicesCreated()).toBe(0)
    expect(youtubeProvider.calls).toEqual([])

    platform.setCapabilities(CAPABILITIES.full)
    await settle()

    expect(controller.getState()).toMatchObject({ phase: 'ready', tier: 'full' })
    expect(controller.getState().problem).toBeUndefined()
  })

  it('plays a free-source track on any tier, without the Lite self-test, with its credits', async () => {
    const { controller, platformRequests, archive, engine } = createHarness({
      target: targetOf(ARCHIVE_TRACK),
      capabilities: CAPABILITIES.free,
    })

    await controller.start()
    controller.play()
    await settle()

    expect(platformRequests).toEqual([{ youtube: false }])
    expect(controller.getState()).toMatchObject({ phase: 'ready', player: { status: 'playing' } })
    expect(archive.log).toEqual(['item/side-a.flac:top'])
    expect(engine.loadedUrls).toHaveLength(1)
    expect(controller.attributionOf(ARCHIVE_TRACK)).toEqual(ARCHIVE_ATTRIBUTION)
    expect(controller.attributionOf(SONG)).toBeUndefined()
  })

  it('plays an album from any of its tracks, in its context', async () => {
    const { controller, ladder } = createHarness({ target: targetOf(ALBUM) })
    await controller.start()

    const queue = controller.getState().player?.queue
    expect(queue?.items.map((item) => item.track.title)).toEqual(['Song A', 'Song B', 'Song C'])
    expect(queue?.context).toEqual({ type: 'album', id: ALBUM.id, title: ALBUM.name })

    controller.play(1)
    await settle()
    expect(ladder.log).toEqual(['songB:top'])
    controller.next()
    await settle()
    expect(controller.getState().player?.queue.index).toBe(2)
    controller.previous()
    await settle()
    expect(controller.getState().player?.queue.index).toBe(1)
  })

  it('keeps only what the mode lets play, and needs a matcher for unlinked videos', async () => {
    const music = createHarness({ target: targetOf(PLAYLIST) })
    await music.controller.start()
    const titles = (harness: typeof music) =>
      harness.controller.getState().player?.queue.items.map((item) => item.track.title)
    expect(titles(music)).toEqual(['Song A'])
    expect(music.controller.getState().player?.queue.context).toMatchObject({ type: 'playlist' })
    // The source lists more than its first page.
    expect(music.controller.getState().entity?.trackCount).toBe(40)

    const matched = createHarness({ target: targetOf(PLAYLIST), matcher: new FakeMatcher() })
    await matched.controller.start()
    expect(titles(matched)).toEqual(['Song A', VIDEO.title])

    const all = createHarness({ target: targetOf(PLAYLIST), mode: 'all' })
    await all.controller.start()
    expect(titles(all)).toEqual(['Song A', UPLOAD.title, VIDEO.title])
  })

  it.each([
    ['an upload', UPLOAD],
    ['an unlinked official video', VIDEO],
  ])('refuses %s in Music mode', async (_name, track) => {
    const { controller } = createHarness({ target: targetOf(track) })
    await controller.start()
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', problem: 'hidden-by-mode' })
  })

  it('says why loading failed, and loads again on retry', async () => {
    const harness = createHarness({ target: { kind: 'track', id: SONG.id } })
    harness.youtubeProvider.errors.set(SONG.id, new FxmError('BotCheck', 'Sign in to confirm'))
    await harness.controller.start()
    expect(harness.controller.getState()).toMatchObject({ phase: 'unavailable', problem: 'failed' })

    harness.youtubeProvider.errors.clear()
    harness.controller.retry()
    await settle()
    expect(harness.controller.getState().phase).toBe('ready')
    // One platform and one set of providers, whatever happens.
    expect(harness.platformRequests).toHaveLength(1)
    expect(harness.servicesCreated()).toBe(1)
  })

  it('reports content that does not exist', async () => {
    const { controller } = createHarness({
      target: { kind: 'track', id: formatId('ytm', 'track', 'missing') },
    })
    await controller.start()
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', problem: 'not-found' })
  })

  it('reports an album with nothing the mode lets play', async () => {
    const album = { ...ALBUM, tracks: [UPLOAD] }
    const { controller } = createHarness({
      target: targetOf(album),
      providers: [new FakeMetadataProvider('ytm', { albums: [album] })],
    })
    await controller.start()
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', problem: 'empty' })
    expect(controller.getState().entity?.title).toBe(ALBUM.name)
  })

  it('contacts nothing for content its providers can not load', async () => {
    const platform = createFakePlatform()
    let platforms = 0
    let services = 0
    const controller = new EmbedController({
      target: { kind: 'track', id: SONG.id },
      mode: 'music',
      canLoad: () => false,
      createPlatform: async () => {
        platforms += 1
        return platform
      },
      createServices: () => {
        services += 1
        return { catalog: createProviderCatalog([]), sources: [] }
      },
      mediaSession: false,
    })
    await controller.start()
    // No platform: no FXM Connect check and no Lite self-test, so no request at all.
    expect(controller.getState()).toEqual({ phase: 'unavailable', problem: 'unsupported' })
    expect([platforms, services]).toEqual([0, 0])

    const failing = new EmbedController({
      target: { kind: 'track', id: SONG.id },
      mode: 'music',
      canLoad: () => Promise.reject(new Error('No chunk')),
      createPlatform: async () => platform,
      createServices: () => ({ catalog: createProviderCatalog([]), sources: [] }),
      mediaSession: false,
    })
    await failing.start()
    expect(failing.getState()).toMatchObject({ phase: 'unavailable', problem: 'unsupported' })
  })

  it('says it cannot play a source it has no provider for', async () => {
    const { controller } = createHarness({ target: { kind: 'track', id: SONG.id }, providers: [] })
    await controller.start()
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', problem: 'unsupported' })
  })

  it('tells why a track failed until another one plays', async () => {
    const { controller, ladder } = createHarness({ target: targetOf(ALBUM) })
    await controller.start()

    ladder.errors.set('songA', new FxmError('BotCheck', 'Sign in to confirm'))
    controller.play()
    await settle()
    expect(controller.getState().notice).toBe('bot-check')

    ladder.errors.clear()
    controller.play()
    await settle()
    expect(controller.getState().player?.status).toBe('playing')
    expect(controller.getState().notice).toBeUndefined()

    ladder.errors.set('songB', new FxmError('Unsupported', 'No route to YouTube'))
    controller.next()
    await settle()
    expect(controller.getState().notice).toBe('needs-youtube')
  })

  it('prefetches the next track at the prefetch priority', async () => {
    const { controller, ladder, engine } = createHarness({ target: targetOf(ALBUM) })
    await controller.start()
    controller.play()
    await settle()

    // 20 s before the end of the track, the player prepares the next one.
    engine.progress(180_000)
    await settle()

    const next = ladder.calls.find((call) => call.candidate.ref === 'songB')
    expect(next).toBeDefined()
    expect(priorityOf(next?.request.ctx ?? ({} as never))).toBe('prefetch')
  })

  it('creates the providers once when loads overlap, and again after they failed', async () => {
    let created = 0
    let fail = true
    const controller = new EmbedController({
      target: { kind: 'track', id: SONG.id },
      mode: 'music',
      createPlatform: async () => createFakePlatform(),
      async createServices() {
        created += 1
        if (fail) throw new Error('No providers yet')
        return {
          catalog: createProviderCatalog([new FakeMetadataProvider('ytm', { tracks: [SONG] })]),
          sources: [],
        }
      },
      mediaSession: false,
      network: createStaticNetworkMonitor(),
    })
    await controller.start()
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', problem: 'failed' })
    expect(created).toBe(1)

    fail = false
    await Promise.all([controller.start(), controller.start()])
    expect(controller.getState().phase).toBe('ready')
    expect(created).toBe(2)
  })

  it('reports a platform that fails to start as a failure', async () => {
    const controller = new EmbedController({
      target: { kind: 'track', id: SONG.id },
      mode: 'music',
      createPlatform: () => Promise.reject(new Error('No window')),
      createServices: () => ({ catalog: createProviderCatalog([]), sources: [] }),
      mediaSession: false,
    })
    await controller.start()
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', problem: 'failed' })
  })

  it('frees the player and the platform when destroyed, and ignores calls after', async () => {
    const { controller, platform, engine } = createHarness({
      target: { kind: 'track', id: SONG.id },
    })
    await controller.start()
    const listener = () => {
      throw new Error('No update after destroy')
    }
    controller.subscribe(listener)

    controller.destroy()
    controller.play()
    controller.destroy()
    await controller.start()

    expect(platform.disposed).toBe(true)
    expect(engine.destroyed).toBe(true)
  })

  it('disposes a platform that arrives after it was destroyed', async () => {
    const platform = createFakePlatform()
    let release: () => void = () => {}
    let asked: () => void = () => {}
    const requested = new Promise<void>((resolve) => {
      asked = resolve
    })
    const controller = new EmbedController({
      target: { kind: 'track', id: SONG.id },
      mode: 'music',
      canLoad: async () => true,
      createPlatform: () => {
        asked()
        return new Promise((resolve) => {
          release = () => resolve(platform)
        })
      },
      createServices: () => ({ catalog: createProviderCatalog([]), sources: [] }),
      mediaSession: false,
    })
    const started = controller.start()
    await requested
    controller.destroy()
    release()
    await started
    expect(platform.disposed).toBe(true)
  })

  it('creates no platform when destroyed before it knew it could load', async () => {
    let platforms = 0
    const controller = new EmbedController({
      target: { kind: 'track', id: SONG.id },
      mode: 'music',
      canLoad: async () => true,
      createPlatform: async () => {
        platforms += 1
        return createFakePlatform()
      },
      createServices: () => ({ catalog: createProviderCatalog([]), sources: [] }),
      mediaSession: false,
    })
    const started = controller.start()
    controller.destroy()
    await started
    expect(platforms).toBe(0)
  })
})
