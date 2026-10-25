import {
  DEFAULT_QUALITY_PREFS,
  FxmError,
  formatId,
  isFxmError,
  type NetworkCapabilities,
  type QualityPrefs,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  context,
  FULL,
  fakeInnerTube,
  NONE,
  type Recorded,
  type Route,
  SIMPLE,
  swJsData,
} from '../fixtures/testing'
import { createYouTubeSession } from '../session'
import { BUNDLED_STREAM_CONFIG, type StreamConfig } from './config'
import {
  candidate,
  clientOf,
  type FakeGoogleVideoOptions,
  fakeGoogleVideo,
  fakeStreamBudget,
  isGoogleVideo,
  onPlayer,
  onPriming,
  PLAYER_FIXTURES,
  VIDEOS,
} from './fixtures/testing'
import type { RungHealthStore } from './health'
import { unavailableStateOf, YouTubeUnplayableError } from './playability'
import { createYouTubeAudioSource, type YouTubeAudioSourceOptions } from './resolver'

type Json = { [key: string]: unknown }

const NOW = Date.UTC(2026, 9, 26, 12)
const MINUTE = 60_000
const FIRST = 'CgtGaXJzdFZpc2l0b3IoAQ%3D%3D'
const SECOND = 'CgtTZWNvbmRWaXNpdG9yKAE%3D'

/** A `sw.js_data` that issues `values` in turn, then the last one again. */
function onSwJsDataInTurn(...values: string[]): Route {
  let served = 0
  return (request) => {
    if (request.url.pathname !== '/sw.js_data') return undefined
    const value = values[Math.min(served, values.length - 1)] as string
    served += 1
    return new Response(swJsData(value))
  }
}

/** A recorded response with some fields changed. */
function changed(fixture: unknown, status: Json = {}, details: Json = {}, streaming?: Json) {
  const copy = structuredClone(fixture) as Json
  copy.playabilityStatus = { ...(copy.playabilityStatus as Json), ...status }
  if (copy.videoDetails !== undefined) {
    copy.videoDetails = { ...(copy.videoDetails as Json), ...details }
  }
  if (streaming !== undefined)
    copy.streamingData = { ...(copy.streamingData as Json), ...streaming }
  return copy
}

/** The bundled config with rungs switched on or off, or opting in to states. */
function configWith(changes: Record<string, { enabled?: boolean; tries?: never[] }>) {
  return {
    ...BUNDLED_STREAM_CONFIG,
    rungs: BUNDLED_STREAM_CONFIG.rungs.map((rung) => ({ ...rung, ...changes[rung.id] })),
  } as StreamConfig
}

interface Setup {
  tier?: NetworkCapabilities
  googleVideo?: FakeGoogleVideoOptions
  options?: YouTubeAudioSourceOptions
}

function setup(routes: Route[], { tier = FULL, googleVideo, options = {} }: Setup = {}) {
  const fake = fakeInnerTube(...routes, fakeGoogleVideo(googleVideo))
  const budget = fakeStreamBudget()
  let time = NOW
  const audio = createYouTubeAudioSource({
    session: createYouTubeSession(),
    budget: budget.budget,
    now: () => time,
    ...options,
  })
  const ctx = context(fake.fetch, { capabilities: tier, mode: 'music' })
  const players = () => fake.requests.filter((r) => r.url.pathname === '/youtubei/v1/player')
  return {
    ...fake,
    ...budget,
    audio,
    ctx,
    /** The clients of the `/player` calls so far. */
    clients: () => players().map(clientOf),
    /** The googlevideo requests so far. */
    probes: () => fake.requests.filter(isGoogleVideo),
    /** The `sw.js_data` reads so far. */
    swReads: () => fake.requests.filter((r) => r.url.pathname === '/sw.js_data').length,
    advance(ms: number) {
      time += ms
    },
  }
}

const SONG = candidate(VIDEOS.song)
const PREFS = DEFAULT_QUALITY_PREFS as QualityPrefs
const ON = {
  visionosSong: onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-song']),
  androidSong: onPlayer('ANDROID', VIDEOS.song, PLAYER_FIXTURES['android-song']),
}

