import { describe, expect, it } from 'vitest'
import { pluginRuntime, pluginSource } from './document'
import { parseReply } from './protocol'

/** Node's `vm`, without Node's types. */
interface NodeVm {
  createContext(sandbox: object): object
  runInContext(code: string, context: object): unknown
}
const vm = (
  globalThis as unknown as { process: { getBuiltinModule(id: 'node:vm'): NodeVm } }
).process.getBuiltinModule('node:vm')

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...parameters: string[]
) => (args: unknown) => Promise<unknown>

let keys = 0

/** Compiles a plugin as the evaluator would, and returns a function that sends it a message. */
function plugin(code: string) {
  keys += 1
  const run = new AsyncFunction('args', pluginSource(code, `test:${keys}`))
  return async (message: Record<string, unknown>) => {
    const raw = await run({ fxmPlugin: 1, ...message })
    // As over the evaluator's channel: JSON both ways.
    return parseReply(JSON.parse(JSON.stringify(raw)))
  }
}

const context = { mode: 'all', platform: 'web', locale: 'en-IN' }

function call(method: string, params: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { op: 'call', call: `c${Math.random()}`, method, params, context, stepMs: 2_000, ...extra }
}

function ok(id: number, body: unknown, extra: Record<string, unknown> = {}) {
  return {
    id,
    ok: true,
    status: 200,
    statusText: 'OK',
    url: `https://api.example.org/${id}`,
    headers: [['content-type', 'application/json']],
    body: JSON.stringify(body),
    ...extra,
  }
}

