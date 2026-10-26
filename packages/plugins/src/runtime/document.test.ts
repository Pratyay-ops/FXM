import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installTestWorker, type TestWorker } from '../testing'
import { pluginRelay, pluginSource, type RelayOptions } from './document'
import { parseReply } from './protocol'

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...parameters: string[]
) => (args: unknown) => Promise<unknown>

const OPTIONS: RelayOptions = { waitMs: 2_000, maxReplyChars: 1_000_000, idleMs: 60_000 }

/** Every worker the relay started here, to count them and stop them after each test. */
const started: TestWorker[] = []

beforeAll(() => {
  installTestWorker()
  const Base = globalThis.Worker as unknown as typeof TestWorker
  ;(globalThis as { Worker: unknown }).Worker = class extends Base {
    constructor(url: string | URL) {
      super(url)
      started.push(this)
    }
  }
})

afterEach(() => {
  for (const worker of started.splice(0)) worker.terminate()
})

let keys = 0

/** Compiles a plugin's relay as the evaluator does (in this realm, as an in-process document). */
function relay(code: string, options: Partial<RelayOptions> = {}) {
  keys += 1
  const run = new AsyncFunction(
    'args',
    pluginSource(code, `test:${keys}`, { ...OPTIONS, ...options }),
  )
  return async (message: Record<string, unknown>) =>
    parseReply(await run({ fxmPlugin: 1, ...message }))
}

/** Relays one message to a worker running `script`, a worker script of the test's own. */
function rogue(script: string, options: Partial<RelayOptions> = {}) {
  keys += 1
  const key = `rogue:${keys}`
  return async (message: Record<string, unknown>) =>
    parseReply(
      await pluginRelay({ fxmPlugin: 1, ...message }, script, '', key, { ...OPTIONS, ...options }),
    )
}

const context = { mode: 'all', platform: 'web' }

function call(method: string, input: unknown = {}) {
  return { op: 'call', call: `c${Math.random()}`, method, input, context, stepMs: 2_000 }
}

describe('the plugin relay', () => {
  it('runs the plugin in a worker of its own, never in the document', async () => {
    const send = relay(`globalThis.__fxmPluginWasHere = true
    let calls = 0
    fxm.register({ async track(input) { calls += 1; return { id: input.id, calls } } })`)
    expect(await send(call('track', { id: 't1' }))).toEqual({
      state: 'done',
      value: { id: 't1', calls: 1 },
    })
    expect(await send(call('track', { id: 't2' }))).toEqual({
      state: 'done',
      value: { id: 't2', calls: 2 },
    })
    expect(started).toHaveLength(1)
    expect('__fxmPluginWasHere' in globalThis).toBe(false)
  })

  it('answers calls in flight at once, each with its own answer', async () => {
    const send = relay(`fxm.register({
      async track(input) {
        await new Promise((resolve) => setTimeout(resolve, input.wait))
        return input.id
      },
    })`)
    const [slow, fast] = await Promise.all([
      send(call('track', { id: 'slow', wait: 40 })),
      send(call('track', { id: 'fast', wait: 0 })),
    ])
    expect([slow, fast]).toEqual([
      { state: 'done', value: 'slow' },
      { state: 'done', value: 'fast' },
    ])
  })

  it('reports code that does not compile as load-failed, for every later call too', async () => {
    const send = relay('fxm.register({ async search( {')
    const failed = await send(call('search'))
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'load-failed' } })
    expect(await send(call('search'))).toEqual(failed)
    expect(started).toHaveLength(1)
  })

  it('stops a worker that stops answering, and starts a new one for the next call', async () => {
    // The plugin ends its own worker in the call: it never answers, as one that loops forever.
    const send = relay('fxm.register({ async track() { close() } })', { waitMs: 100 })
    expect(await send(call('track'))).toMatchObject({ state: 'failed', error: { code: 'hung' } })
    expect(await send(call('track'))).toMatchObject({ state: 'failed', error: { code: 'hung' } })
    expect(started).toHaveLength(2)
  })

  it('stops a worker that sat idle, so a plugin can’t keep working between calls', async () => {
    const send = relay(
      `let calls = 0
      fxm.register({ async track() { calls += 1; return calls } })`,
      { idleMs: 30 },
    )
    expect(await send(call('track'))).toEqual({ state: 'done', value: 1 })
    expect(await send(call('track'))).toEqual({ state: 'done', value: 2 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(await send(call('track'))).toEqual({ state: 'done', value: 1 })
    expect(started).toHaveLength(2)
  })

  it('answers for a call it no longer has, without starting a worker', async () => {
    const send = relay('fxm.register({ async track() { return 1 } })')
    expect(await send({ op: 'resume', call: 'gone', responses: [], stepMs: 10 })).toEqual({
      state: 'failed',
      error: { code: 'unknown-call', message: 'The call is gone' },
    })
    expect(await send({ op: 'cancel', call: 'gone' })).toEqual({ state: 'cancelled' })
    expect(await send({ fxmPlugin: 2 })).toMatchObject({
      state: 'failed',
      error: { code: 'bad-request' },
    })
    expect(started).toHaveLength(0)
  })

  it('trusts nothing the worker sends: too much, or outside the protocol, stops it', async () => {
    const huge = rogue(
      `self.postMessage({ fxmPluginWorker: 1, hello: true })
      self.addEventListener('message', (event) => {
        if (event.data.seq === undefined) return
        self.postMessage({ fxmPluginWorker: 1, seq: event.data.seq, reply: 'x'.repeat(2_000) })
      })`,
      { maxReplyChars: 1_000 },
    )
    expect(await huge(call('track'))).toMatchObject({
      state: 'failed',
      error: { code: 'too-large' },
    })
    const garbled = rogue(
      `self.addEventListener('message', () => self.postMessage({ hello: 'world' }))`,
    )
    expect(await garbled(call('track'))).toMatchObject({
      state: 'failed',
      error: { code: 'bad-reply' },
    })
    expect(started).toHaveLength(2)
  })

  it('reports a worker that fails before it starts as unavailable, for every later call', async () => {
    const send = rogue("throw new Error('no workers here')")
    const failed = await send(call('track'))
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'unavailable' } })
    expect(await send(call('track'))).toEqual(failed)
    expect(started).toHaveLength(1)
  })

  it('reports a document that can’t start workers as unavailable', async () => {
    const global = globalThis as { Worker?: unknown }
    const worker = global.Worker
    delete global.Worker
    try {
      const send = relay('fxm.register({ async track() { return 1 } })')
      expect(await send(call('track'))).toMatchObject({
        state: 'failed',
        error: { code: 'unavailable' },
      })
    } finally {
      global.Worker = worker
    }
  })
})