async function failure(promise: Promise<unknown>): Promise<FxmError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof FxmError)) throw new Error(`expected an FxmError, got ${String(error)}`)
  return error
}

function visitorDataOf(request: Recorded | undefined): unknown {
  return (request?.body.context as { client?: { visitorData?: unknown } } | undefined)?.client
    ?.visitorData
}

describe('resolving a YouTube Music song', () => {
  it("returns VISIONOS's formats, Opus 251 first, each verified at the end of its file", async () => {
    const { audio, ctx, clients, probes, acquired } = setup([
      onSwJsDataInTurn(FIRST),
      ON.visionosSong,
    ])
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options.map((option) => [option.itag, option.tier, option.fullLength])).toEqual([
      [251, 'high', 'verified'],
      [140, 'high', 'verified'],
      [250, 'normal', 'verified'],
      [249, 'low', 'verified'],
      [139, 'low', 'verified'],
    ])
    expect(options.every((option) => option.rung === 'visionos')).toBe(true)
    expect(
      options.every((option) => option.ipBound && option.expiresAt === 1_792_979_495_000),
    ).toBe(true)
    expect(options[0]).toMatchObject({ codec: 'opus', container: 'webm', media: 'audio' })
    expect(clients()).toEqual(['VISIONOS'])
    expect(probes()).toHaveLength(5)
    expect(acquired).toEqual(['current-track'])
    expect(await audio.health(ctx)).toMatchObject({ scope: 'web/full', lastWorking: 'visionos' })
  })

  it('returns the URLs unprobed in the Lite tier, for the media element to probe', async () => {
    const { audio, ctx, probes, acquired, requests } = setup([onPriming(FIRST), ON.visionosSong], {
      tier: SIMPLE,
    })
    const options = await audio.resolve(SONG, ctx, PREFS, { priority: 'prefetch' })
    expect(options.map((option) => option.fullLength)).toEqual(Array(5).fill('unverified'))
    expect(probes()).toEqual([])
    expect(acquired).toEqual(['prefetch', 'prefetch'])
    expect(visitorDataOf(requests[1])).toBe(FIRST)
    expect((await audio.health(ctx)).scope).toBe('web/simple')
  })

  it('does not probe when FXM Connect cannot read googlevideo', async () => {
    const tier: NetworkCapabilities = { ...FULL, mediaBytes: false }
    const { audio, ctx, probes } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong], { tier })
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options[0]?.fullLength).toBe('unverified')
    expect(probes()).toEqual([])
  })

  it('resolves to itag 18, "AAC from 360p video", when the config turns VISIONOS off', async () => {
    const streamConfig = configWith({ visionos: { enabled: false } })
    const { audio, ctx, clients, probes } = setup([onSwJsDataInTurn(FIRST), ON.androidSong], {
      options: { streamConfig },
    })
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      itag: 18,
      rung: 'android-muxed',
      label: 'AAC from 360p video',
      media: 'muxed-video',
      codec: 'aac',
      container: 'mp4',
      bitrateKbps: 128,
      fullLength: 'verified',
      contentLength: 4_757_394,
    })
    expect(clients()).toEqual(['ANDROID'])
    expect(probes().map((probe) => probe.headers.get('range'))).toEqual([
      'bytes=0-0',
      'bytes=4691858-4757393',
    ])
  })

  it('falls to itag 18 when every VISIONOS URL is capped, and lists those last', async () => {
    const { audio, ctx, clients } = setup(
      [onSwJsDataInTurn(FIRST), ON.visionosSong, ON.androidSong],
      {
        googleVideo: { capped: ['VISIONOS'] },
      },
    )
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options.map((option) => [option.itag, option.fullLength])).toEqual([
      [18, 'verified'],
      [251, 'capped'],
      [140, 'capped'],
      [250, 'capped'],
      [249, 'capped'],
      [139, 'capped'],
    ])
    expect(clients()).toEqual(['VISIONOS', 'ANDROID'])
    const health = await audio.health(ctx)
    expect(health.lastWorking).toBe('android-muxed')
    expect(health.rungs[0]).toMatchObject({
      rung: 'visionos',
      failures: 1,
      lastFailure: 'capped',
      coolingUntil: NOW + 5 * MINUTE,
    })
  })

  it('keeps a rung that has capped URLs and a whole one', async () => {
    const { audio, ctx } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong], {
      googleVideo: {
        answer: ({ url }) =>
          url.searchParams.get('itag') === '251' ? new Response(null, { status: 403 }) : undefined,
      },
    })
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options.map((option) => [option.itag, option.fullLength])).toEqual([
      [140, 'verified'],
      [250, 'verified'],
      [249, 'verified'],
      [139, 'verified'],
      [251, 'capped'],
    ])
  })

  it('returns only capped options when every URL found is capped', async () => {
    const { audio, ctx } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong, ON.androidSong], {
      googleVideo: { capped: ['VISIONOS', 'ANDROID'] },
    })
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options).toHaveLength(6)
    expect(options.every((option) => option.fullLength === 'capped')).toBe(true)
  })

  it('starts on the rung that works while a failed one cools down, then tries it again', async () => {
    const routes = [onSwJsDataInTurn(FIRST), ON.visionosSong, ON.androidSong]
    const { audio, ctx, clients, advance } = setup(routes, {
      googleVideo: { capped: ['VISIONOS'] },
    })
    await audio.resolve(SONG, ctx, PREFS)
    await audio.resolve(SONG, ctx, PREFS)
    expect(clients()).toEqual(['VISIONOS', 'ANDROID', 'ANDROID'])
    advance(5 * MINUTE)
    await audio.resolve(SONG, ctx, PREFS)
    expect(clients()).toEqual(['VISIONOS', 'ANDROID', 'ANDROID', 'VISIONOS', 'ANDROID'])
    // A second failure in a row doubles the cool-down.
    expect((await audio.health(ctx)).rungs[0]).toMatchObject({
      consecutiveFailures: 2,
      coolingUntil: NOW + 15 * MINUTE,
    })
  })

  it('remembers health per platform and tier', async () => {
    const routes = [onSwJsDataInTurn(FIRST), onPriming(FIRST), ON.visionosSong, ON.androidSong]
    const { audio, ctx, fetch } = setup(routes, { googleVideo: { capped: ['VISIONOS'] } })
    await audio.resolve(SONG, ctx, PREFS)
    const lite = context(fetch, { capabilities: SIMPLE, mode: 'music' })
    expect(await audio.health(lite)).toMatchObject({ scope: 'web/simple' })
    expect((await audio.health(lite)).lastWorking).toBeUndefined()
    const desktop = { ...ctx, platform: 'desktop' as const }
    expect((await audio.health(desktop)).rungs.every((rung) => rung.failures === 0)).toBe(true)
  })
})

