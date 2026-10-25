import {
  DEFAULT_QUALITY_PREFS,
  FxmError,
  formatId,
  isFxmError,
  type NetworkCapabilities,
  pickStream,
  type QualityPrefs,
  type StreamOption,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  context,
  FULL,
  fakeInnerTube,
  json,
  NONE,
  type Recorded,
  type Route,
  SIMPLE,
  swJsData,
} from '../fixtures/testing'
import { createYouTubeSession } from '../session'
import { BUNDLED_STREAM_CONFIG, type StreamConfig, type StreamRungConfig } from './config'
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
import type { YouTubeStreamOption } from './formats'
import type { RungHealthStore } from './health'
import { DIRECT_RUNGS, type StreamRungKind } from './kinds'
import { unavailableStateOf, YouTubeUnplayableError } from './playability'
import { createYouTubeAudioSource, type YouTubeStreamSourceOptions } from './resolver'

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

/** The VISIONOS song fixture with some fields of its audio formats changed, by itag. */
function withFormats(changes: Record<number, Json>): unknown {
  const copy = structuredClone(PLAYER_FIXTURES['visionos-song']) as Json
  for (const format of (copy.streamingData as Json).adaptiveFormats as Json[]) {
    Object.assign(format, changes[format.itag as number])
  }
  return copy
}

/** The bundled config with some fields of some rungs changed, by rung ID. */
function configWith(changes: Record<string, Partial<StreamRungConfig>>): StreamConfig {
  return {
    ...BUNDLED_STREAM_CONFIG,
    rungs: BUNDLED_STREAM_CONFIG.rungs.map((rung) => ({ ...rung, ...changes[rung.id] })),
  }
}

