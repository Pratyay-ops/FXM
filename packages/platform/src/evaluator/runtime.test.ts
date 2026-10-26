import { afterEach, describe, expect, it } from 'vitest'
import {
  FAKE_BOTGUARD_GLOBAL,
  fakeBotGuardChallenge,
  fakeIntegrityToken,
  fakeWebPoToken,
} from '../testing/fake-botguard'
import { EVALUATOR_CHANNEL, type EvaluatorRequest } from './protocol'
import { createEvaluatorRuntime, MAX_DEFINED_FUNCTIONS } from './runtime'

let nextId = 1
function request<M extends EvaluatorRequest['method']>(
  method: M,
  params: Extract<EvaluatorRequest, { method: M }>['params'],
): EvaluatorRequest {
  const id = nextId
  nextId += 1
  return { channel: EVALUATOR_CHANNEL, id, method, params } as EvaluatorRequest
}

const global = globalThis as Record<string, unknown>

afterEach(() => {
  delete global[FAKE_BOTGUARD_GLOBAL]
  delete global.yt
})

describe('the evaluator runtime', () => {
  it('runs a script once with its arguments and answers the result', async () => {
    const runtime = createEvaluatorRuntime()
    const message = request('evaluate', { source: 'return args.a + args.b', args: { a: 2, b: 3 } })
    expect(await runtime.handle(message)).toEqual({
      channel: EVALUATOR_CHANNEL,
      id: message.id,
      ok: true,
      result: 5,
    })
  })

  it('awaits a promise, turns undefined into null and copies serializable objects', async () => {
    const runtime = createEvaluatorRuntime()
    const answer = (source: string) =>
      runtime.handle(request('evaluate', { source, args: null })).then((response) => response)
    expect(await answer('return Promise.resolve([1, "x"])')).toMatchObject({ result: [1, 'x'] })
    expect(await answer('return undefined')).toMatchObject({ ok: true, result: null })
    expect(await answer('return new Date(0)')).toMatchObject({ result: '1970-01-01T00:00:00.000Z' })
  })

  it('reports scripts that do not compile, throw, reject or return no JSON', async () => {
    const runtime = createEvaluatorRuntime()
    const error = async (source: string) => {
      const response = await runtime.handle(request('evaluate', { source, args: null }))
      return response?.ok === false ? response.error : undefined
    }
    expect(await error('return (')).toMatchObject({ code: 'script-error' })
    expect(await error('throw new TypeError("boom")')).toMatchObject({
      code: 'script-error',
      message: expect.stringContaining('TypeError: boom'),
    })
    expect(await error('return Promise.reject(new Error("no"))')).toMatchObject({
      code: 'script-error',
    })
    expect(await error('return function () {}')).toMatchObject({ code: 'not-json' })
    expect(await error('const a = {}; a.a = a; return a')).toMatchObject({ code: 'not-json' })
  })

  it('keeps defined functions, runs them by key and forgets the least recently used', async () => {
    const runtime = createEvaluatorRuntime()
    await runtime.handle(request('define', { key: 'double', source: 'return args * 2' }))
    expect(await runtime.handle(request('invoke', { key: 'double', args: 21 }))).toMatchObject({
      ok: true,
      result: 42,
    })
    for (let index = 0; index < MAX_DEFINED_FUNCTIONS; index += 1) {
      await runtime.handle(request('define', { key: `f${index}`, source: 'return 0' }))
    }
    expect(await runtime.handle(request('invoke', { key: 'double', args: 1 }))).toMatchObject({
      ok: false,
      error: { code: 'unknown-key' },
    })
    expect(await runtime.handle(request('invoke', { key: 'f7', args: 1 }))).toMatchObject({
      ok: true,
      result: 0,
    })
  })

  it('answers malformed requests with bad-request, and ignores other messages', async () => {
    const runtime = createEvaluatorRuntime()
    expect(
      await runtime.handle({ channel: EVALUATOR_CHANNEL, id: 7, method: 'evaluate', params: {} }),
    ).toEqual({
      channel: EVALUATOR_CHANNEL,
      id: 7,
      ok: false,
      error: { code: 'bad-request', message: 'The request is malformed' },
    })
    expect(await runtime.handle({ channel: 'other', id: 1 })).toBeUndefined()
    expect(await runtime.handle('text')).toBeUndefined()
  })

  it('keeps working after a script replaces JSON and Function', async () => {
    const runtime = createEvaluatorRuntime()
    const json = globalThis.JSON
    const functionConstructor = globalThis.Function
    try {
      await runtime.handle(
        request('evaluate', {
          source: 'globalThis.JSON = { stringify() { return "x" } }; globalThis.Function = null',
          args: null,
        }),
      )
      expect(
        await runtime.handle(request('evaluate', { source: 'return { a: [1] }', args: null })),
      ).toMatchObject({ ok: true, result: { a: [1] } })
    } finally {
      globalThis.JSON = json
      globalThis.Function = functionConstructor
    }
  })

  describe('BotGuard', () => {
    it('takes a snapshot, then mints one token per content binding', async () => {
      const runtime = createEvaluatorRuntime()
      const challenge = fakeBotGuardChallenge({ program: 'p1' })
      expect(await runtime.handle(request('botguard.snapshot', challenge))).toMatchObject({
        ok: true,
        result: 'snapshot:p1',
      })
      const integrityToken = fakeIntegrityToken('it-1')
      expect(
        await runtime.handle(
          request('botguard.mint', { integrityToken, contentBindings: ['video-a', 'video-b'] }),
        ),
      ).toMatchObject({
        ok: true,
        result: [fakeWebPoToken('it-1', 'video-a'), fakeWebPoToken('it-1', 'video-b')],
      })
    })

    it('gives BotGuard the page configuration as yt.config_', async () => {
      const runtime = createEvaluatorRuntime()
      const challenge = { ...fakeBotGuardChallenge(), pageConfig: { EVENT_ID: 'event-1' } }
      expect(await runtime.handle(request('botguard.snapshot', challenge))).toMatchObject({
        result: 'snapshot:fake-program|config:event-1',
      })
    })

    it('builds a new minter when the integrity token changes', async () => {
      const runtime = createEvaluatorRuntime()
      await runtime.handle(request('botguard.snapshot', fakeBotGuardChallenge()))
      const mint = (key: string) =>
        runtime.handle(
          request('botguard.mint', {
            integrityToken: fakeIntegrityToken(key),
            contentBindings: ['v'],
          }),
        )
      expect(await mint('first')).toMatchObject({ result: [fakeWebPoToken('first', 'v')] })
      expect(await mint('second')).toMatchObject({ result: [fakeWebPoToken('second', 'v')] })
    })

    it('refuses to mint before a snapshot', async () => {
      const runtime = createEvaluatorRuntime()
      expect(
        await runtime.handle(
          request('botguard.mint', {
            integrityToken: fakeIntegrityToken('k'),
            contentBindings: ['v'],
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: 'no-botguard-session' } })
    })

    it('reports an interpreter that fails or defines no VM', async () => {
      const runtime = createEvaluatorRuntime()
      const failing = { ...fakeBotGuardChallenge(), interpreter: 'throw new Error("nope")' }
      expect(await runtime.handle(request('botguard.snapshot', failing))).toMatchObject({
        ok: false,
        error: { code: 'botguard-unavailable' },
      })
      const empty = { ...fakeBotGuardChallenge(), interpreter: 'var nothing = 1' }
      expect(await runtime.handle(request('botguard.snapshot', empty))).toMatchObject({
        ok: false,
        error: { code: 'botguard-unavailable', message: expect.stringContaining('no VM') },
      })
    })

    it('reports a snapshot that leaves no minter, as a failed attestation does', async () => {
      const runtime = createEvaluatorRuntime()
      await runtime.handle(
        request('botguard.snapshot', fakeBotGuardChallenge({ withoutMinter: true })),
      )
      expect(
        await runtime.handle(
          request('botguard.mint', {
            integrityToken: fakeIntegrityToken('k'),
            contentBindings: ['v'],
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: 'botguard-failed' } })
    })
  })
})
