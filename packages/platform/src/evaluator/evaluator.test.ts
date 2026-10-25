import { afterEach, describe, expect, it } from 'vitest'
import {
  FAKE_BOTGUARD_GLOBAL,
  fakeBotGuardChallenge,
  fakeIntegrityToken,
  fakeWebPoToken,
} from '../testing/fake-botguard'
import { createFakeClock } from '../testing/fake-clock'
import { createInProcessEvaluator } from '../testing/in-process-evaluator'
import { createEvaluator, EvaluatorError, type EvaluatorPort, isEvaluatorError } from './evaluator'
import { EVALUATOR_CHANNEL, EVALUATOR_PROTOCOL_VERSION, type EvaluatorRequest } from './protocol'

const hello = (version = EVALUATOR_PROTOCOL_VERSION, origin = 'https://example.test') => ({
  channel: EVALUATOR_CHANNEL,
  type: 'ready',
  version,
  origin,
})

/** A port that answers from a handler and records what it saw. */
function fakePort(
  answer: (request: EvaluatorRequest) => unknown | Promise<unknown>,
  options: { hello?: unknown } = {},
) {
  const sent: EvaluatorRequest[] = []
  let opened = 0
  let closed = 0
  const port: EvaluatorPort = {
    async open() {
      opened += 1
      return options.hello ?? hello()
    },
    async send(request) {
      sent.push(request)
      return answer(request)
    },
    close() {
      closed += 1
    },
  }
  return {
    port,
    sent,
    get opened() {
      return opened
    },
    get closed() {
      return closed
    },
  }
}

const ok = (request: EvaluatorRequest, result: unknown) => ({
  channel: EVALUATOR_CHANNEL,
  id: request.id,
  ok: true,
  result,
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE_BOTGUARD_GLOBAL]
})