interface Setup {
  tier?: NetworkCapabilities
  googleVideo?: FakeGoogleVideoOptions
  options?: YouTubeStreamSourceOptions
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
    /** The `/player` calls so far. */
    players,
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

/** The first option of a resolution, which must be there. */
function first(options: readonly YouTubeStreamOption[]): YouTubeStreamOption {
  const [option] = options
  if (option === undefined) throw new Error('no option')
  return option
}

/** Lets pending saves to a health store finish. */
const flushed = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('resolving a YouTube Music song', () => {
  it("returns VISIONOS's formats, Opus 251 first, with the best Opus and AAC verified", async () => {
    const { audio, ctx, clients, probes, acquired } = setup([
      onSwJsDataInTurn(FIRST),
      ON.visionosSong,
    ])
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options.map((option) => [option.itag, option.tier, option.fullLength])).toEqual([
      [251, 'high', 'verified'],
      [140, 'high', 'verified'],
      [250, 'normal', 'unverified'],
      [249, 'low', 'unverified'],
      [139, 'low', 'unverified'],
    ])
    expect(options.every((option) => option.rung === 'visionos')).toBe(true)
    expect(
      options.every((option) => option.ipBound && option.expiresAt === 1_792_979_495_000),
    ).toBe(true)
    expect(options[0]).toMatchObject({ codec: 'opus', container: 'webm', media: 'audio' })
    expect(clients()).toEqual(['VISIONOS'])
    // One ranged GET for each codec: caps belong to a client, not a format.
    expect(
      probes()
        .map((probe) => probe.url.searchParams.get('itag'))
        .sort(),
    ).toEqual(['140', '251'])
    expect(acquired).toEqual(['current-track'])
    expect(await audio.health(ctx)).toMatchObject({
      scope: 'web/full',
      lastWorking: 'visionos',
      rungs: [{ rung: 'visionos', successes: 1 }, {}, {}, {}],
    })
  })

  it('probes every URL when asked, or none', async () => {
    const { audio, ctx, probes } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong])
    const all = await audio.resolve(SONG, ctx, PREFS, { probe: 'all' })
    expect(all.map((option) => option.fullLength)).toEqual(Array(5).fill('verified'))
    expect(probes()).toHaveLength(5)
    const none = await audio.resolve(SONG, ctx, PREFS, { probe: 'none' })
    expect(none.map((option) => option.fullLength)).toEqual(Array(5).fill('unverified'))
    expect(probes()).toHaveLength(5)
    // Nothing nobody checked counts as working.
    expect((await audio.health(ctx)).rungs[0]?.successes).toBe(1)
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
    const health = await audio.health(ctx)
    expect(health.scope).toBe('web/simple')
    // Until the player says a URL played, nothing is known to work.
    expect(health.lastWorking).toBeUndefined()
    expect(health.rungs[0]).toMatchObject({ successes: 0, failures: 0 })
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
      { googleVideo: { capped: ['VISIONOS'] } },
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

  it('probes the next format of a codec when the best one is capped', async () => {
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
      [249, 'unverified'],
      [139, 'unverified'],
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
    const { audio, ctx, clients, botChecks, players, swReads } = setup(routes)
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options.map((option) => option.itag)).toEqual([18])
    expect(clients()).toEqual(['VISIONOS', 'ANDROID'])
    expect(botChecks).toEqual(['login-required'])
    expect(swReads()).toBe(2)
    expect(players().map(visitorDataOf)).toEqual([FIRST, SECOND])
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

  // A Lite session whose first call got no visitorData from YouTube.
  const silent: Route = (request) =>
    request.url.pathname.endsWith('get_search_suggestions')
      ? json({ responseContext: {} })
      : undefined

  it("are FXM's own doing when no visitorData was sent: the rung tries again with YouTube's", async () => {
    // VISIONOS refuses a call without a visitorData, and issues one with its refusal.
    const visionos: Route = (request) =>
      request.url.pathname === '/youtubei/v1/player' && clientOf(request) === 'VISIONOS'
        ? json(
            visitorDataOf(request) === undefined
              ? PLAYER_FIXTURES['visionos-bot-check']
              : PLAYER_FIXTURES['visionos-song'],
          )
        : undefined
    const { audio, ctx, clients, players, botChecks } = setup([silent, visionos], { tier: SIMPLE })
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options[0]?.rung).toBe('visionos')
    expect(clients()).toEqual(['VISIONOS', 'VISIONOS'])
    expect(players().map(visitorDataOf)).toEqual([undefined, expect.any(String)])
    expect(botChecks).toEqual([])
    expect((await audio.health(ctx)).rungs[0]).toMatchObject({ failures: 0 })
  })

  it('and move on without counting it when YouTube issues none either', async () => {
    const page: Route = (request) =>
      request.url.pathname.endsWith('/player') && clientOf(request) === 'VISIONOS'
        ? new Response('<html>Sorry: unusual traffic from your computer network</html>')
        : undefined
    const { audio, ctx, clients, botChecks } = setup([silent, page, ON.androidSong], {
      tier: SIMPLE,
    })
    expect((await audio.resolve(SONG, ctx, PREFS))[0]?.itag).toBe(18)
    expect(clients()).toEqual(['VISIONOS', 'ANDROID'])
    expect(botChecks).toEqual([])
    expect((await audio.health(ctx)).rungs[0]).toMatchObject({ failures: 0 })
  })
})