describe('bot checks', () => {
  it('refresh the visitorData once, are reported, and the ladder moves on', async () => {
    const routes = [
      onSwJsDataInTurn(FIRST, SECOND),
      onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-bot-check']),
      ON.androidSong,
    ]
    const { audio, ctx, clients, botChecks, requests, swReads } = setup(routes)
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options.map((option) => option.itag)).toEqual([18])
    expect(clients()).toEqual(['VISIONOS', 'ANDROID'])
    expect(botChecks).toEqual(['login-required'])
    expect(swReads()).toBe(2)
    const players = requests.filter((r) => r.url.pathname === '/youtubei/v1/player')
    expect(players.map(visitorDataOf)).toEqual([FIRST, SECOND])
    expect((await audio.health(ctx)).rungs[0]).toMatchObject({ lastFailure: 'bot-check' })
  })

  it('refresh it only once when every rung meets one, then fail with BotCheck', async () => {
    const routes = [
      onSwJsDataInTurn(FIRST, SECOND),
      onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-bot-check']),
      onPlayer('ANDROID', VIDEOS.song, PLAYER_FIXTURES['visionos-bot-check']),
    ]
    const { audio, ctx, botChecks, swReads } = setup(routes)
    const error = await failure(audio.resolve(SONG, ctx, PREFS))
    expect(error.code).toBe('BotCheck')
    expect(botChecks).toEqual(['login-required', 'login-required'])
    expect(swReads()).toBe(2)
  })

  it('count a bot check page too', async () => {
    const page: Route = (request) =>
      request.url.pathname.endsWith('/player') && clientOf(request) === 'VISIONOS'
        ? new Response('<html>Sorry: unusual traffic from your computer network</html>')
        : undefined
    const { audio, ctx, botChecks } = setup([onSwJsDataInTurn(FIRST, SECOND), page, ON.androidSong])
    expect((await audio.resolve(SONG, ctx, PREFS))[0]?.itag).toBe(18)
    expect(botChecks).toEqual(['login-required'])
  })

  it('do not refresh a visitorData that was never sent', async () => {
    // A Lite session whose first call got no visitorData from YouTube.
    const silent: Route = (request) =>
      request.url.pathname.endsWith('get_search_suggestions')
        ? new Response(JSON.stringify({ responseContext: {} }))
        : undefined
    const routes = [
      silent,
      onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-bot-check']),
      ON.androidSong,
    ]
    const { audio, ctx, requests } = setup(routes, { tier: SIMPLE })
    await audio.resolve(SONG, ctx, PREFS)
    const players = requests.filter((r) => r.url.pathname === '/youtubei/v1/player')
    // VISIONOS's bot check issued a visitorData, which the next rung uses.
    expect(players.map(visitorDataOf)).toEqual([undefined, expect.any(String)])
  })
})

