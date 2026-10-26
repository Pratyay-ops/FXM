import { afterEach, describe, expect, it } from 'vitest'
import { TestWorker } from '../testing'
import { parseReply } from './protocol'
import { pluginWorkerScript } from './worker'

const workers: TestWorker[] = []

afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate()
})

/**
 * Starts a plugin's worker script in a fresh realm, as the relay does, and returns a function
 * that sends it a message and resolves with its parsed reply.
 */
function plugin(code: string, maxChars = 1_000_000) {
  const url = URL.createObjectURL(new Blob([pluginWorkerScript()]))
  const worker = new TestWorker(url)
  // As the relay does: the plugin's code first.
  worker.postMessage({ fxmPluginWorker: 1, code })
  workers.push(worker)
  let seq = 0
  let hello = false
  const waiting = new Map<number, (reply: unknown) => void>()
  worker.onmessage = ({ data }) => {
    const message = data as { hello?: boolean; seq?: number; reply?: unknown }
    if (message.hello === true) hello = true
    else if (message.seq !== undefined) waiting.get(message.seq)?.(message.reply)
  }
  const send = (message: Record<string, unknown>) => {
    seq += 1
    const id = seq
    return new Promise<unknown>((resolve) => {
      waiting.set(id, resolve)
      worker.postMessage({
        fxmPluginWorker: 1,
        seq: id,
        message: { fxmPlugin: 1, ...message },
        maxChars,
      })
    }).then(parseReply)
  }
  return Object.assign(send, { started: () => hello })
}

const context = { mode: 'all', platform: 'web', locale: 'en-IN' }