describe('videos the direct rungs cannot play', () => {
  it('labels an age-restricted video, with a verdict on it, and tries no other rung', async () => {
    const routes = [
      onSwJsDataInTurn(FIRST),
      onPlayer('VISIONOS', VIDEOS.age, PLAYER_FIXTURES['visionos-age']),
    ]
    const { audio, ctx, clients, botChecks, swReads } = setup(routes)
    const error = await failure(audio.resolve(candidate(VIDEOS.age), ctx, PREFS))
    expect(error).toBeInstanceOf(YouTubeUnplayableError)
    expect(error).toMatchObject({
      code: 'Unavailable',
      videoId: VIDEOS.age,
      state: 'age-restricted',
      status: 'LOGIN_REQUIRED',
      reason: 'Sign in to confirm your age',
    })
    expect(error.cause).toEqual({
      type: 'playability',
      source: 'ytm',
      ref: VIDEOS.age,
      status: 'UNPLAYABLE',
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
      expect(error.cause).toMatchObject({ ref: videoId, status: 'UNPLAYABLE' })
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
    expect(error.cause).toMatchObject({ ref: VIDEOS.kids, status: 'UNPLAYABLE' })
    expect(error.message).toContain('requires payment')
    expect(clients()).toEqual(['VISIONOS', 'ANDROID'])
  })

  it('stops at once for a removed, private or region-blocked video', async () => {
    const removed = changed(PLAYER_FIXTURES['visionos-kids'], {
      status: 'ERROR',
      reason: 'This video has been removed by the uploader',
    })
    const blocked = changed(PLAYER_FIXTURES['visionos-kids'], {
      reason: 'The uploader has not made this video available in your country',
    })
    const hidden = changed(PLAYER_FIXTURES['visionos-kids'], {
      status: 'LOGIN_REQUIRED',
      reason: 'This video is private',
    })
    for (const [fixture, code, verdict] of [
      [removed, 'NotFound', 'ERROR'],
      [blocked, 'GeoBlocked', 'UNPLAYABLE'],
      [hidden, 'Unavailable', 'UNPLAYABLE'],
    ] as const) {
      const routes = [onSwJsDataInTurn(FIRST), onPlayer('VISIONOS', VIDEOS.kids, fixture)]
      const { audio, ctx, clients } = setup(routes)
      const error = await failure(audio.resolve(candidate(VIDEOS.kids), ctx, PREFS))
      expect(error).toBeInstanceOf(YouTubeUnplayableError)
      expect(error.code).toBe(code)
      expect(error.cause).toMatchObject({ type: 'playability', ref: VIDEOS.kids, status: verdict })
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
    expect(error.cause).toBeUndefined()
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

  it("passes on the budget's refusal before any request", async () => {
    const refusal = new FxmError('RateLimited', 'The hour is used up', { retryAfterMs: 60_000 })
    const fake = fakeInnerTube(onSwJsDataInTurn(FIRST), ON.visionosSong)
    const audio = createYouTubeAudioSource({ budget: fakeStreamBudget(refusal).budget })
    const ctx = context(fake.fetch, { capabilities: FULL })
    await expect(audio.resolve(SONG, ctx, PREFS)).rejects.toBe(refusal)
    expect(fake.requests).toEqual([])
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

describe('the last-resort rung', () => {
  it('is the only rung tried when the caller asks for it', async () => {
    const { audio, ctx, clients } = setup([onSwJsDataInTurn(FIRST), ON.androidSong])
    expect(audio.hasFallback).toBe(true)
    const options = await audio.resolve(SONG, ctx, PREFS, { rungs: 'fallback' })
    expect(options.map((option) => [option.rung, option.itag])).toEqual([['android-muxed', 18]])
    expect(clients()).toEqual(['ANDROID'])
  })

  it('is missing when the config marks none, or switches it off: asking for it is Unsupported', async () => {
    for (const streamConfig of [
      configWith({ 'android-muxed': { fallback: false } }),
      configWith({ 'android-muxed': { enabled: false } }),
    ]) {
      const { audio, ctx, requests } = setup([], { options: { streamConfig } })
      expect(audio.hasFallback).toBe(false)
      const error = await failure(audio.resolve(SONG, ctx, PREFS, { rungs: 'fallback' }))
      expect(error.code).toBe('Unsupported')
      expect(error.cause).toBeUndefined()
      expect(requests).toEqual([])
    }
  })
})

describe('playback reports', () => {
  it('make a rung that played in the Lite tier the last working one', async () => {
    const { audio, ctx } = setup([onPriming(FIRST), ON.visionosSong], { tier: SIMPLE })
    const opus = first(await audio.resolve(SONG, ctx, PREFS))
    audio.reportPlaybackSuccess(opus, ctx)
    expect(await audio.health(ctx)).toMatchObject({
      lastWorking: 'visionos',
      lastWorkingAt: NOW,
      rungs: [{ rung: 'visionos', successes: 1 }, {}, {}, {}],
    })
  })

  it('back a rung off, doubling, while its URLs keep failing their first request', async () => {
    const { audio, ctx, advance } = setup([onPriming(FIRST), ON.visionosSong, ON.androidSong], {
      tier: SIMPLE,
    })
    const rounds: [number, number][] = []
    for (let round = 0; round < 3; round += 1) {
      const opus = first(await audio.resolve(SONG, ctx, PREFS))
      expect(opus.rung).toBe('visionos')
      audio.reportPlaybackFailure(opus, ctx, 'probe-failed')
      const visionos = (await audio.health(ctx)).rungs[0]
      const coolDown = ((visionos?.coolingUntil ?? 0) - (visionos?.lastFailureAt ?? 0)) / MINUTE
      rounds.push([visionos?.consecutiveFailures ?? 0, coolDown])
      advance(31 * MINUTE)
    }
    expect(rounds).toEqual([
      [1, 5],
      [2, 10],
      [3, 20],
    ])
    expect((await audio.health(ctx)).lastWorking).toBeUndefined()
  })

  it('let the player fall back to itag 18, and later songs start there while VISIONOS cools', async () => {
    const routes = [onPriming(FIRST), ON.visionosSong, ON.androidSong]
    const { audio, ctx, clients } = setup(routes, { tier: SIMPLE })
    const opus = first(await audio.resolve(SONG, ctx, PREFS))
    audio.reportPlaybackFailure(opus, ctx, 'probe-failed')
    const muxed = first(await audio.resolve(SONG, ctx, PREFS, { rungs: 'fallback' }))
    expect(muxed.itag).toBe(18)
    audio.reportPlaybackSuccess(muxed, ctx)
    const next = first(await audio.resolve(SONG, ctx, PREFS))
    expect(next.rung).toBe('android-muxed')
    expect(clients()).toEqual(['VISIONOS', 'ANDROID', 'ANDROID'])
    expect((await audio.health(ctx)).lastWorking).toBe('android-muxed')
  })

  it('count only failures that put the rung at fault', async () => {
    const { audio, ctx } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong])
    const opus = first(await audio.resolve(SONG, ctx, PREFS))
    for (const reason of [
      'expired',
      'unauthorized',
      'ip-changed',
      'forbidden',
      'first-request',
      'mid-play',
      'decode',
      'unknown',
    ] as const) {
      audio.reportPlaybackFailure(opus, ctx, reason as 'decode')
    }
    expect((await audio.health(ctx)).rungs[0]).toMatchObject({ failures: 0 })
    audio.reportPlaybackFailure(opus, ctx, 'forbidden-again')
    expect((await audio.health(ctx)).rungs[0]).toMatchObject({
      failures: 1,
      lastFailure: 'playback',
    })
  })

  it('ignore options the ladder did not resolve, and a verified URL that already counted', async () => {
    const { audio, ctx } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong])
    const opus = first(await audio.resolve(SONG, ctx, PREFS))
    const archive: StreamOption = {
      url: 'https://archive.org/x.flac',
      codec: 'flac',
      container: 'flac',
      media: 'audio',
      tier: 'lossless',
      protocol: 'progressive',
      ipBound: false,
      fullLength: 'unverified',
    }
    const strangers: StreamOption[] = [
      archive,
      { ...opus, rung: 'not-a-rung', fullLength: 'unverified' } as StreamOption,
      { ...opus, rung: 'constructor', fullLength: 'unverified' } as StreamOption,
      { ...opus, videoId: 'x', fullLength: 'unverified' } as StreamOption,
    ]
    for (const option of strangers) {
      audio.reportPlaybackFailure(option, ctx, 'probe-failed')
      audio.reportPlaybackSuccess(option, ctx)
    }
    audio.reportPlaybackSuccess(opus, ctx)
    const health = await audio.health(ctx)
    expect(health.rungs[0]).toMatchObject({ rung: 'visionos', successes: 1, failures: 0 })
  })
})

describe('where rungs may run', () => {
  const both = [onSwJsDataInTurn(FIRST), onPriming(FIRST), ON.visionosSong, ON.androidSong]
  const requires = (changes: Partial<StreamRungConfig['requires']>) =>
    configWith({ visionos: { requires: { fullAccess: false, mediaBytes: false, ...changes } } })

  it('leaves out a rung that needs full YouTube access in the Lite tier', async () => {
    const streamConfig = requires({ fullAccess: true })
    const lite = setup(both, { tier: SIMPLE, options: { streamConfig } })
    await lite.audio.resolve(SONG, lite.ctx, PREFS)
    expect(lite.clients()).toEqual(['ANDROID'])
    const full = setup(both, { options: { streamConfig } })
    await full.audio.resolve(SONG, full.ctx, PREFS)
    expect(full.clients()).toEqual(['VISIONOS'])
  })

  it("leaves out a rung that needs googlevideo's bytes, or another platform", async () => {
    const noBytes: NetworkCapabilities = { ...FULL, mediaBytes: false }
    const bytes = setup(both, {
      tier: noBytes,
      options: { streamConfig: requires({ mediaBytes: true }) },
    })
    await bytes.audio.resolve(SONG, bytes.ctx, PREFS)
    expect(bytes.clients()).toEqual(['ANDROID'])
    const desktopOnly = setup(both, {
      options: { streamConfig: requires({ platforms: ['desktop'] }) },
    })
    await desktopOnly.audio.resolve(SONG, desktopOnly.ctx, PREFS)
    await desktopOnly.audio.resolve(SONG, { ...desktopOnly.ctx, platform: 'desktop' }, PREFS)
    expect(desktopOnly.clients()).toEqual(['ANDROID', 'VISIONOS'])
  })

  it('refuses to resolve when no rung that is on can run here', async () => {
    const streamConfig: StreamConfig = {
      ...BUNDLED_STREAM_CONFIG,
      rungs: BUNDLED_STREAM_CONFIG.rungs.map((rung) => ({
        ...rung,
        requires: { fullAccess: true, mediaBytes: false },
      })),
    }
    const { audio, ctx, requests } = setup([], { tier: SIMPLE, options: { streamConfig } })
    expect((await failure(audio.resolve(SONG, ctx, PREFS))).code).toBe('Unsupported')
    expect(requests).toEqual([])
  })
})

describe('rung kinds', () => {
  const visionos = BUNDLED_STREAM_CONFIG.rungs[0] as StreamRungConfig
  const streamConfig: StreamConfig = {
    ...BUNDLED_STREAM_CONFIG,
    rungs: [{ ...visionos, id: 'echo-visionos', kind: 'echo' }, ...BUNDLED_STREAM_CONFIG.rungs],
  }
  const routes = [onSwJsDataInTurn(FIRST), ON.visionosSong]

  /** A kind that runs like `direct`, and remembers the rungs it ran. */
  function echo(canRun = true) {
    const ran: string[] = []
    const kind: StreamRungKind = {
      kind: 'echo',
      canRun: () => canRun,
      call: (ctx, rung, videoId, tools) => {
        ran.push(rung.id)
        return DIRECT_RUNGS.call(ctx, rung, videoId, tools)
      },
      options: DIRECT_RUNGS.options,
    }
    return { kind, ran }
  }

  it('runs the rungs of a kind the source is given, with the ladder around them', async () => {
    const { kind, ran } = echo()
    const { audio, ctx, probes } = setup(routes, {
      options: { streamConfig, rungKinds: [kind] },
    })
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(ran).toEqual(['echo-visionos'])
    expect(options[0]).toMatchObject({ rung: 'echo-visionos', itag: 251, fullLength: 'verified' })
    expect(probes()).toHaveLength(2)
    expect((await audio.health(ctx)).lastWorking).toBe('echo-visionos')
  })

  it('leaves out rungs of a kind it is not given, or that cannot run here', async () => {
    const without = setup(routes, { options: { streamConfig } })
    expect((await without.audio.resolve(SONG, without.ctx, PREFS))[0]?.rung).toBe('visionos')
    const { kind, ran } = echo(false)
    const unable = setup(routes, { options: { streamConfig, rungKinds: [kind] } })
    expect((await unable.audio.resolve(SONG, unable.ctx, PREFS))[0]?.rung).toBe('visionos')
    expect(ran).toEqual([])
  })
})

describe('checking a stream URL', () => {
  it('reads the status a URL answers now, with one byte, where bytes are readable', async () => {
    let forbidden = false
    const { audio, ctx, probes } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong], {
      googleVideo: {
        answer: ({ first: start, last }) =>
          forbidden && start === 0 && last === 0 ? new Response(null, { status: 403 }) : undefined,
      },
    })
    const opus = first(await audio.resolve(SONG, ctx, PREFS))
    expect(await audio.checkStatus(opus, ctx)).toBe(206)
    forbidden = true
    expect(await audio.checkStatus(opus, ctx)).toBe(403)
    expect(probes().at(-1)?.headers.get('range')).toBe('bytes=0-0')
  })

  it('cannot tell where bytes are unreadable, after a failed request, or for other options', async () => {
    const down: Route = (request) => {
      if (isGoogleVideo(request)) throw new TypeError('Failed to fetch')
      return undefined
    }
    const { audio, ctx, probes } = setup([onSwJsDataInTurn(FIRST), ON.visionosSong])
    const opus = first(await audio.resolve(SONG, ctx, PREFS, { probe: 'none' }))
    expect(await audio.checkStatus(opus, { ...ctx, capabilities: SIMPLE })).toBeUndefined()
    const elsewhere = { ...opus, url: 'https://example.com/videoplayback?itag=251' }
    expect(await audio.checkStatus(elsewhere, ctx)).toBeUndefined()
    expect(probes()).toEqual([])
    const failing = fakeInnerTube(down)
    const failingCtx = context(failing.fetch, { capabilities: FULL })
    expect(await audio.checkStatus(opus, failingCtx)).toBeUndefined()
  })
})

describe('the order of the options', () => {
  it('puts the format the download setting needs first among equals', async () => {
    const same = withFormats({
      140: { bitrate: 150_000, averageBitrate: 130_000 },
      251: { bitrate: 150_000, averageBitrate: 130_000 },
    })
    const routes = [onSwJsDataInTurn(FIRST), onPlayer('VISIONOS', VIDEOS.song, same)]
    const { audio, ctx } = setup(routes)
    const preferring = (format: 'aac' | 'opus' | 'flac'): QualityPrefs => ({
      ...PREFS,
      download: { format },
    })
    const firstItag = async (prefs: QualityPrefs) =>
      (await audio.resolve(SONG, ctx, prefs))[0]?.itag
    expect(await firstItag(preferring('aac'))).toBe(140)
    expect(await firstItag(preferring('opus'))).toBe(251)
    expect(await firstItag(preferring('flac'))).toBe(251)
  })

  // PENDING a core decision: the plan prefers Opus 251 to AAC 140, but core's `compareStreams`
  // ranks options of one tier by their average bitrate, and a quiet song's Opus 251 averages
  // less than AAC 140 (111.7 kbps against 129.6 for "Baby Shark Dance"). Until core or the
  // playback policy prefers Opus within a tier, AAC 140 comes first, and `pickStream` takes it.
  it('ranks AAC 140 above a quiet Opus 251 of the same tier, by average bitrate', async () => {
    const quiet = withFormats({ 251: { bitrate: 149_004, averageBitrate: 111_660 } })
    const routes = [onSwJsDataInTurn(FIRST), onPlayer('VISIONOS', VIDEOS.song, quiet)]
    const { audio, ctx } = setup(routes)
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options.map((option) => [option.itag, option.tier, option.bitrateKbps])).toEqual([
      [140, 'high', 129.6],
      [251, 'high', 111.7],
      [250, 'normal', 68.5],
      [249, 'low', 51.6],
      [139, 'low', 48.9],
    ])
    expect(options[1]?.peakBitrateKbps).toBe(149)
    expect(pickStream(options, 'high')?.itag).toBe(140)
  })
})

describe('the health store', () => {
  it('keeps the memory, so a restart still starts on the working rung', async () => {
    let saved: unknown
    const store: RungHealthStore = {
      load: () => saved,
      save: (state) => {
        saved = state
      },
    }
    const routes = [onSwJsDataInTurn(FIRST), ON.visionosSong, ON.androidSong]
    const before = setup(routes, {
      googleVideo: { capped: ['VISIONOS'] },
      options: { healthStore: store },
    })
    await before.audio.resolve(SONG, before.ctx, PREFS)
    await flushed()
    expect(saved).toMatchObject({ v: 1, scopes: { 'web/full': { w: 'android-muxed' } } })
    const after = setup(routes, { options: { healthStore: store } })
    await after.audio.resolve(SONG, after.ctx, PREFS)
    expect(after.clients()).toEqual(['ANDROID'])
    expect(await after.audio.health(after.ctx)).toMatchObject({ lastWorking: 'android-muxed' })
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

it('takes a session to share, or the options to create one, never both', () => {
  const session = createYouTubeSession()
  // @ts-expect-error: a shared session's own options would be ignored.
  createYouTubeAudioSource({ session, timeoutMs: 5000 })
  // @ts-expect-error: the same for its config.
  createYouTubeAudioSource({ session, config: session.config })
  const own = createYouTubeAudioSource({ timeoutMs: 5000, playerTimeoutMs: 1000 })
  expect(own.session).not.toBe(session)
  expect(createYouTubeAudioSource({ session, playerTimeoutMs: 1000 }).session).toBe(session)
})

it('is an AudioSource for ytm candidates', () => {
  const audio = createYouTubeAudioSource()
  expect(audio.id).toBe('ytm')
  const error = new YouTubeUnplayableError('NotFound', 'x', {
    videoId: VIDEOS.song,
    status: 'ERROR',
    reason: '',
  })
  expect(isFxmError(error)).toBe(true)
})
