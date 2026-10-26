import {
  createRequestBudget,
  EvaluatorError,
  type RequestBudget,
  RouteUnavailableError,
} from '@fxm/platform'
import type { InProcessEvaluator } from '@fxm/platform/testing'
import { describe, expect, it } from 'vitest'
import { createFetchBroker } from './broker'
import { isPluginError } from './errors'
import { createPluginRunner, type RunnerLimits } from './host'
import { type PluginManifest, parseManifest } from './manifest'
import { isolatedSandboxes, type PluginEvaluator } from './sandboxes'
import {
  fakeCatalogFetch,
  inProcessSandboxes,
  TEST_CATALOG_HOST,
  TEST_PLUGIN_CODE,
  testContext,
  testPluginManifest,
} from './testing'

const RESERVES = { 'current-track': 0, prefetch: 0, interactive: 0, bulk: 0 }

/** A runner for `code` (the test plugin by default), in documents of its own. */
function setup(
  options: {
    code?: string
    manifest?: Record<string, unknown>
    limits?: Partial<RunnerLimits>
    budget?: RequestBudget
  } = {},
) {
  const code = options.code ?? TEST_PLUGIN_CODE
  const manifest: PluginManifest = parseManifest(testPluginManifest(options.manifest, code))
  const evaluators: InProcessEvaluator[] = []
  const sandboxes = inProcessSandboxes((evaluator) => evaluators.push(evaluator))
  const budget =
    options.budget ??
    createRequestBudget({ hourlyLimit: manifest.requestsPerHour, reserves: RESERVES })
  const broker = createFetchBroker({ plugin: manifest, budget })
  const runner = createPluginRunner({
    manifest,
    code,
    sandboxes,
    broker,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  })
  const fetch = fakeCatalogFetch()
  return { runner, manifest, evaluators, fetch, ctx: testContext(fetch), budget }
}

/** The kinds of the evaluator requests, e.g. `define`, `invoke`. */
function methods(evaluator: InProcessEvaluator | undefined): string[] {
  return (evaluator?.requests ?? []).map((request) => request.method)
}

/** A runner over a stand-in evaluator that answers every call with `evaluate`. */
function runnerWith(evaluate: PluginEvaluator['evaluate']) {
  const manifest = parseManifest(testPluginManifest({ version: '9.9.9' }))
  return createPluginRunner({
    manifest,
    code: TEST_PLUGIN_CODE,
    sandboxes: isolatedSandboxes(() => ({ kind: 'web', evaluate, dispose() {} })),
    broker: createFetchBroker({
      plugin: manifest,
      budget: createRequestBudget({ hourlyLimit: 10, reserves: RESERVES }),
    }),
  })
}