describe('createEvaluator', () => {
  it('opens the document once and reports what it announced', async () => {
    const fake = fakePort((request) => ok(request, 1))
    const evaluator = createEvaluator('desktop', fake.port)
    expect(await evaluator.ready()).toEqual({
      kind: 'desktop',
      version: EVALUATOR_PROTOCOL_VERSION,
      origin: 'https://example.test',
    })
    await evaluator.evaluate('return 1')
    await evaluator.evaluate('return 1')
    expect(fake.opened).toBe(1)
  })

  it('refuses a document that speaks another protocol version, then tries again', async () => {
    let version = EVALUATOR_PROTOCOL_VERSION + 1
    const port: EvaluatorPort = {
      async open() {
        return hello(version)
      },
      async send(request) {
        return ok(request, 'fine')
      },
      close() {},
    }
    const evaluator = createEvaluator('web', port)
    await expect(evaluator.ready()).rejects.toMatchObject({
      name: 'FxmError',
      code: 'Unsupported',
      evaluatorCode: 'unavailable',
    })
    version = EVALUATOR_PROTOCOL_VERSION
    expect(await evaluator.evaluate('return "fine"')).toBe('fine')
  })

  it('reports a document that does not start in time as unavailable', async () => {
    const clock = createFakeClock()
    const port: EvaluatorPort = {
      open: () => new Promise(() => {}),
      send: () => new Promise(() => {}),
      close() {},
    }
    const evaluator = createEvaluator('android', port, { clock, openTimeoutMs: 1_000 })
    const ready = evaluator.ready()
    await clock.advanceAsync(1_000)
    await expect(ready).rejects.toMatchObject({ code: 'Unsupported', evaluatorCode: 'unavailable' })
  })

  it('times a call out as a Network failure', async () => {
    const clock = createFakeClock()
    const fake = fakePort(() => new Promise(() => {}))
    const evaluator = createEvaluator('web', fake.port, { clock, timeoutMs: 500 })
    await evaluator.ready()
    const call = expect(evaluator.evaluate('return 1')).rejects.toMatchObject({
      code: 'Network',
      evaluatorCode: 'timeout',
    })
    await clock.advanceAsync(500)
    await call
  })

  it('passes on a cancellation as the signal reason', async () => {
    const fake = fakePort(() => new Promise(() => {}))
    const evaluator = createEvaluator('web', fake.port)
    const controller = new AbortController()
    const call = evaluator.evaluate('return 1', null, { signal: controller.signal })
    await evaluator.ready()
    controller.abort(new Error('stop'))
    await expect(call).rejects.toThrow('stop')
  })

  it('maps the document errors to Parse failures that keep their code', async () => {
    const fake = fakePort((request) => ({
      channel: EVALUATOR_CHANNEL,
      id: request.id,
      ok: false,
      error: { code: 'script-error', message: 'TypeError: boom' },
    }))
    const evaluator = createEvaluator('web', fake.port)
    const failure = await evaluator.evaluate('boom()').catch((error: unknown) => error)
    expect(isEvaluatorError(failure, 'script-error')).toBe(true)
    expect(failure).toMatchObject({ code: 'Parse', message: expect.stringContaining('boom') })
  })

  it('refuses an answer to another request, or no answer at all', async () => {
    const wrongId = fakePort((request) => ok({ ...request, id: request.id + 1 }, 1))
    await expect(createEvaluator('web', wrongId.port).evaluate('return 1')).rejects.toMatchObject({
      evaluatorCode: 'bad-request',
    })
    const garbage = fakePort(() => 'nonsense')
    await expect(createEvaluator('web', garbage.port).evaluate('return 1')).rejects.toMatchObject({
      evaluatorCode: 'bad-request',
    })
  })

  it('defines a keyed script once, then sends only its arguments', async () => {
    const evaluator = createInProcessEvaluator()
    expect(await evaluator.evaluate('return args * 3', 2, { key: 'triple' })).toBe(6)
    expect(await evaluator.evaluate('return args * 3', 5, { key: 'triple' })).toBe(15)
    expect(evaluator.requests.map((request) => request.method)).toEqual([
      'define',
      'invoke',
      'invoke',
    ])
  })

  it('defines a keyed script again when the document forgot it', async () => {
    let forgotten = true
    const fake = fakePort((request) => {
      if (request.method === 'invoke' && forgotten) {
        forgotten = false
        return {
          channel: EVALUATOR_CHANNEL,
          id: request.id,
          ok: false,
          error: { code: 'unknown-key', message: 'gone' },
        }
      }
      return ok(request, request.method === 'invoke' ? 'ran' : null)
    })
    const evaluator = createEvaluator('web', fake.port)
    expect(await evaluator.evaluate('return "ran"', null, { key: 'k' })).toBe('ran')
    expect(fake.sent.map((request) => request.method)).toEqual([
      'define',
      'invoke',
      'define',
      'invoke',
    ])
  })

  it('takes a BotGuard snapshot and mints tokens through the document', async () => {
    const evaluator = createInProcessEvaluator({ origin: 'https://www.youtube.com' })
    expect((await evaluator.ready()).origin).toBe('https://www.youtube.com')
    expect(await evaluator.botguardSnapshot(fakeBotGuardChallenge({ program: 'p' }))).toBe(
      'snapshot:p',
    )
    expect(await evaluator.mintWebPoTokens(fakeIntegrityToken('it'), ['abc', 'def'])).toEqual([
      fakeWebPoToken('it', 'abc'),
      fakeWebPoToken('it', 'def'),
    ])
  })

  it('refuses answers that are no snapshot or no token list', async () => {
    const fake = fakePort((request) => ok(request, request.method === 'botguard.mint' ? [''] : 5))
    const evaluator = createEvaluator('web', fake.port)
    await expect(evaluator.botguardSnapshot(fakeBotGuardChallenge())).rejects.toBeInstanceOf(
      EvaluatorError,
    )
    await expect(evaluator.mintWebPoTokens('it', ['v'])).rejects.toMatchObject({
      evaluatorCode: 'bad-request',
    })
  })

  it('stops the document once and refuses calls afterwards', async () => {
    const fake = fakePort((request) => ok(request, 1))
    const evaluator = createEvaluator('web', fake.port)
    await evaluator.evaluate('return 1')
    evaluator.dispose()
    evaluator.dispose()
    expect(fake.closed).toBe(1)
    await expect(evaluator.evaluate('return 1')).rejects.toMatchObject({
      code: 'Unsupported',
      evaluatorCode: 'closed',
    })
  })
})