describe('videos the direct rungs cannot play', () => {
  it('labels an age-restricted video and tries no other rung', async () => {
    const routes = [
      onSwJsDataInTurn(FIRST),
      onPlayer('VISIONOS', VIDEOS.age, PLAYER_FIXTURES['visionos-age']),
    ]
    const { audio, ctx, clients, botChecks, swReads } = setup(routes)
    const error = await failure(audio.resolve(candidate(VIDEOS.age), ctx, PREFS))
    expect(error).toBeInstanceOf(YouTubeUnplayableError)
    expect(error).toMatchObject({
      code: 'Unavailable',
      state: 'age-restricted',
      status: 'LOGIN_REQUIRED',
      reason: 'Sign in to confirm your age',
    })
    expect(unavailableStateOf(error)).toBe('age-restricted')
    expect(clients()).toEqual(['VISIONOS'])
    expect(botChecks).toEqual([])
    expect(swReads()).toBe(1)
    expect((await audio.health(ctx)).rungs.every((rung) => rung.failures === 0)).toBe(true)
  })

  it('plays a video made for kids through itag 18, which opts in to them', async () => {
    const routes = [
      onSwJsDataInTurn(FIRST),
      onPlayer('VISIONOS', VIDEOS.kids, PLAYER_FIXTURES['visionos-kids']),
      onPlayer('ANDROID', VIDEOS.kids, PLAYER_FIXTURES['android-kids']),
    ]
    const { audio, ctx, clients } = setup(routes)
    const options = await audio.resolve(candidate(VIDEOS.kids), ctx, PREFS)
    expect(options.map((option) => [option.itag, option.fullLength, option.contentLength])).toEqual(
      [[18, 'verified', 7_604_777]],
    )
    expect(clients()).toEqual(['VISIONOS', 'ANDROID'])
    expect((await audio.health(ctx)).rungs[0]?.failures).toBe(0)
  })

  it('labels a video made for kids when no rung opts in to them', async () => {
    const streamConfig = configWith({ 'android-muxed': { tries: [] } })
    const routes = [
      onSwJsDataInTurn(FIRST),
      onPlayer('VISIONOS', VIDEOS.kids, PLAYER_FIXTURES['visionos-kids']),
    ]
    const { audio, ctx, clients } = setup(routes, { options: { streamConfig } })
    const error = await failure(audio.resolve(candidate(VIDEOS.kids), ctx, PREFS))
    expect(error).toMatchObject({ code: 'Unavailable', state: 'made-for-kids' })
    expect(clients()).toEqual(['VISIONOS'])
  })

  it('labels live streams, past ones and scheduled ones as live, and premieres', async () => {
    const premiere = changed(PLAYER_FIXTURES['visionos-upcoming'], {}, { isLiveContent: false })
    const cases = [
      [VIDEOS.live, PLAYER_FIXTURES['visionos-live'], 'live'],
      [VIDEOS.liveEnded, PLAYER_FIXTURES['visionos-live-ended'], 'live'],
      [VIDEOS.upcoming, PLAYER_FIXTURES['visionos-upcoming'], 'live'],
      [VIDEOS.upcoming, premiere, 'premiere'],
    ] as const
    for (const [videoId, fixture, state] of cases) {
      const { audio, ctx, clients } = setup([
        onSwJsDataInTurn(FIRST),
        onPlayer('VISIONOS', videoId, fixture),
      ])
      const error = await failure(audio.resolve(candidate(videoId, 'video'), ctx, PREFS))
      expect(error).toMatchObject({ code: 'Unavailable', state })
      expect(clients()).toEqual(['VISIONOS'])
    }
  })

  it('tries the next rung for an unplayable video, and fails with YouTube status', async () => {
    const paid = changed(PLAYER_FIXTURES['visionos-kids'], {
      reason: 'This video requires payment to watch',
    })
    const routes = [
      onSwJsDataInTurn(FIRST),
      onPlayer('VISIONOS', VIDEOS.kids, paid),
      onPlayer('ANDROID', VIDEOS.kids, paid),
    ]
    const { audio, ctx, clients } = setup(routes)
    const error = await failure(audio.resolve(candidate(VIDEOS.kids), ctx, PREFS))
    expect(error).toMatchObject({ code: 'Unavailable', status: 'UNPLAYABLE', state: undefined })
    expect(error.message).toContain('requires payment')
    expect(clients()).toEqual(['VISIONOS', 'ANDROID'])
  })

  it('stops at once for a removed or region-blocked video', async () => {
    const removed = changed(PLAYER_FIXTURES['visionos-kids'], {
      status: 'ERROR',
      reason: 'This video has been removed by the uploader',
    })
    const blocked = changed(PLAYER_FIXTURES['visionos-kids'], {
      reason: 'The uploader has not made this video available in your country',
    })
    for (const [fixture, code] of [
      [removed, 'NotFound'],
      [blocked, 'GeoBlocked'],
    ] as const) {
      const routes = [onSwJsDataInTurn(FIRST), onPlayer('VISIONOS', VIDEOS.kids, fixture)]
      const { audio, ctx, clients } = setup(routes)
      const error = await failure(audio.resolve(candidate(VIDEOS.kids), ctx, PREFS))
      expect(error).toBeInstanceOf(YouTubeUnplayableError)
      expect(error.code).toBe(code)
      expect(clients()).toEqual(['VISIONOS'])
    }
  })
})

