import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { FAKE_VISITOR_DATA } from '../fixtures/sanitize'
import {
  context,
  FULL,
  fakeInnerTube,
  json,
  onSwJsData,
  preflightReason,
  type Route,
  SIMPLE,
} from '../fixtures/testing'
import { createYouTubeSession } from '../session'
import { BUNDLED_STREAM_CONFIG, type StreamRungConfig } from './config'
import { fakeStreamBudget, onPlayer, onPriming, PLAYER_FIXTURES, VIDEOS } from './fixtures/testing'
import { callPlayer, playerPayload, STREAM_LANGUAGE } from './player'

const rung = (id: string) =>
  BUNDLED_STREAM_CONFIG.rungs.find((entry) => entry.id === id) as StreamRungConfig
const [VISIONOS, IOS] = [rung('visionos'), rung('ios')]
const ISSUED = 'CgtJc3N1ZWRCeUZYTWZpeHR1cmUo'

function setup(routes: Route[], tier = FULL) {
  const fake = fakeInnerTube(...routes)
  const { budget, acquired, botChecks } = fakeStreamBudget()
  const session = createYouTubeSession()
  const options = { session, budget, priority: 'prefetch' as const, timeoutMs: 1000 }
  const ctx = context(fake.fetch, { capabilities: tier, region: 'IN' })
  return { ...fake, ctx, session, options, acquired, botChecks }
}