describe('the plugin runtime', () => {
  it('runs a handler with its parameters and the context, and answers with its result', async () => {
    const send = plugin(`fxm.register({
      async search(query, options, ctx) {
        return { query, options, mode: ctx.mode, platform: ctx.platform, locale: ctx.locale, api: fxm.api }
      },
    })`)
    expect(await send(call('search', ['moths', { types: ['track'] }]))).toEqual({
      state: 'done',
      value: {
        query: 'moths',
        options: { types: ['track'] },
        mode: 'all',
        platform: 'web',
        locale: 'en-IN',
        api: 1,
      },
    })
  })

  it('accepts handlers returned instead of registered, and runs the code in strict mode', async () => {
    const send = plugin(
      `return { async track() { return this === undefined ? 'strict?' : typeof this } }`,
    )
    expect(await send(call('track', ['t1']))).toEqual({ state: 'done', value: 'object' })
    const strict = plugin(
      `fxm.register({ async track() { return (function () { return this })() === undefined } })`,
    )
    expect(await strict(call('track', ['t1']))).toEqual({ state: 'done', value: true })
  })

  it('hands requests to the host, the ones of one turn together, and resumes with the answers', async () => {
    const send = plugin(`fxm.register({
      async search(query, options, ctx) {
        const [a, b] = await Promise.all([
          ctx.fetch('https://api.example.org/a', { headers: { Accept: 'application/json' } }),
          ctx.fetch(new URL('https://api.example.org/b'), { method: 'post', body: 'x=1' }),
        ])
        const c = await ctx.fetch('https://api.example.org/c')
        return [await a.json(), await b.text(), a.status, a.headers.get('content-type'), a.url, (await c.json()).n]
      },
    })`)
    const message = call('search', ['moths', {}])
    const first = await send(message)
    expect(first).toEqual({
      state: 'fetch',
      requests: [
        {
          id: 1,
          url: 'https://api.example.org/a',
          method: 'GET',
          headers: [['Accept', 'application/json']],
        },
        { id: 2, url: 'https://api.example.org/b', method: 'POST', headers: [], body: 'x=1' },
      ],
    })
    const second = await send({
      op: 'resume',
      call: message.call,
      responses: [ok(1, { n: 1 }), ok(2, 'two')],
      stepMs: 2_000,
    })
    expect(second).toMatchObject({ state: 'fetch', requests: [{ id: 3 }] })
    const done = await send({
      op: 'resume',
      call: message.call,
      responses: [ok(3, { n: 3 })],
      stepMs: 2_000,
    })
    expect(done).toEqual({
      state: 'done',
      value: [{ n: 1 }, '"two"', 200, 'application/json', 'https://api.example.org/1', 3],
    })
  })

  it('rejects a failed request in the plugin with its reason, which the plugin may pass on', async () => {
    const send = plugin(`fxm.register({
      async track(id, ctx) {
        try {
          await ctx.fetch('https://elsewhere.example/x')
        } catch (error) {
          return { name: error.name, code: error.code, fxmCode: error.fxmCode, message: error.message }
        }
      },
      async album(id, ctx) {
        await ctx.fetch('https://api.example.org/x')
      },
    })`)
    const message = call('track', ['t1'])
    await send(message)
    const failure = {
      id: 1,
      ok: false,
      error: { code: 'host-not-declared', fxmCode: 'Unsupported', message: 'Not declared' },
    }
    expect(
      await send({ op: 'resume', call: message.call, responses: [failure], stepMs: 2_000 }),
    ).toEqual({
      state: 'done',
      value: {
        name: 'FxmPluginError',
        code: 'host-not-declared',
        fxmCode: 'Unsupported',
        message: 'Not declared',
      },
    })
    const unhandled = call('album', ['al1'])
    await send(unhandled)
    const limited = {
      id: 1,
      ok: false,
      error: {
        code: 'rate-limited',
        fxmCode: 'RateLimited',
        message: 'Slow down',
        retryAfterMs: 5000,
      },
    }
    expect(
      await send({ op: 'resume', call: unhandled.call, responses: [limited], stepMs: 2_000 }),
    ).toEqual({
      state: 'failed',
      error: {
        code: 'plugin-failed',
        message: 'FxmPluginError: Slow down',
        fxmCode: 'RateLimited',
        retryAfterMs: 5000,
      },
    })
  })

  it('builds responses without a body where HTTP has none', async () => {
    const send = plugin(`fxm.register({
      async track(id, ctx) {
        const response = await ctx.fetch('https://api.example.org/empty')
        return [response.status, await response.text(), response.ok]
      },
    })`)
    const message = call('track', ['t1'])
    await send(message)
    expect(
      await send({
        op: 'resume',
        call: message.call,
        responses: [ok(1, 'ignored', { status: 204, statusText: 'No Content' })],
        stepMs: 2_000,
      }),
    ).toEqual({ state: 'done', value: [204, '', true] })
  })

  it('reports what a handler threw, with the code fxm.fail gave', async () => {
    const send = plugin(`fxm.register({
      async track() { fxm.fail('NotFound', 'No such track', { retryAfterMs: 10 }) },
      async album() { throw new TypeError('bad\\n\\nthing') },
      async artist() { throw 'just a string' },
    })`)
    expect(await send(call('track', ['t1']))).toEqual({
      state: 'failed',
      error: {
        code: 'plugin-failed',
        message: 'FxmPluginError: No such track',
        fxmCode: 'NotFound',
        retryAfterMs: 10,
      },
    })
    expect(await send(call('album', ['al1']))).toEqual({
      state: 'failed',
      error: { code: 'plugin-failed', message: 'TypeError: bad thing' },
    })
    expect(await send(call('artist', ['a1']))).toEqual({
      state: 'failed',
      error: { code: 'plugin-failed', message: 'just a string' },
    })
  })

  it('fails every call of a plugin that does not load', async () => {
    for (const code of [
      `throw new Error('broken at load')`,
      `const nothing = 1`,
      `fxm.register({}); fxm.register({})`,
      `fxm.register(42)`,
    ]) {
      const send = plugin(code)
      const reply = await send(call('search', ['q', {}]))
      expect(reply).toMatchObject({ state: 'failed', error: { code: 'load-failed' } })
      expect(await send(call('search', ['q', {}]))).toEqual(reply)
    }
  })

  it('says so when the plugin has no handler for an operation', async () => {
    const send = plugin(`fxm.register({ async search() { return {} } })`)
    expect(await send(call('resolve', [{}]))).toEqual({
      state: 'failed',
      error: { code: 'not-implemented', message: 'The plugin has no handler for resolve' },
    })
  })

  it('answers results that are not JSON as such, and undefined as null', async () => {
    const send = plugin(`fxm.register({
      async track() { return 10n },
      async album() { const loop = {}; loop.loop = loop; return loop },
      async artist() { return undefined },
      async playlist() { return () => 1 },
    })`)
    expect(await send(call('track', ['t1']))).toMatchObject({
      state: 'failed',
      error: { code: 'not-json' },
    })
    expect(await send(call('album', ['al1']))).toMatchObject({
      state: 'failed',
      error: { code: 'not-json' },
    })
    expect(await send(call('artist', ['a1']))).toEqual({ state: 'done', value: null })
    expect(await send(call('playlist', ['p1']))).toEqual({ state: 'done', value: null })
  })

  it('answers idle while a handler waits for something else, and goes on when resumed', async () => {
    const send = plugin(`fxm.register({
      async track() {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return 'late'
      },
    })`)
    const message = call('track', ['t1'], { stepMs: 10 })
    expect(await send(message)).toEqual({ state: 'idle' })
    let reply = await send({ op: 'resume', call: message.call, responses: [], stepMs: 10 })
    while (reply?.state === 'idle') {
      reply = await send({ op: 'resume', call: message.call, responses: [], stepMs: 10 })
    }
    expect(reply).toEqual({ state: 'done', value: 'late' })
  })

  it('cancels a call: its signal aborts, its requests fail and the call is gone', async () => {
    const send = plugin(`fxm.register({
      async track(id, ctx) {
        globalThis.__fxmTestSignal = ctx.signal
        try {
          await ctx.fetch('https://api.example.org/slow')
        } catch (error) {
          globalThis.__fxmTestCancelled = error.message
        }
        return 'unused'
      },
    })`)
    const message = call('track', ['t1'])
    expect(await send(message)).toMatchObject({ state: 'fetch' })
    expect(await send({ op: 'cancel', call: message.call })).toEqual({ state: 'cancelled' })
    const global = globalThis as unknown as Record<string, unknown>
    expect((global.__fxmTestSignal as AbortSignal).aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(global.__fxmTestCancelled).toBe('The call was cancelled')
    expect(await send({ op: 'resume', call: message.call, responses: [], stepMs: 10 })).toEqual({
      state: 'failed',
      error: { code: 'unknown-call', message: 'The call is gone' },
    })
    delete global.__fxmTestSignal
    delete global.__fxmTestCancelled
  })

  it('refuses malformed messages, and more than 32 calls at once', async () => {
    const send = plugin(
      `fxm.register({ async track(id, ctx) { await ctx.fetch('https://api.example.org/x') } })`,
    )
    expect(await send({ op: 'dance' })).toMatchObject({
      state: 'failed',
      error: { code: 'bad-request' },
    })
    expect(await send({ op: 'call', method: 'track' })).toMatchObject({
      state: 'failed',
      error: { code: 'bad-request' },
    })
    const runtime = pluginRuntime as (input: unknown, factory: unknown, key: string) => unknown
    expect(await runtime({ fxmPlugin: 2 }, () => ({}), 'other')).toMatchObject({
      state: 'failed',
      error: { code: 'bad-request' },
    })
    for (let index = 0; index < 32; index += 1) {
      expect(await send(call('track', ['t1']))).toMatchObject({ state: 'fetch' })
    }
    expect(await send(call('track', ['t1']))).toEqual({
      state: 'failed',
      error: { code: 'busy', message: 'Too many calls at once' },
    })
  })

  it('refuses request bodies that are not text', async () => {
    const send = plugin(`fxm.register({
      async track(id, ctx) {
        try { await ctx.fetch('https://api.example.org/x', { method: 'POST', body: new Uint8Array(1) }) }
        catch (error) { return error.message }
      },
    })`)
    expect(await send(call('track', ['t1']))).toEqual({
      state: 'done',
      value: 'ctx.fetch sends text bodies only',
    })
  })

  it('needs nothing from outside its own source text: it runs in a fresh realm', async () => {
    const realm = vm.createContext({
      setTimeout,
      clearTimeout,
      Response,
      AbortController,
    })
    const source = pluginSource(
      `fxm.register({ async search(query, options, ctx) {
        const response = await ctx.fetch('https://api.example.org/q?' + query)
        return { got: await response.text(), mode: ctx.mode }
      } })`,
      'fresh-realm',
    )
    const run = vm.runInContext(`(async function (args) {\n${source}\n})`, realm) as (
      args: unknown,
    ) => Promise<unknown>
    const first = parseReply(
      JSON.parse(
        JSON.stringify(await run({ fxmPlugin: 1, ...call('search', ['x', {}]), call: 'v1' })),
      ),
    )
    expect(first).toMatchObject({
      state: 'fetch',
      requests: [{ url: 'https://api.example.org/q?x' }],
    })
    const done = parseReply(
      JSON.parse(
        JSON.stringify(
          await run({
            fxmPlugin: 1,
            op: 'resume',
            call: 'v1',
            responses: [ok(1, 'hi')],
            stepMs: 2_000,
          }),
        ),
      ),
    )
    expect(done).toEqual({ state: 'done', value: { got: '"hi"', mode: 'all' } })
  })
})