describe('answers the ladder must not use', () => {
  it('rejects an answer about another video and moves on', async () => {
    const routes = [
      onSwJsDataInTurn(FIRST),
      onPlayer('VISIONOS', VIDEOS.kids, PLAYER_FIXTURES['visionos-song']),
      onPlayer('ANDROID', VIDEOS.kids, PLAYER_FIXTURES['android-kids']),
    ]
    const { audio, ctx } = setup(routes)
    const options = await audio.resolve(candidate(VIDEOS.kids), ctx, PREFS)
    expect(options.map((option) => [option.rung, option.videoId])).toEqual([
      ['android-muxed', VIDEOS.kids],
    ])
    expect((await audio.health(ctx)).rungs[0]).toMatchObject({ lastFailure: 'mismatch' })
  })

  it('fails with Parse when every answer is about another video', async () => {
    const routes = [
      onSwJsDataInTurn(FIRST),
      onPlayer('VISIONOS', VIDEOS.kids, PLAYER_FIXTURES['visionos-song']),
      onPlayer('ANDROID', VIDEOS.kids, PLAYER_FIXTURES['android-song']),
    ]
    const { audio, ctx } = setup(routes)
    const error = await failure(audio.resolve(candidate(VIDEOS.kids), ctx, PREFS))
    expect(error.code).toBe('Parse')
    expect(error.message).toContain(`about ${VIDEOS.song}`)
  })

  it('moves on from an answer without direct audio, or one it cannot read', async () => {
    const empty = changed(PLAYER_FIXTURES['visionos-song'], {}, {}, { adaptiveFormats: [] })
    for (const visionos of [
      onPlayer('VISIONOS', VIDEOS.song, empty),
      onPlayer('VISIONOS', VIDEOS.song, { error: { message: 'Precondition' } }, { status: 400 }),
    ]) {
      const { audio, ctx } = setup([onSwJsDataInTurn(FIRST), visionos, ON.androidSong])
      expect((await audio.resolve(SONG, ctx, PREFS)).map((option) => option.itag)).toEqual([18])
      const why = (await audio.health(ctx)).rungs[0]?.lastFailure
      expect(['no-formats', 'error']).toContain(why)
    }
  })
})

