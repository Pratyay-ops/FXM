import { afterEach, describe, expect, it, vi } from 'vitest'
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

const ORIGIN = 'https://example.test'

const hello = (version = EVALUATOR_PROTOCOL_VERSION, origin = ORIGIN) => ({
  channel: EVALUATOR_CHANNEL,
  type: 'ready',
  version,
  origin,
})

/** A port that answers from a handler and records what it saw. */
function fakePort(
  answer: (request: EvaluatorRequest, signal?: AbortSignal) => unknown | Promise<unknown>,
  options: { hello?: () => unknown | Promise<unknown> } = {},
) {
  const sent: EvaluatorRequest[] = []
  const signals: AbortSignal[] = []
  let opened = 0
  let closed = 0
  const port: EvaluatorPort = {
    async open(signal) {
      opened += 1
      if (signal !== undefined) signals.push(signal)
      return options.hello === undefined ? hello() : options.hello()
    },
    async send(request, signal) {
      sent.push(request)
      if (signal !== undefined) signals.push(signal)
      return answer(request, signal)
    },
    close() {
      closed += 1
    },
  }
  return {
    port,
    sent,
    signals,
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

const never = () => new Promise<never>(() => {})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE_BOTGUARD_GLOBAL]
})

describe('createEvaluator', () => {
  it('knows its origin before it starts, opens once and reports what the document announced', async () => {
    const fake = fakePort((request) => ok(request, 1))
    const evaluator = createEvaluator('desktop', fake.port, { origin: ORIGIN })
    expect(evaluator.origin).toBe(ORIGIN)
    expect(fake.opened).toBe(0)
    expect(await evaluator.ready()).toEqual({
      kind: 'desktop',
      version: EVALUATOR_PROTOCOL_VERSION,
      origin: ORIGIN,
    })
    await evaluator.evaluate('return 1')
    await evaluator.evaluate('return 1')
    expect(fake.opened).toBe(1)
  })

  it('refuses a document of another protocol version or origin, then tries again', async () => {
    let next = hello(EVALUATOR_PROTOCOL_VERSION + 1)
    const fake = fakePort((request) => ok(request, 'fine'), { hello: () => next })
    const evaluator = createEvaluator('web', fake.port, { origin: ORIGIN })
    await expect(evaluator.ready()).rejects.toMatchObject({
      name: 'FxmError',
      code: 'Unsupported',
      evaluatorCode: 'unavailable',
    })
    next = hello(EVALUATOR_PROTOCOL_VERSION, 'https://elsewhere.example')
    await expect(evaluator.ready()).rejects.toMatchObject({
      evaluatorCode: 'unavailable',
      message: expect.stringContaining('https://elsewhere.example'),
    })
    // Each refused document was stopped.
    expect(fake.closed).toBe(2)
    next = hello()
    expect(await evaluator.evaluate('return "fine"')).toBe('fine')
    expect(fake.opened).toBe(3)
  })

  it('accepts the other names its origin has', async () => {
    const fake = fakePort((request) => ok(request, 1), {
      hello: () => hello(EVALUATOR_PROTOCOL_VERSION, 'http://fxm-eval.localhost'),
    })
    const evaluator = createEvaluator('desktop', fake.port, {
      origin: 'fxm-eval://localhost',
      alsoAccept: ['http://fxm-eval.localhost'],
    })
    expect(evaluator.origin).toBe('fxm-eval://localhost')
    expect((await evaluator.ready()).origin).toBe('http://fxm-eval.localhost')
  })

  it('stops a document that does not start in time, and starts a new one for the next call', async () => {
    const clock = createFakeClock()
    let silent = true
    const fake = fakePort((request) => ok(request, 'second'), {
      hello: () => (silent ? never() : hello()),
    })
    const evaluator = createEvaluator('android', fake.port, {
      clock,
      openTimeoutMs: 1_000,
      origin: ORIGIN,
    })
    const ready = evaluator.ready()
    await clock.advanceAsync(1_000)
    await expect(ready).rejects.toMatchObject({ code: 'Unsupported', evaluatorCode: 'unavailable' })
    expect(fake.closed).toBe(1)
    expect(fake.signals[0]?.aborted).toBe(true)
    silent = false
    expect(await evaluator.evaluate('return 1')).toBe('second')
    expect(fake.opened).toBe(2)
  })

  it('shares one start between callers: a cancellation stops only its own wait', async () => {
    let started: (value: unknown) => void = () => {}
    const fake = fakePort((request) => ok(request, 'ran'), {
      hello: () =>
        new Promise((resolve) => {
          started = resolve
        }),
    })
    const evaluator = createEvaluator('web', fake.port, { origin: ORIGIN })
    const controller = new AbortController()
    const first = evaluator.ready({ signal: controller.signal })
    const second = evaluator.ready()
    const third = evaluator.evaluate('return 1')
    controller.abort(new Error('skipped'))
    await expect(first).rejects.toThrow('skipped')
    started(hello())
    expect(await second).toMatchObject({ origin: ORIGIN })
    expect(await third).toBe('ran')
    expect(fake.opened).toBe(1)
    expect(fake.closed).toBe(0)
  })

  it('times a call out as a Network failure, stops waiting for it and restarts the document', async () => {
    const clock = createFakeClock()
    let hang = true
    const fake = fakePort((request) => (hang ? never() : ok(request, 'fresh')))
    const evaluator = createEvaluator('web', fake.port, { clock, timeoutMs: 500, origin: ORIGIN })
    await evaluator.ready()
    const call = expect(evaluator.evaluate('return 1')).rejects.toMatchObject({
      code: 'Network',
      evaluatorCode: 'timeout',
    })
    await clock.advanceAsync(500)
    await call
    expect(fake.signals.at(-1)?.aborted).toBe(true)
    expect(fake.closed).toBe(1)
    hang = false
    expect(await evaluator.evaluate('return 1')).toBe('fresh')
    expect(fake.opened).toBe(2)
  })

  it('restarts a document that is gone or out of reach', async () => {
    let failure: unknown = new EvaluatorError('closed', 'The evaluator document was replaced')
    const fake = fakePort((request) => {
      if (failure === undefined) return ok(request, 'back')
      const error = failure
      failure = undefined
      throw error
    })
    const evaluator = createEvaluator('desktop', fake.port, { origin: ORIGIN })
    await expect(evaluator.evaluate('return 1')).rejects.toMatchObject({ evaluatorCode: 'closed' })
    expect(await evaluator.evaluate('return 1')).toBe('back')
    // A failure of the native bridge itself: the document can't be reached.
    failure = new Error('The evaluator window is not open')
    await expect(evaluator.evaluate('return 1')).rejects.toMatchObject({
      code: 'Unsupported',
      evaluatorCode: 'unavailable',
    })
    expect(fake.closed).toBe(2)
    expect(fake.opened).toBe(2)
  })

  it('passes on a cancellation as the signal reason, and keeps the document', async () => {
    const fake = fakePort(() => never())
    const evaluator = createEvaluator('web', fake.port, { origin: ORIGIN })
    const controller = new AbortController()
    const call = evaluator.evaluate('return 1', null, { signal: controller.signal })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    controller.abort(new Error('stop'))
    await expect(call).rejects.toThrow('stop')
    expect(fake.signals.at(-1)?.aborted).toBe(true)
    expect(fake.closed).toBe(0)
  })

  it('maps the document errors to Parse failures that keep their code', async () => {
    const fake = fakePort((request) => ({
      channel: EVALUATOR_CHANNEL,
      id: request.id,
      ok: false,
      error: { code: 'script-error', message: 'TypeError: boom' },
    }))
    const evaluator = createEvaluator('web', fake.port, { origin: ORIGIN })
    const failure = await evaluator.evaluate('boom()').catch((error: unknown) => error)
    expect(isEvaluatorError(failure, 'script-error')).toBe(true)
    expect(failure).toMatchObject({ code: 'Parse', message: expect.stringContaining('boom') })
    expect(fake.closed).toBe(0)
  })

  it('refuses an answer to another request, or no answer at all', async () => {
    const wrongId = fakePort((request) => ok({ ...request, id: request.id + 1 }, 1))
    await expect(
      createEvaluator('web', wrongId.port, { origin: ORIGIN }).evaluate('return 1'),
    ).rejects.toMatchObject({ evaluatorCode: 'bad-request' })
    const garbage = fakePort(() => 'nonsense')
    await expect(
      createEvaluator('web', garbage.port, { origin: ORIGIN }).evaluate('return 1'),
    ).rejects.toMatchObject({ evaluatorCode: 'bad-request' })
  })

  it('numbers requests from a random start, so two hosts never share an id', async () => {
    const first = fakePort((request) => ok(request, 1))
    const second = fakePort((request) => ok(request, 1))
    const a = createEvaluator('desktop', first.port, { origin: ORIGIN })
    const b = createEvaluator('desktop', second.port, { origin: ORIGIN })
    await a.evaluate('return 1')
    await a.evaluate('return 1')
    await b.evaluate('return 1')
    const [one, two] = first.sent.map((request) => request.id)
    expect(two).toBe((one ?? 0) + 1)
    expect(Number.isSafeInteger(one)).toBe(true)
    expect(second.sent[0]?.id).not.toBe(one)
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
    const evaluator = createEvaluator('web', fake.port, { origin: ORIGIN })
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
    expect(evaluator.origin).toBe('https://www.youtube.com')
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
    const evaluator = createEvaluator('web', fake.port, { origin: ORIGIN })
    await expect(evaluator.botguardSnapshot(fakeBotGuardChallenge())).rejects.toBeInstanceOf(
      EvaluatorError,
    )
    await expect(evaluator.mintWebPoTokens('it', ['v'])).rejects.toMatchObject({
      evaluatorCode: 'bad-request',
    })
  })

  it('ends a start in progress when disposed', async () => {
    const fake = fakePort((request) => ok(request, 1), { hello: never })
    const evaluator = createEvaluator('web', fake.port, { origin: ORIGIN })
    const ready = evaluator.ready()
    await vi.waitFor(() => expect(fake.opened).toBe(1))
    evaluator.dispose()
    await expect(ready).rejects.toMatchObject({ evaluatorCode: 'closed' })
    expect(fake.signals[0]?.aborted).toBe(true)
  })

  it('stops the document once and refuses calls afterwards', async () => {
    const fake = fakePort((request) => ok(request, 1))
    const evaluator = createEvaluator('web', fake.port, { origin: ORIGIN })
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