function call(method: string, input: unknown = {}, extra: Record<string, unknown> = {}) {
  return { op: 'call', call: `c${Math.random()}`, method, input, context, stepMs: 2_000, ...extra }
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

describe('the plugin worker', () => {
  it('announces itself, runs a handler with its input and the context, and answers', async () => {
    const send = plugin(`fxm.register({
      async search(input, ctx) {
        return { input, mode: ctx.mode, platform: ctx.platform, locale: ctx.locale, api: fxm.api }
      },
    })`)
    expect(await send(call('search', { query: 'moths', types: ['track'] }))).toEqual({
      state: 'done',
      value: {
        input: { query: 'moths', types: ['track'] },
        mode: 'all',
        platform: 'web',
        locale: 'en-IN',
        api: 1,
      },
    })
    expect(send.started()).toBe(true)
  })

  it('accepts handlers returned instead of registered, and runs the code in strict mode', async () => {
    const send = plugin(
      `return { async track() { return this === undefined ? 'strict?' : typeof this } }`,
    )
    expect(await send(call('track', { id: 't1' }))).toEqual({ state: 'done', value: 'object' })
    const strict = plugin(
      `fxm.register({ async track() { return (function () { return this })() === undefined } })`,
    )
    expect(await strict(call('track', { id: 't1' }))).toEqual({ state: 'done', value: true })
  })

  it('compiles the plugin’s code as a function body, which it can’t leave', async () => {
    const send = plugin('}); postMessage({ fxmPluginWorker: 1, seq: 1, reply: "{}" }); ({')
    expect(await send(call('track'))).toMatchObject({
      state: 'failed',
      error: { code: 'load-failed', message: expect.stringMatching(/^SyntaxError/u) },
    })
  })

  it('leaves the plugin no way to post to the document itself', async () => {
    const send = plugin(`fxm.register({
      async track() {
        let posted
        try { postMessage('hi'); posted = 'posted' } catch (error) { posted = error.name }
        return { posted, onSelf: typeof self.postMessage }
      },
    })`)
    expect(await send(call('track', { id: 't1' }))).toEqual({
      state: 'done',
      value: { posted: 'ReferenceError', onSelf: 'undefined' },
    })
  })

  it('hands requests to the host, the ones of one turn together, and resumes with the answers', async () => {
    const send = plugin(`fxm.register({
      async search(input, ctx) {
        const [a, b] = await Promise.all([
          ctx.fetch('https://api.example.org/a'),
          ctx.fetch(new URL('https://api.example.org/b'), { method: 'head', headers: { Accept: 'text/plain' } }),
        ])
        const c = await ctx.fetch('https://api.example.org/c')
        return [await a.json(), b.status, a.headers.get('content-type'), a.url, (await c.json()).n]
      },
    })`)
    const message = call('search', { query: 'moths' })
    expect(await send(message)).toEqual({
      state: 'fetch',
      requests: [
        { id: 1, url: 'https://api.example.org/a', method: 'GET', headers: [] },
        // The worker hands on whatever the plugin asked for: the host decides.
        {
          id: 2,
          url: 'https://api.example.org/b',
          method: 'HEAD',
          headers: [['Accept', 'text/plain']],
        },
      ],
    })
    const second = await send({
      op: 'resume',
      call: message.call,
      responses: [ok(1, { n: 1 }), ok(2, '')],
      stepMs: 2_000,
    })
    expect(second).toMatchObject({ state: 'fetch', requests: [{ id: 3 }] })
    expect(
      await send({ op: 'resume', call: message.call, responses: [ok(3, { n: 3 })], stepMs: 2_000 }),
    ).toEqual({
      state: 'done',
      value: [{ n: 1 }, 200, 'application/json', 'https://api.example.org/1', 3],
    })
  })

  it('rejects a failed request in the plugin with its reason, which the plugin may pass on', async () => {
    const send = plugin(`fxm.register({
      async track(input, ctx) {
        try {
          await ctx.fetch('https://elsewhere.example/x')
        } catch (error) {
          return { name: error.name, code: error.code, fxmCode: error.fxmCode, message: error.message }
        }
      },
      async album(input, ctx) {
        await ctx.fetch('https://api.example.org/x')
      },
    })`)
    const message = call('track', { id: 't1' })
    await send(message)
    const failure = {
      id: 1,
      ok: false,
      error: { code: 'host-not-declared', fxmCode: 'Unavailable', message: 'Not declared' },
    }
    expect(
      await send({ op: 'resume', call: message.call, responses: [failure], stepMs: 2_000 }),
    ).toEqual({
      state: 'done',
      value: {
        name: 'FxmPluginError',
        code: 'host-not-declared',
        fxmCode: 'Unavailable',
        message: 'Not declared',
      },
    })
    const unhandled = call('album', { id: 'al1' })
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
      async track(input, ctx) {
        const response = await ctx.fetch('https://api.example.org/empty')
        return [response.status, await response.text(), response.ok]
      },
    })`)
    const message = call('track', { id: 't1' })
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
    expect(await send(call('track'))).toEqual({
      state: 'failed',
      error: {
        code: 'plugin-failed',
        message: 'FxmPluginError: No such track',
        fxmCode: 'NotFound',
        retryAfterMs: 10,
      },
    })
    expect(await send(call('album'))).toEqual({
      state: 'failed',
      error: { code: 'plugin-failed', message: 'TypeError: bad thing' },
    })
    expect(await send(call('artist'))).toEqual({
      state: 'failed',
      error: { code: 'plugin-failed', message: 'just a string' },
    })
  })

  it('fails every call of a plugin that does not load', async () => {
    for (const code of [
      'fxm.register({ async search( {',
      `throw new Error('broken at load')`,
      `const nothing = 1`,
      `fxm.register({}); fxm.register({})`,
      `fxm.register(42)`,
    ]) {
      const send = plugin(code)
      const reply = await send(call('search'))
      expect(reply).toMatchObject({ state: 'failed', error: { code: 'load-failed' } })
      expect(await send(call('search'))).toEqual(reply)
    }
  })

  it('answers a call even when the plugin’s handlers throw as they are read', async () => {
    const send = plugin(
      `fxm.register(new Proxy({}, { get() { throw new Error('no handlers here') } }))`,
    )
    expect(await send(call('track'))).toEqual({
      state: 'failed',
      error: { code: 'plugin-failed', message: 'Error: no handlers here' },
    })
  })

  it('says so when the plugin has no handler for an operation', async () => {
    const send = plugin(`fxm.register({ async search() { return {} } })`)
    expect(await send(call('resolve'))).toEqual({
      state: 'failed',
      error: { code: 'not-implemented', message: 'The plugin has no handler for resolve' },
    })
  })

  it('answers results that are not JSON as such, undefined as null, and too much as too large', async () => {
    const send = plugin(
      `fxm.register({
        async track() { return 10n },
        async album() { const loop = {}; loop.loop = loop; return loop },
        async artist() { return undefined },
        async playlist() { return () => 1 },
        async search() { return 'x'.repeat(2000) },
      })`,
      1_000,
    )
    expect(await send(call('track'))).toMatchObject({
      state: 'failed',
      error: { code: 'not-json' },
    })
    expect(await send(call('album'))).toMatchObject({
      state: 'failed',
      error: { code: 'not-json' },
    })
    expect(await send(call('artist'))).toEqual({ state: 'done', value: null })
    expect(await send(call('playlist'))).toEqual({ state: 'done', value: null })
    expect(await send(call('search'))).toMatchObject({
      state: 'failed',
      error: { code: 'too-large' },
    })
  })

  it('answers idle while a handler waits for something else, and goes on when resumed', async () => {
    const send = plugin(`fxm.register({
      async track() {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return 'late'
      },
    })`)
    const message = call('track', {}, { stepMs: 10 })
    expect(await send(message)).toEqual({ state: 'idle' })
    let reply = await send({ op: 'resume', call: message.call, responses: [], stepMs: 10 })
    while (typeof reply === 'object' && reply.state === 'idle') {
      reply = await send({ op: 'resume', call: message.call, responses: [], stepMs: 10 })
    }
    expect(reply).toEqual({ state: 'done', value: 'late' })
  })

  it('cancels a call: its signal aborts, its requests fail and the call is gone', async () => {
    const send = plugin(`let seen
    fxm.register({
      async track(input, ctx) {
        seen = { signal: ctx.signal }
        try {
          await ctx.fetch('https://api.example.org/slow')
        } catch (error) {
          seen.cancelled = error.message
        }
        return 'unused'
      },
      async album() {
        return { aborted: seen.signal.aborted, cancelled: seen.cancelled }
      },
    })`)
    const message = call('track')
    expect(await send(message)).toMatchObject({ state: 'fetch' })
    expect(await send({ op: 'cancel', call: message.call })).toEqual({ state: 'cancelled' })
    expect(await send({ op: 'resume', call: message.call, responses: [], stepMs: 10 })).toEqual({
      state: 'failed',
      error: { code: 'unknown-call', message: 'The call is gone' },
    })
    expect(await send(call('album'))).toEqual({
      state: 'done',
      value: { aborted: true, cancelled: 'The call was cancelled' },
    })
  })

  it('refuses malformed messages, and more than 32 calls at once', async () => {
    const send = plugin(
      `fxm.register({ async track(input, ctx) { await ctx.fetch('https://api.example.org/x') } })`,
    )
    expect(await send({ op: 'dance' })).toMatchObject({
      state: 'failed',
      error: { code: 'bad-request' },
    })
    expect(await send({ op: 'call', method: 'track' })).toMatchObject({
      state: 'failed',
      error: { code: 'bad-request' },
    })
    expect(await send({ fxmPlugin: 2 })).toMatchObject({
      state: 'failed',
      error: { code: 'bad-request' },
    })
    for (let index = 0; index < 32; index += 1) {
      expect(await send(call('track'))).toMatchObject({ state: 'fetch' })
    }
    expect(await send(call('track'))).toEqual({
      state: 'failed',
      error: { code: 'busy', message: 'Too many calls at once' },
    })
  })

  it('refuses request bodies that are not text', async () => {
    const send = plugin(`fxm.register({
      async track(input, ctx) {
        try { await ctx.fetch('https://api.example.org/x', { method: 'POST', body: new Uint8Array(1) }) }
        catch (error) { return error.message }
      },
    })`)
    expect(await send(call('track'))).toEqual({
      state: 'done',
      value: 'ctx.fetch sends text bodies only',
    })
  })
})