describe('failures that stop the ladder', () => {
  it('passes on a network failure without trying another rung', async () => {
    const down: Route = (request) => {
      if (request.url.pathname.endsWith('/player')) throw new TypeError('Failed to fetch')
      return undefined
    }
    const { audio, ctx, clients } = setup([onSwJsDataInTurn(FIRST), down])
    expect((await failure(audio.resolve(SONG, ctx, PREFS))).code).toBe('Network')
    expect(clients()).toEqual(['VISIONOS'])
  })

  it('passes on HTTP 429, reported to the budget', async () => {
    const routes = [onSwJsDataInTurn(FIRST), onPlayer('VISIONOS', VIDEOS.song, {}, { status: 429 })]
    const { audio, ctx, botChecks, clients } = setup(routes)
    expect((await failure(audio.resolve(SONG, ctx, PREFS))).code).toBe('RateLimited')
    expect(botChecks).toEqual(['rate-limited'])
    expect(clients()).toEqual(['VISIONOS'])
  })

  it("passes on the budget's refusal before any /player call", async () => {
    const refusal = new FxmError('RateLimited', 'The hour is used up', { retryAfterMs: 60_000 })
    const fake = fakeInnerTube(onSwJsDataInTurn(FIRST), ON.visionosSong)
    const audio = createYouTubeAudioSource({ budget: fakeStreamBudget(refusal).budget })
    const ctx = context(fake.fetch, { capabilities: FULL })
    await expect(audio.resolve(SONG, ctx, PREFS)).rejects.toBe(refusal)
    expect(fake.requests.map((request) => request.url.pathname)).toEqual(['/sw.js_data'])
  })

  it("passes on the caller's cancellation", async () => {
    const controller = new AbortController()
    controller.abort(new Error('skipped'))
    const fake = fakeInnerTube(onSwJsDataInTurn(FIRST), ON.visionosSong)
    const ctx = context(fake.fetch, { capabilities: FULL, signal: controller.signal })
    const audio = createYouTubeAudioSource()
    await expect(audio.resolve(SONG, ctx, PREFS)).rejects.toThrow('skipped')
    expect(fake.requests).toEqual([])
  })

  it('refuses candidates of other sources, malformed videoIds and pages without YouTube', async () => {
    const fake = fakeInnerTube()
    const audio = createYouTubeAudioSource()
    const ctx = context(fake.fetch, { capabilities: FULL })
    const spotify = { ...SONG, source: 'spotify' as const }
    expect((await failure(audio.resolve(spotify, ctx, PREFS))).code).toBe('Unsupported')
    const malformed = { ...SONG, ref: 'not a video' }
    expect((await failure(audio.resolve(malformed, ctx, PREFS))).code).toBe('NotFound')
    const none = context(fake.fetch, { capabilities: NONE })
    expect((await failure(audio.resolve(SONG, none, PREFS))).code).toBe('Unsupported')
    expect(fake.requests).toEqual([])
  })

  it('refuses to resolve when the config switches every rung off', async () => {
    const streamConfig = configWith({
      visionos: { enabled: false },
      'android-muxed': { enabled: false },
    })
    const { audio, ctx, requests } = setup([], { options: { streamConfig } })
    expect((await failure(audio.resolve(SONG, ctx, PREFS))).code).toBe('Unsupported')
    expect(requests).toEqual([])
  })
})