describe('a /player call', () => {
  it('goes out in the CORS-simple shape, as the rung client, in English', async () => {
    const { ctx, options, requests, acquired } = setup([
      onSwJsData(),
      onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-song']),
    ])
    const answer = await callPlayer(ctx, VISIONOS.client, VIDEOS.song, options)
    expect(answer).toEqual({ json: PLAYER_FIXTURES['visionos-song'], sentVisitorData: true })
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/sw.js_data',
      '/youtubei/v1/player',
    ])
    const player = requests[1]
    expect(player?.url.href).toBe('https://www.youtube.com/youtubei/v1/player?prettyPrint=false')
    expect(player?.method).toBe('POST')
    expect([...(player?.headers.keys() ?? [])]).toEqual(['content-type'])
    expect(player?.headers.get('content-type')).toBe('text/plain;charset=UTF-8')
    expect(player?.credentials).toBe('omit')
    expect(player && preflightReason(player)).toBeUndefined()
    expect(player?.body).toEqual({
      context: {
        client: {
          clientName: 'VISIONOS',
          clientVersion: '1.02',
          hl: STREAM_LANGUAGE,
          gl: 'IN',
          visitorData: FAKE_VISITOR_DATA,
        },
        user: { lockedSafetyMode: false },
        request: { useSsl: true },
      },
      videoId: VIDEOS.song,
      contentCheckOk: true,
      racyCheckOk: true,
    })
    expect(acquired).toEqual(['prefetch'])
  })

  it("sends a client's own fields from the config", async () => {
    const { ctx, options, requests } = setup([
      onSwJsData(),
      onPlayer('IOS', VIDEOS.song, PLAYER_FIXTURES['ios-song']),
    ])
    await callPlayer(ctx, IOS.client, VIDEOS.song, options)
    const sentContext = requests[1]?.body.context as { client?: unknown } | undefined
    expect(sentContext?.client).toMatchObject({
      clientName: 'IOS',
      clientVersion: '20.11.6',
      deviceMake: 'Apple',
      deviceModel: 'iPhone10,4',
      osName: 'iOS',
      osVersion: '16.7.7.20H330',
    })
    expect(playerPayload(IOS.client, VIDEOS.song)).toMatchObject({ videoId: VIDEOS.song })
  })

  it('asks YouTube for a visitorData first in the Lite tier, never sending a /player without', async () => {
    const { ctx, options, requests, session, acquired } = setup(
      [onPriming(ISSUED), onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-song'])],
      SIMPLE,
    )
    await callPlayer(ctx, VISIONOS.client, VIDEOS.song, options)
    const [priming, player] = requests
    expect(priming?.url.href).toBe(
      'https://music.youtube.com/youtubei/v1/music/get_search_suggestions?prettyPrint=false',
    )
    expect(priming?.body).toMatchObject({
      input: '',
      context: { client: { clientName: 'WEB_REMIX', hl: STREAM_LANGUAGE } },
    })
    expect(priming?.rawBody).not.toContain('visitorData')
    expect(priming && preflightReason(priming)).toBeUndefined()
    expect(player?.body).toMatchObject({ context: { client: { visitorData: ISSUED } } })
    expect(session.visitorData.current).toBe(ISSUED)
    expect(acquired).toEqual(['prefetch', 'prefetch'])
  })

  it('reports a bot check on that first call, and stops', async () => {
    const page: Route = (request) =>
      request.url.pathname.endsWith('get_search_suggestions')
        ? new Response('<html>Our systems have detected unusual traffic</html>')
        : undefined
    const { ctx, options, requests, botChecks } = setup(
      [page, onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-song'])],
      SIMPLE,
    )
    const error = await callPlayer(ctx, VISIONOS.client, VIDEOS.song, options).catch((e) => e)
    expect(isFxmError(error, 'BotCheck')).toBe(true)
    expect(botChecks).toEqual(['login-required'])
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/youtubei/v1/music/get_search_suggestions',
    ])
  })

  it('needs no first call when a visitorData is stored', async () => {
    const fake = fakeInnerTube(onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-song']))
    const session = createYouTubeSession({
      visitorDataStore: { load: () => ISSUED, save: () => {}, clear: () => {} },
    })
    const { budget } = fakeStreamBudget()
    const ctx = context(fake.fetch, { capabilities: SIMPLE })
    await callPlayer(ctx, VISIONOS.client, VIDEOS.song, {
      session,
      budget,
      priority: 'current-track',
      timeoutMs: 1000,
    })
    expect(fake.requests.map((request) => request.url.pathname)).toEqual(['/youtubei/v1/player'])
  })

  it('hands a bot check page back to the ladder', async () => {
    const page = '<html><body>Our systems have detected unusual traffic</body></html>'
    const route: Route = (request) =>
      request.url.pathname === '/youtubei/v1/player' ? new Response(page) : undefined
    const { ctx, options } = setup([onSwJsData(), route])
    const answer = await callPlayer(ctx, VISIONOS.client, VIDEOS.song, options)
    expect(answer).toEqual({
      botCheck: `YouTube answered player ${VIDEOS.song} with a bot check page`,
      sentVisitorData: true,
    })
  })

  it('reports HTTP 429 to the budget and fails with RateLimited', async () => {
    const { ctx, options, botChecks } = setup([
      onSwJsData(),
      onPlayer('VISIONOS', VIDEOS.song, {}, { status: 429, headers: { 'retry-after': '30' } }),
    ])
    const error = await callPlayer(ctx, VISIONOS.client, VIDEOS.song, options).catch((e) => e)
    expect(isFxmError(error, 'RateLimited')).toBe(true)
    expect((error as FxmError).retryAfterMs).toBe(30_000)
    expect(botChecks).toEqual(['rate-limited'])
  })

  it('maps other failures to FxmErrors', async () => {
    const cases: [Route, string][] = [
      [onPlayer('VISIONOS', VIDEOS.song, { error: { message: 'Bad' } }, { status: 400 }), 'Parse'],
      [onPlayer('VISIONOS', VIDEOS.song, {}, { status: 500 }), 'Network'],
      [onPlayer('VISIONOS', VIDEOS.song, {}, { status: 403 }), 'Unsupported'],
      [(r) => (r.url.pathname.endsWith('player') ? new Response('nope') : undefined), 'Parse'],
      [(r) => (r.url.pathname.endsWith('player') ? json([1, 2]) : undefined), 'Parse'],
      [
        (r) => {
          if (r.url.pathname.endsWith('player')) throw new TypeError('Failed to fetch')
          return undefined
        },
        'Network',
      ],
    ]
    for (const [route, code] of cases) {
      const { ctx, options } = setup([onSwJsData(), route])
      const error = await callPlayer(ctx, VISIONOS.client, VIDEOS.song, options).catch((e) => e)
      expect(isFxmError(error, code as 'Parse'), `${code}: ${String(error)}`).toBe(true)
    }
  })

  it("stops before sending when the budget refuses, and frees the session's lease", async () => {
    const refusal = new FxmError('RateLimited', 'The budget is used up', { retryAfterMs: 1000 })
    const fake = fakeInnerTube(
      onSwJsData(),
      onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-song']),
    )
    const session = createYouTubeSession()
    const ctx = context(fake.fetch, { capabilities: FULL })
    const refused = fakeStreamBudget(refusal)
    const options = { session, priority: 'bulk' as const, timeoutMs: 1000 }
    await expect(
      callPlayer(ctx, VISIONOS.client, VIDEOS.song, { ...options, budget: refused.budget }),
    ).rejects.toBe(refusal)
    expect(fake.requests.map((request) => request.url.pathname)).toEqual(['/sw.js_data'])
    const { budget } = fakeStreamBudget()
    await callPlayer(ctx, VISIONOS.client, VIDEOS.song, { ...options, budget })
    expect(fake.requests).toHaveLength(2)
  })
})