describe('the plugin host', () => {
  it('runs an operation in the plugin’s worker and carries its requests through ctx.fetch', async () => {
    const { runner, fetch, ctx, evaluators } = setup()
    const value = await runner.run('track', { id: 't1' }, ctx)
    expect(value).toMatchObject({ id: 't1', title: 'Lantern Weather' })
    expect(fetch.requests).toEqual([
      { url: `https://${TEST_CATALOG_HOST}/tracks/t1`, method: 'GET', headers: {} },
    ])
    // The relay is compiled once in the document, then only invoked.
    expect(methods(evaluators[0])).toEqual(['define', 'invoke', 'invoke'])
    await runner.run('track', { id: 't2' }, ctx)
    expect(methods(evaluators[0])).toEqual(['define', 'invoke', 'invoke', 'invoke', 'invoke'])
    expect(evaluators).toHaveLength(1)
  })

  it('never sends the document the plugin’s code to compile, only the relay that holds it as text', async () => {
    const { runner, ctx, evaluators } = setup()
    await runner.run('track', { id: 't1' }, ctx)
    const define = evaluators[0]?.requests[0]
    const source = define?.method === 'define' ? define.params.source : ''
    // The code is inside one string literal of the relay's source, for the worker.
    expect(source).not.toContain(TEST_PLUGIN_CODE)
    expect(source).toContain(JSON.stringify(TEST_PLUGIN_CODE).slice(1, 80))
  })

  it('sends the requests a handler makes together at once', async () => {
    const { runner, fetch, ctx } = setup()
    const value = await runner.run(
      'resolve',
      { candidate: { id: 't1', title: 'x', artists: [] } },
      ctx,
    )
    expect(value).toEqual([
      expect.objectContaining({ codec: 'mp3' }),
      expect.objectContaining({ codec: 'flac' }),
    ])
    expect(fetch.requests.map((request) => request.url)).toEqual([
      `https://${TEST_CATALOG_HOST}/streams/t1?format=mp3`,
      `https://${TEST_CATALOG_HOST}/streams/t1?format=flac`,
    ])
  })

  it('refuses requests to hosts the manifest does not declare, and skips the item', async () => {
    const code = `fxm.register({ async track({ id }, ctx) {
      const response = await ctx.fetch('https://tracker.example.com/beacon?id=' + id)
      return response.status
    } })`
    const { runner, fetch, ctx } = setup({ code, manifest: { provides: ['search', 'track'] } })
    const error = await runner.run('track', { id: 't1' }, ctx).catch((caught: unknown) => caught)
    expect(isPluginError(error, 'plugin-failed')).toBe(true)
    // Unavailable: the player skips the item, it doesn't stop.
    expect(error).toMatchObject({ code: 'Unavailable' })
    expect((error as Error).message).toMatch(/may not contact tracker\.example\.com/u)
    expect(fetch.requests).toEqual([])
  })

  it('fails with RateLimited once the plugin used up its requests of the hour', async () => {
    const { runner, ctx, fetch } = setup({ manifest: { requestsPerHour: 1 } })
    await runner.run('track', { id: 't1' }, ctx)
    const error = await runner.run('track', { id: 't2' }, ctx).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'RateLimited', pluginCode: 'plugin-failed' })
    expect(fetch.requests).toHaveLength(1)
  })

  it('draws on the plugin’s budget at the operation’s priority', async () => {
    // Two requests an hour, one of which only the current track may use.
    const budget = createRequestBudget({
      hourlyLimit: 2,
      reserves: { ...RESERVES, interactive: 1 },
    })
    const { runner, ctx } = setup({ budget })
    await runner.run('track', { id: 't1' }, ctx)
    await expect(runner.run('track', { id: 't2' }, ctx)).rejects.toMatchObject({
      code: 'RateLimited',
    })
    expect(await runner.run('track', { id: 't3' }, ctx, 'current-track')).toMatchObject({
      title: 'Copper Tide',
    })
  })

  it('stops an operation that makes too many requests, and drops it in the worker', async () => {
    const { runner, ctx, evaluators } = setup({ limits: { requests: 1 } })
    const error = await runner
      .run('resolve', { candidate: { id: 't1', title: 'x', artists: [] } }, ctx)
      .catch((caught: unknown) => caught)
    expect(isPluginError(error, 'too-many-requests')).toBe(true)
    expect(error).toMatchObject({ code: 'Unavailable' })
    const last = evaluators[0]?.requests.at(-1)
    expect(last).toMatchObject({ method: 'invoke', params: { args: { op: 'cancel' } } })
  })

  it('times out an operation that takes too long', async () => {
    const code = `fxm.register({ async track() {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      return 'late'
    } })`
    const { runner, ctx } = setup({
      code,
      manifest: { provides: ['search', 'track'] },
      limits: { stepMs: 10, callMs: 50 },
    })
    const error = await runner.run('track', { id: 't1' }, ctx).catch((caught: unknown) => caught)
    expect(isPluginError(error, 'timeout')).toBe(true)
    expect(error).toMatchObject({ code: 'Network' })
  })

  it('reports a plugin that stops answering as a timeout', async () => {
    const code = 'fxm.register({ async track() { close() } })'
    const { runner, ctx } = setup({
      code,
      manifest: { provides: ['search', 'track'] },
      limits: { stepMs: 10, evaluateMs: 3_000 },
    })
    const error = await runner.run('track', { id: 't1' }, ctx).catch((caught: unknown) => caught)
    expect(isPluginError(error, 'timeout')).toBe(true)
    expect((error as Error).message).toMatch(/stopped answering/u)
  })

  it('rejects with the reason when the caller cancels', async () => {
    const code = `fxm.register({ async track() {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    } })`
    const { runner, ctx } = setup({
      code,
      manifest: { provides: ['search', 'track'] },
      limits: { stepMs: 10 },
    })
    const controller = new AbortController()
    const running = runner.run('track', { id: 't1' }, { ...ctx, signal: controller.signal })
    const reason = new Error('the user typed on')
    setTimeout(() => controller.abort(reason), 30)
    await expect(running).rejects.toBe(reason)
    await expect(
      runner.run('track', { id: 't1' }, { ...ctx, signal: controller.signal }),
    ).rejects.toBe(reason)
  })

  it('reports code that does not compile or fails as it loads as load-failed', async () => {
    for (const code of ['fxm.register({ async search( {', "throw new Error('no')"]) {
      const { runner, ctx } = setup({ code })
      const error = await runner.run('track', { id: 't1' }, ctx).catch((caught: unknown) => caught)
      expect(isPluginError(error, 'load-failed')).toBe(true)
      expect(error).toMatchObject({ code: 'Unavailable' })
    }
  })

  it('passes on only the FxmError codes a plugin may fail with', async () => {
    const code = `fxm.register({
      async track() { fxm.fail('NotFound', 'gone') },
      async album() { fxm.fail('BotCheck', 'a captcha') },
      async artist() { fxm.fail('AuthRequired', 'log in') },
      async playlist() { fxm.fail('Unsupported', 'not here') },
      async search() { fxm.fail('RateLimited', 'later', { retryAfterMs: 1e12 }) },
      async suggest() { fxm.fail('Whatever', 'odd') },
    })`
    const { runner, ctx } = setup({
      code,
      manifest: { provides: ['search', 'suggest', 'track', 'album', 'artist', 'playlist'] },
    })
    await expect(runner.run('track', { id: 'x' }, ctx)).rejects.toMatchObject({
      code: 'NotFound',
      pluginCode: 'plugin-failed',
      message: 'Test Catalog failed: FxmPluginError: gone',
    })
    // Those would stop the player: a plugin can't claim them.
    for (const operation of ['album', 'artist', 'playlist', 'suggest'] as const) {
      await expect(runner.run(operation, { id: 'x' }, ctx)).rejects.toMatchObject({
        code: 'Unavailable',
      })
    }
    await expect(runner.run('search', { query: 'x' }, ctx)).rejects.toMatchObject({
      code: 'RateLimited',
      retryAfterMs: 60 * 60_000,
    })
  })

  it('reports a route the platform closed as unreachable, which the plugin can’t claim itself', async () => {
    const code = `fxm.register({ async track({ id }, ctx) {
      return (await ctx.fetch('https://${TEST_CATALOG_HOST}/tracks/' + id)).json()
    } })`
    const { runner } = setup({ code, manifest: { provides: ['search', 'track'] } })
    const closed = new RouteUnavailableError('user', ['sandbox'], 'Reaching it needs the sandbox')
    const ctx = testContext(async () => {
      throw closed
    })
    const error = await runner.run('track', { id: 't1' }, ctx).catch((caught: unknown) => caught)
    expect(isPluginError(error, 'unreachable')).toBe(true)
    expect(error).toMatchObject({ code: 'Unsupported', cause: closed })
  })

  it('refuses operations the manifest does not provide, and everything once disposed', async () => {
    const { runner, ctx, evaluators } = setup({ manifest: { provides: ['search'] } })
    await expect(runner.run('resolve', {}, ctx)).rejects.toMatchObject({
      pluginCode: 'not-implemented',
      code: 'Unavailable',
    })
    runner.dispose()
    await expect(runner.run('search', { query: 'x' }, ctx)).rejects.toMatchObject({
      pluginCode: 'disabled',
      code: 'Unavailable',
    })
    expect(evaluators).toHaveLength(0)
  })

  it('says so when a declared operation has no handler, or returns something that isn’t data', async () => {
    const code = `fxm.register({ async search() { return {} }, async track() { return 10n } })`
    const { runner, ctx } = setup({ code, manifest: { provides: ['search', 'track', 'album'] } })
    await expect(runner.run('album', { id: 'x' }, ctx)).rejects.toMatchObject({
      pluginCode: 'not-implemented',
      message: 'Test Catalog: The plugin has no handler for album',
    })
    await expect(runner.run('track', { id: 'x' }, ctx)).rejects.toMatchObject({
      pluginCode: 'bad-result',
    })
  })

  it('reports a document that can’t start, answers outside the protocol or answers too much', async () => {
    const ctx = testContext(fakeCatalogFetch())
    const down = runnerWith(() => Promise.reject(new EvaluatorError('unavailable', 'no document')))
    await expect(down.run('track', { id: 't1' }, ctx)).rejects.toMatchObject({
      pluginCode: 'unavailable',
      code: 'Unsupported',
    })
    const hung = runnerWith(() => Promise.reject(new EvaluatorError('timeout', 'no answer')))
    await expect(hung.run('track', { id: 't1' }, ctx)).rejects.toMatchObject({
      pluginCode: 'timeout',
    })
    const closed = runnerWith(() => Promise.reject(new EvaluatorError('closed', 'replaced')))
    await expect(closed.run('track', { id: 't1' }, ctx)).rejects.toMatchObject({
      pluginCode: 'plugin-failed',
      code: 'Unavailable',
    })
    for (const garbage of [{ hello: 'world' }, 'not json', '{"fxmPluginReply":1}']) {
      const garbled = runnerWith(async () => garbage)
      await expect(garbled.run('track', { id: 't1' }, ctx)).rejects.toMatchObject({
        pluginCode: 'bad-reply',
      })
    }
    // Refused before it is parsed: the page never holds a result that large.
    const huge = `{"fxmPluginReply":1,"state":"done","value":"${'x'.repeat(4 * 1024 * 1024)}"}`
    const flooding = runnerWith(async () => huge)
    await expect(flooding.run('track', { id: 't1' }, ctx)).rejects.toMatchObject({
      pluginCode: 'bad-result',
    })
  })

  it('runs at most `concurrency` operations of a plugin at once', async () => {
    const code = `let running = 0, most = 0
    fxm.register({
      async track() {
        running += 1
        most = Math.max(most, running)
        await new Promise((resolve) => setTimeout(resolve, 20))
        running -= 1
        return most
      },
    })`
    const { runner, ctx } = setup({
      code,
      manifest: { provides: ['search', 'track'] },
      limits: { concurrency: 2 },
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => runner.run('track', { id: `t${index}` }, ctx)),
    )
    expect(Math.max(...(results as number[]))).toBe(2)
  })
})