describe('the Lite fallback and rung memory', () => {
  it('skips a rung whose URL failed to play, then starts over once every rung failed', async () => {
    const routes = [onPriming(FIRST), ON.visionosSong, ON.androidSong]
    const { audio, ctx, clients } = setup(routes, { tier: SIMPLE })
    const [opus] = await audio.resolve(SONG, ctx, PREFS)
    expect(opus?.rung).toBe('visionos')
    audio.reportPlaybackFailure(opus as NonNullable<typeof opus>, ctx)
    const [muxed] = await audio.resolve(SONG, ctx, PREFS)
    expect(muxed?.rung).toBe('android-muxed')
    audio.reportPlaybackFailure(muxed as NonNullable<typeof muxed>, ctx)
    const [again] = await audio.resolve(SONG, ctx, PREFS)
    expect(again?.rung).toBe('visionos')
    expect(clients()).toEqual(['VISIONOS', 'ANDROID', 'VISIONOS'])
    const health = await audio.health(ctx)
    expect(health.rungs.map((rung) => [rung.rung, rung.lastFailure])).toEqual([
      ['visionos', 'playback'],
      ['tv-samsung', undefined],
      ['mweb', undefined],
      ['web-remix', undefined],
      ['web-sabr', undefined],
      ['ios', undefined],
      ['android-vr', undefined],
      ['android-muxed', 'playback'],
    ])
  })

  it('forgets a failed playback after 30 minutes, and ignores options of other sources', async () => {
    const routes = [onPriming(FIRST), ON.visionosSong, ON.androidSong]
    const { audio, ctx, clients, advance } = setup(routes, { tier: SIMPLE })
    const [opus] = await audio.resolve(SONG, ctx, PREFS)
    audio.reportPlaybackFailure(opus as NonNullable<typeof opus>, ctx)
    audio.reportPlaybackFailure(
      {
        url: 'https://archive.org/x.flac',
        codec: 'flac',
        container: 'flac',
        media: 'audio',
        tier: 'lossless',
        protocol: 'progressive',
        ipBound: false,
        fullLength: 'unverified',
      },
      ctx,
    )
    advance(31 * 60_000)
    await audio.resolve(SONG, ctx, PREFS)
    expect(clients()).toEqual(['VISIONOS', 'VISIONOS'])
  })

  it('skips the rungs the caller names, and fails when that leaves none', async () => {
    const { audio, ctx, clients } = setup([onSwJsDataInTurn(FIRST), ON.androidSong])
    const options = await audio.resolve(SONG, ctx, PREFS, { skipRungs: ['visionos'] })
    expect(options[0]?.itag).toBe(18)
    const skipAll = { skipRungs: ['visionos', 'android-muxed'] }
    expect((await failure(audio.resolve(SONG, ctx, PREFS, skipAll))).code).toBe('Unavailable')
    expect(clients()).toEqual(['ANDROID'])
  })

  it('keeps its memory in a store, so a restart still starts on the working rung', async () => {
    let saved: unknown
    const store: RungHealthStore = {
      load: () => saved,
      save: (state) => {
        saved = state
      },
    }
    const routes = [onSwJsDataInTurn(FIRST), ON.visionosSong, ON.androidSong]
    const first = setup(routes, {
      googleVideo: { capped: ['VISIONOS'] },
      options: { healthStore: store },
    })
    await first.audio.resolve(SONG, first.ctx, PREFS)
    await Promise.resolve()
    expect(saved).toMatchObject({ v: 1, scopes: { 'web/full': { w: 'android-muxed' } } })
    const second = setup(routes, { options: { healthStore: store } })
    await second.audio.resolve(SONG, second.ctx, PREFS)
    expect(second.clients()).toEqual(['ANDROID'])
    expect(await second.audio.health(second.ctx)).toMatchObject({ lastWorking: 'android-muxed' })
  })

  it('ignores a broken or failing store', async () => {
    const stores: RungHealthStore[] = [
      {
        load: () => ({ v: 1, scopes: { 'web/full': { r: { visionos: { s: -1 } } } } }),
        save: () => {},
      },
      { load: () => ({ v: 1, scopes: { __proto__: { r: {} } } }), save: () => {} },
      {
        load: () => Promise.reject(new Error('quota')),
        save: () => Promise.reject(new Error('quota')),
      },
    ]
    for (const healthStore of stores) {
      const { audio, ctx, clients } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong], {
        options: { healthStore },
      })
      await audio.resolve(SONG, ctx, PREFS)
      expect(clients()).toEqual(['VISIONOS'])
    }
  })

  it('follows a config that changes while the source lives', async () => {
    let config: StreamConfig = BUNDLED_STREAM_CONFIG
    const routes = [onSwJsDataInTurn(FIRST), ON.visionosSong, ON.androidSong]
    const { audio, ctx, clients } = setup(routes, { options: { streamConfig: () => config } })
    await audio.resolve(SONG, ctx, PREFS)
    config = configWith({ visionos: { enabled: false } })
    await audio.resolve(SONG, ctx, PREFS)
    expect(clients()).toEqual(['VISIONOS', 'ANDROID'])
  })
})

