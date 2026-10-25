import {
  createInProcessEvaluator,
  FAKE_BOTGUARD_GLOBAL,
  fakeWebPoToken,
} from '@fxm/platform/testing/evaluator'
import { afterEach, describe, expect, it } from 'vitest'
import { context, fakeInnerTube, type Route } from '../../fixtures/testing'
import {
  BOTGUARD_REQUEST_KEY,
  GENERATE_IT_URL,
  parsePageChallenge,
  WebPoTokens,
  YOUTUBE_HOME_URL,
} from './botguard'
import {
  botGuardRoutes,
  FAKE_EVENT_ID,
  FAKE_INTEGRITY_KEY,
  FAKE_INTERPRETER_URL,
  FAKE_PROGRAM,
  homePage,
} from './fixtures/testing'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE_BOTGUARD_GLOBAL]
  delete (globalThis as Record<string, unknown>).yt
})

function setup(routes: Route[] = botGuardRoutes(), options: { now?: () => number } = {}) {
  const { fetch, requests } = fakeInnerTube(...routes)
  const evaluator = createInProcessEvaluator({ origin: 'https://www.youtube.com' })
  const tokens = new WebPoTokens({ evaluator, ...(options.now ? { now: options.now } : {}) })
  return { tokens, evaluator, requests, ctx: context(fetch) }
}

describe('the page challenge', () => {
  it("reads the EVENT_ID and the challenge of YouTube's home page", () => {
    expect(parsePageChallenge(homePage())).toEqual({
      eventId: FAKE_EVENT_ID,
      interpreterUrl: FAKE_INTERPRETER_URL,
      program: FAKE_PROGRAM,
      globalName: FAKE_BOTGUARD_GLOBAL,
    })
  })

  it('refuses a page without one, or an interpreter elsewhere', () => {
    expect(() => parsePageChallenge('<html></html>')).toThrow('no attestation challenge')
    expect(() =>
      parsePageChallenge(homePage({ interpreterUrl: 'https://evil.example/js/th/x.js' })),
    ).toThrow('not where it should be')
  })
})

describe('web PO tokens', () => {
  it('runs one BotGuard session and mints a token bound to each video', async () => {
    const { tokens, requests, ctx } = setup()
    expect(await tokens.tokenFor(ctx, 'zFYEYRcjK2g')).toBe(
      fakeWebPoToken(FAKE_INTEGRITY_KEY, 'zFYEYRcjK2g'),
    )
    expect(await tokens.tokenFor(ctx, 'XqZsoesa55w')).toBe(
      fakeWebPoToken(FAKE_INTEGRITY_KEY, 'XqZsoesa55w'),
    )
    expect(requests.map((request) => `${request.method} ${request.url.href}`)).toEqual([
      `GET ${YOUTUBE_HOME_URL}`,
      `GET ${FAKE_INTERPRETER_URL}`,
      `POST ${GENERATE_IT_URL}`,
    ])
    const generate = requests[2]
    expect(JSON.parse(generate?.rawBody ?? '')).toEqual([
      BOTGUARD_REQUEST_KEY,
      `snapshot:${FAKE_PROGRAM}|config:${FAKE_EVENT_ID}`,
    ])
    expect(generate?.headers.get('content-type')).toBe('application/json+protobuf')
    expect(generate?.headers.get('x-goog-api-key')).toMatch(/^AIza/u)
    expect(requests.every((request) => request.credentials === 'omit')).toBe(true)
  })

  it('keeps a token per video, and starts a new session when the integrity token expires', async () => {
    let time = 0
    const { tokens, requests, ctx } = setup(botGuardRoutes(), { now: () => time })
    await tokens.tokenFor(ctx, 'zFYEYRcjK2g')
    await tokens.tokenFor(ctx, 'zFYEYRcjK2g')
    expect(requests).toHaveLength(3)
    time += 12 * 3_600_000
    await tokens.tokenFor(ctx, 'zFYEYRcjK2g')
    // The interpreter is cached by its URL.
    expect(requests.map((request) => request.url.href)).toEqual([
      YOUTUBE_HOME_URL,
      FAKE_INTERPRETER_URL,
      GENERATE_IT_URL,
      YOUTUBE_HOME_URL,
      GENERATE_IT_URL,
    ])
  })

  it('remembers a refused attestation for a while instead of asking again', async () => {
    const { tokens, requests, ctx } = setup(botGuardRoutes({ refuse: true }))
    await expect(tokens.tokenFor(ctx, 'zFYEYRcjK2g')).rejects.toMatchObject({
      code: 'Parse',
      message: expect.stringContaining('refused'),
    })
    await expect(tokens.tokenFor(ctx, 'zFYEYRcjK2g')).rejects.toMatchObject({ code: 'Parse' })
    expect(requests).toHaveLength(3)
  })

  it('starts a new session once when the evaluator lost BotGuard', async () => {
    const { fetch, requests } = fakeInnerTube(...botGuardRoutes())
    const evaluator = createInProcessEvaluator({ origin: 'https://www.youtube.com' })
    let lost = true
    // A restarted document has no BotGuard session: the first mint fails that way.
    const tokens = new WebPoTokens({
      evaluator: {
        ready: (options) => evaluator.ready(options),
        evaluate: (source, args, options) => evaluator.evaluate(source, args, options),
        botguardSnapshot: (challenge, options) => evaluator.botguardSnapshot(challenge, options),
        mintWebPoTokens: (integrityToken, bindings, options) => {
          if (lost) {
            lost = false
            return Promise.reject(
              Object.assign(new Error('lost'), { evaluatorCode: 'no-botguard-session' }),
            )
          }
          return evaluator.mintWebPoTokens(integrityToken, bindings, options)
        },
      },
    })
    expect(await tokens.tokenFor(context(fetch), 'abc')).toBe(
      fakeWebPoToken(FAKE_INTEGRITY_KEY, 'abc'),
    )
    expect(requests.filter((request) => request.url.href === GENERATE_IT_URL)).toHaveLength(2)
  })

  it('fails with Network when YouTube does not answer', async () => {
    const { tokens, ctx } = setup([
      (request) =>
        request.url.href === YOUTUBE_HOME_URL ? new Response('', { status: 503 }) : undefined,
    ])
    await expect(tokens.tokenFor(ctx, 'zFYEYRcjK2g')).rejects.toMatchObject({ code: 'Network' })
  })
})
