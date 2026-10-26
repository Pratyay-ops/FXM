import { createRequestBudget, EvaluatorError, type RequestBudget } from '@fxm/platform'
import { createInProcessEvaluator, type InProcessEvaluator } from '@fxm/platform/testing'
import { describe, expect, it } from 'vitest'
import { createFetchBroker } from './broker'
import { isPluginError } from './errors'
import { createPluginRunner, type RunnerLimits } from './host'
import { type PluginManifest, parseManifest } from './manifest'
import { isolatedSandboxes, type PluginEvaluator } from './sandboxes'
import {
  fakeCatalogFetch,
  TEST_CATALOG_HOST,
  TEST_PLUGIN_CODE,
  testContext,
  testPluginManifest,
} from './testing'

let versions = 0

/** A runner for `code` (the test plugin by default), with a fresh version so documents never share state. */
function setup(
  options: {
    code?: string
    manifest?: Record<string, unknown>
    limits?: Partial<RunnerLimits>
    budget?: RequestBudget
  } = {},
) {
  versions += 1
  const code = options.code ?? TEST_PLUGIN_CODE
  const manifest: PluginManifest = parseManifest(
    testPluginManifest({ version: `1.0.${versions}`, ...options.manifest }, code),
  )
  const evaluators: InProcessEvaluator[] = []
  const sandboxes = isolatedSandboxes(() => {
    const evaluator = createInProcessEvaluator()
    evaluators.push(evaluator)
    return evaluator
  })
  const budget =
    options.budget ??
    createRequestBudget({
      hourlyLimit: manifest.requestsPerHour,
      reserves: { 'current-track': 0, prefetch: 0, interactive: 0, bulk: 0 },
    })
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

describe('the plugin host', () => {
  it('runs an operation in the evaluator and carries its requests through ctx.fetch', async () => {
    const { runner, fetch, ctx, evaluators } = setup()
    const value = await runner.run('track', ['t1'], ctx)
    expect(value).toMatchObject({ id: 't1', title: 'Lantern Weather' })
    expect(fetch.requests).toEqual([
      {
        url: `https://${TEST_CATALOG_HOST}/tracks/t1`,
        method: 'GET',
        headers: { accept: 'application/json' },
      },
    ])
    // The code is compiled once in the document, then only invoked.
    expect(methods(evaluators[0])).toEqual(['define', 'invoke', 'invoke'])
    await runner.run('track', ['t2'], ctx)
    expect(methods(evaluators[0])).toEqual(['define', 'invoke', 'invoke', 'invoke', 'invoke'])
    expect(evaluators).toHaveLength(1)
  })

  it('sends the requests a handler makes together at once', async () => {
    const { runner, fetch, ctx } = setup()
    const value = await runner.run('resolve', [{ id: 't1', title: 'x', artists: [] }], ctx)
    expect(value).toEqual([
      expect.objectContaining({ codec: 'mp3' }),
      expect.objectContaining({ codec: 'flac' }),
    ])
    expect(fetch.requests.map((request) => request.url)).toEqual([
      `https://${TEST_CATALOG_HOST}/streams/t1?format=mp3`,
      `https://${TEST_CATALOG_HOST}/streams/t1?format=flac`,
    ])
  })

  it('refuses requests to hosts the manifest does not declare, before they are sent', async () => {
    const code = `fxm.register({ async track(id, ctx) {
      const response = await ctx.fetch('https://tracker.example.com/beacon?id=' + id)
      return response.status
    } })`
    const { runner, fetch, ctx } = setup({ code, manifest: { provides: ['search', 'track'] } })
    const error = await runner.run('track', ['t1'], ctx).catch((caught: unknown) => caught)
    expect(isPluginError(error, 'plugin-failed')).toBe(true)
    expect(error).toMatchObject({ code: 'Unsupported' })
    expect((error as Error).message).toMatch(/may not contact tracker\.example\.com/u)
    expect(fetch.requests).toEqual([])
  })

  it('fails with RateLimited once the plugin used up its requests of the hour', async () => {
    const { runner, ctx, fetch } = setup({ manifest: { requestsPerHour: 1 } })
    await runner.run('track', ['t1'], ctx)
    const error = await runner.run('track', ['t2'], ctx).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'RateLimited', pluginCode: 'plugin-failed' })
    expect(fetch.requests).toHaveLength(1)
  })

  it('stops an operation that makes too many requests, and drops it in the document', async () => {
    const { runner, ctx, evaluators } = setup({ limits: { requests: 1 } })
    const error = await runner
      .run('resolve', [{ id: 't1', title: 'x', artists: [] }], ctx)
      .catch((caught: unknown) => caught)
    expect(isPluginError(error, 'too-many-requests')).toBe(true)
    expect(error).toMatchObject({ code: 'RateLimited' })
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
    const error = await runner.run('track', ['t1'], ctx).catch((caught: unknown) => caught)
    expect(isPluginError(error, 'timeout')).toBe(true)
    expect(error).toMatchObject({ code: 'Network' })
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
    const running = runner.run('track', ['t1'], { ...ctx, signal: controller.signal })
    const reason = new Error('the user typed on')
    setTimeout(() => controller.abort(reason), 30)
    await expect(running).rejects.toBe(reason)
    await expect(runner.run('track', ['t1'], { ...ctx, signal: controller.signal })).rejects.toBe(
      reason,
    )
  })

  it('reports code that does not compile or fails as it loads as load-failed', async () => {
    for (const code of ['fxm.register({ async search( {', "throw new Error('no')"]) {
      const { runner, ctx } = setup({ code })
      const error = await runner.run('track', ['t1'], ctx).catch((caught: unknown) => caught)
      expect(isPluginError(error, 'load-failed')).toBe(true)
      expect(error).toMatchObject({ code: 'Parse' })
    }
  })

  it('passes on the FxmError code a plugin fails with, except a bot check', async () => {
    const code = `fxm.register({
      async track() { fxm.fail('NotFound', 'gone') },
      async album() { fxm.fail('BotCheck', 'a captcha') },
      async artist() { fxm.fail('Whatever', 'odd') },
    })`
    const { runner, ctx } = setup({
      code,
      manifest: { provides: ['search', 'track', 'album', 'artist'] },
    })
    await expect(runner.run('track', ['x'], ctx)).rejects.toMatchObject({
      code: 'NotFound',
      pluginCode: 'plugin-failed',
      message: 'Test Catalog failed: FxmPluginError: gone',
    })
    await expect(runner.run('album', ['x'], ctx)).rejects.toMatchObject({ code: 'Unavailable' })
    await expect(runner.run('artist', ['x'], ctx)).rejects.toMatchObject({ code: 'Unavailable' })
  })

  it('refuses operations the manifest does not provide, and everything once disposed', async () => {
    const { runner, ctx, evaluators } = setup({ manifest: { provides: ['search'] } })
    await expect(runner.run('resolve', [{}], ctx)).rejects.toMatchObject({
      pluginCode: 'not-implemented',
      code: 'Unsupported',
    })
    runner.dispose()
    await expect(runner.run('search', ['x', {}], ctx)).rejects.toMatchObject({
      pluginCode: 'disabled',
    })
    expect(evaluators).toHaveLength(0)
  })

  it('says so when a declared operation has no handler, or returns something that isn’t data', async () => {
    const code = `fxm.register({ async search() { return {} }, async track() { return 10n } })`
    const { runner, ctx } = setup({ code, manifest: { provides: ['search', 'track', 'album'] } })
    await expect(runner.run('album', ['x'], ctx)).rejects.toMatchObject({
      pluginCode: 'not-implemented',
      message: 'Test Catalog: The plugin has no handler for album',
    })
    await expect(runner.run('track', ['x'], ctx)).rejects.toMatchObject({
      pluginCode: 'bad-result',
    })
  })

  it('reports a document that can’t start or answers outside the protocol', async () => {
    const manifest = parseManifest(testPluginManifest({ version: '9.9.9' }))
    const budget = createRequestBudget({
      hourlyLimit: 10,
      reserves: { 'current-track': 0, prefetch: 0, interactive: 0, bulk: 0 },
    })
    const runnerWith = (evaluate: PluginEvaluator['evaluate']) =>
      createPluginRunner({
        manifest,
        code: TEST_PLUGIN_CODE,
        sandboxes: isolatedSandboxes(() => ({ evaluate, dispose() {} })),
        broker: createFetchBroker({ plugin: manifest, budget }),
      })
    const ctx = testContext(fakeCatalogFetch())
    const down = runnerWith(() => Promise.reject(new EvaluatorError('unavailable', 'no document')))
    await expect(down.run('track', ['t1'], ctx)).rejects.toMatchObject({
      pluginCode: 'unavailable',
      code: 'Unsupported',
    })
    const hung = runnerWith(() => Promise.reject(new EvaluatorError('timeout', 'no answer')))
    await expect(hung.run('track', ['t1'], ctx)).rejects.toMatchObject({ pluginCode: 'timeout' })
    const garbled = runnerWith(async () => ({ hello: 'world' }))
    await expect(garbled.run('track', ['t1'], ctx)).rejects.toMatchObject({
      pluginCode: 'bad-reply',
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
      Array.from({ length: 5 }, (_, index) => runner.run('track', [`t${index}`], ctx)),
    )
    expect(Math.max(...(results as number[]))).toBe(2)
  })
})