describe('the order of the options', () => {
  it('puts the format the download setting needs first among equals', async () => {
    const same = structuredClone(PLAYER_FIXTURES['visionos-song']) as Json
    for (const format of (same.streamingData as Json).adaptiveFormats as Json[]) {
      if (format.itag === 140 || format.itag === 251) {
        format.bitrate = 150_000
        format.averageBitrate = 130_000
      }
    }
    const routes = [onSwJsDataInTurn(FIRST), onPlayer('VISIONOS', VIDEOS.song, same)]
    const { audio, ctx } = setup(routes)
    const preferring = (format: 'aac' | 'opus' | 'flac'): QualityPrefs => ({
      ...PREFS,
      download: { format },
    })
    const first = async (prefs: QualityPrefs) => (await audio.resolve(SONG, ctx, prefs))[0]?.itag
    expect(await first(preferring('aac'))).toBe(140)
    expect(await first(preferring('opus'))).toBe(251)
    expect(await first(preferring('flac'))).toBe(251)
  })
})

describe('matching a track to its audio', () => {
  const audio = createYouTubeAudioSource()
  const ctx = (mode: 'music' | 'all') => context(fakeInnerTube().fetch, { mode })
  const track = (id: string, kind: Track['kind'], extra: Partial<Track> = {}): Track => ({
    id: id as Track['id'],
    source: 'ytm',
    title: 'Creep',
    artists: [{ name: 'Radiohead' }],
    artwork: [],
    kind,
    ...extra,
  })

  it("offers a YouTube track's own audio", async () => {
    const song = track(formatId('ytm', 'track', VIDEOS.song), 'song', { durationMs: 239_000 })
    expect(await audio.match(song, ctx('music'))).toEqual([
      {
        source: 'ytm',
        ref: VIDEOS.song,
        kind: 'song',
        title: 'Creep',
        artists: ['Radiohead'],
        durationMs: 239_000,
        confidence: 1,
        evidence: ['own audio'],
      },
    ])
    const video = track(formatId('yt', 'track', VIDEOS.live), 'video')
    expect(await audio.match(video, ctx('all'))).toMatchObject([
      { source: 'ytm', ref: VIDEOS.live, kind: 'video' },
    ])
  })

  it("offers an official video's linked song in Music mode, and nothing for other videos", async () => {
    const linked = track(formatId('ytm', 'track', 'XFkzRNyygfk'), 'music-video', {
      songId: formatId('ytm', 'track', VIDEOS.song),
    })
    expect(await audio.match(linked, ctx('music'))).toMatchObject([
      { ref: VIDEOS.song, kind: 'song', evidence: ['song linked by YouTube'] },
    ])
    const unlinked = track(formatId('ytm', 'track', 'XFkzRNyygfk'), 'music-video')
    expect(await audio.match(unlinked, ctx('music'))).toEqual([])
    const upload = track(formatId('yt', 'track', VIDEOS.live), 'video')
    expect(await audio.match(upload, ctx('music'))).toEqual([])
  })

  it('leaves tracks of other sources to the matching engine', async () => {
    const spotify = track(formatId('spotify', 'track', '3n3Ppam7vgaVa1iaRUc9Lp'), 'song', {
      source: 'spotify',
    })
    expect(await audio.match(spotify, ctx('music'))).toEqual([])
    const odd = track(formatId('ytm', 'track', 'too-short'), 'song')
    expect(await audio.match(odd, ctx('music'))).toEqual([])
  })
})

it('is an AudioSource for ytm candidates', () => {
  const audio = createYouTubeAudioSource()
  expect(audio.id).toBe('ytm')
  expect(
    isFxmError(new YouTubeUnplayableError('NotFound', 'x', { status: 'ERROR', reason: '' })),
  ).toBe(true)
})
