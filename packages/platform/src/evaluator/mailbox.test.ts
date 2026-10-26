import { describe, expect, it } from 'vitest'
import { createFakeClock } from '../testing/fake-clock'
import { createCapacitorEvaluator } from './capacitor'
import { startEvaluatorDocument } from './document'
import { createEvaluator } from './evaluator'
import { createMailboxPort, HELLO_SCRIPT, receiveScript, takeScript } from './mailbox'
import { EVALUATOR_CHANNEL, EVALUATOR_PROTOCOL_VERSION } from './protocol'
import { createTauriEvaluator } from './tauri'

const YOUTUBE = 'https://www.youtube.com'

/** What a runner answers for the mailbox's hello at `origin`. */
const helloText = (origin = YOUTUBE) =>
  JSON.stringify(
    JSON.stringify({
      channel: EVALUATOR_CHANNEL,
      type: 'ready',
      version: EVALUATOR_PROTOCOL_VERSION,
      origin,
    }),
  )

/** A runner for a document that takes every request and never answers, recording each read. */
function silentDocument(options: { ready?: () => boolean } = {}) {
  const scripts: string[] = []
  return {
    scripts,
    reads: () => scripts.length,
    async run(script: string): Promise<string> {
      scripts.push(script)
      if (script === HELLO_SCRIPT) return options.ready?.() === false ? 'null' : helloText()
      return script.includes('.receive(') ? '"accepted"' : 'null'
    },
  }
}

/**
 * A native webview stand-in: a top-level window running the real evaluator document, and a
 * script runner that evaluates a script against it and answers the value as JSON text, as
 * Tauri's `eval_with_callback` and Android's `evaluateJavascript` do.
 */
function fakeWebview(href = 'fxm-eval://localhost/eval.html') {
  let window: Record<string, unknown> | undefined
  const scripts: string[] = []
  return {
    scripts,
    start() {
      const top: Record<string, unknown> & { parent?: unknown } = {
        location: { href },
        addEventListener() {},
      }
      top.parent = top
      startEvaluatorDocument(top as never)
      window = top
    },
    stop() {
      window = undefined
    },
    async run(script: string): Promise<string> {
      scripts.push(script)
      const value: unknown =
        window === undefined ? null : new Function('window', `return ${script}`)(window)
      return JSON.stringify(value ?? null)
    },
  }
}

describe('the mailbox port', () => {
  it('builds scripts that never throw, whatever the page holds', () => {
    const run = (script: string, window: unknown) =>
      new Function('window', `return ${script}`)(window)
    expect(run(HELLO_SCRIPT, {})).toBeNull()
    expect(
      run(takeScript(3), {
        __fxmEvaluator: {
          take: () => {
            throw new Error('x')
          },
        },
      }),
    ).toBeNull()
    const request = {
      channel: EVALUATOR_CHANNEL,
      id: 1,
      method: 'evaluate',
      params: { source: 'return "\\u2028"', args: null },
    } as const
    expect(run(receiveScript(request), {})).toBeNull()
  })

  it('waits for the document, hands over requests and collects their answers', async () => {
    const webview = fakeWebview()
    let started = false
    const port = createMailboxPort({
      run: async (script) => (started ? webview.run(script) : 'null'),
      start: async () => {
        webview.start()
        started = true
      },
      pollMs: 1,
    })
    expect(await port.open()).toMatchObject({ type: 'ready', origin: 'fxm-eval://localhost' })
    const request = {
      channel: EVALUATOR_CHANNEL,
      id: 9,
      method: 'evaluate',
      params: { source: 'return Promise.resolve(args + "!")', args: 'hi' },
    } as const
    expect(await port.send(request)).toEqual({
      channel: EVALUATOR_CHANNEL,
      id: 9,
      ok: true,
      result: 'hi!',
    })
  })

  it('backs off between reads and stops polling once closed', async () => {
    const clock = createFakeClock()
    const port = createMailboxPort({ run: async () => 'null', clock, pollMs: 10, maxPollMs: 40 })
    const opened = port.open().catch((error: unknown) => error)
    await clock.advanceAsync(10 + 20 + 40 + 40)
    port.close()
    await clock.advanceAsync(40)
    expect(await opened).toMatchObject({ evaluatorCode: 'closed' })
  })

  it('stops reading the mailbox once the evaluator stops waiting for an answer', async () => {
    const clock = createFakeClock()
    const document = silentDocument()
    const port = createMailboxPort({ run: document.run, clock, pollMs: 10, maxPollMs: 40 })
    const controller = new AbortController()
    const request = {
      channel: EVALUATOR_CHANNEL,
      id: 7,
      method: 'evaluate',
      params: { source: 'return 1', args: null },
    } as const
    const answer = port.send(request, controller.signal).catch((error: unknown) => error)
    await clock.advanceAsync(100)
    const reads = document.reads()
    expect(reads).toBeGreaterThan(2)
    controller.abort(new Error('timed out'))
    expect(await answer).toMatchObject({ message: 'timed out' })
    await clock.advanceAsync(10_000)
    expect(document.reads()).toBe(reads)
  })

  it('reads nothing more after a call times out, and the next call starts a new document', async () => {
    const clock = createFakeClock()
    const document = silentDocument()
    let starts = 0
    let stops = 0
    const port = createMailboxPort({
      run: document.run,
      start: async () => {
        starts += 1
      },
      stop: () => {
        stops += 1
      },
      clock,
      pollMs: 10,
      maxPollMs: 40,
    })
    const evaluator = createEvaluator('android', port, { clock, timeoutMs: 500, origin: YOUTUBE })
    await evaluator.ready()
    const call = evaluator.evaluate('await new Promise(() => {})').catch((error: unknown) => error)
    await clock.advanceAsync(500)
    expect(await call).toMatchObject({ code: 'Network', evaluatorCode: 'timeout' })
    expect(stops).toBe(1)
    const reads = document.reads()
    await clock.advanceAsync(10_000)
    expect(document.reads()).toBe(reads)
    await evaluator.ready()
    expect(starts).toBe(2)
  })

  it('stops reading the hello after a failed start, and starts a new document on retry', async () => {
    const clock = createFakeClock()
    let ready = false
    const document = silentDocument({ ready: () => ready })
    let starts = 0
    let stops = 0
    const port = createMailboxPort({
      run: document.run,
      start: async () => {
        starts += 1
      },
      stop: () => {
        stops += 1
      },
      clock,
      pollMs: 10,
      maxPollMs: 40,
    })
    const evaluator = createEvaluator('android', port, {
      clock,
      openTimeoutMs: 1_000,
      origin: YOUTUBE,
    })
    const first = evaluator.ready().catch((error: unknown) => error)
    await clock.advanceAsync(1_000)
    expect(await first).toMatchObject({ code: 'Unsupported', evaluatorCode: 'unavailable' })
    expect(stops).toBe(1)
    const reads = document.reads()
    await clock.advanceAsync(10_000)
    expect(document.reads()).toBe(reads)
    ready = true
    const second = evaluator.ready()
    await clock.advanceAsync(10)
    expect(await second).toMatchObject({ origin: YOUTUBE })
    expect(starts).toBe(2)
  })

  it('reports a document that does not take a request', async () => {
    const port = createMailboxPort({
      run: async (script) => (script === HELLO_SCRIPT ? '"{}"' : '"refused"'),
    })
    const request = {
      channel: EVALUATOR_CHANNEL,
      id: 1,
      method: 'evaluate',
      params: { source: 'x', args: null },
    } as const
    await expect(port.send(request)).rejects.toMatchObject({ evaluatorCode: 'unavailable' })
  })
})

describe('the desktop evaluator', () => {
  it('drives the hidden webview through the plugin commands', async () => {
    const webview = fakeWebview()
    const calls: string[] = []
    const evaluator = createTauriEvaluator({
      pollMs: 1,
      async invoke(command, args) {
        calls.push(command)
        if (command === 'plugin:fxm-evaluator|open') return webview.start()
        if (command === 'plugin:fxm-evaluator|close') return webview.stop()
        if (command === 'plugin:fxm-evaluator|eval') return webview.run(String(args?.script))
        throw new Error(`unexpected ${command}`)
      },
    })
    expect(await evaluator.ready()).toEqual({
      kind: 'desktop',
      version: 2,
      origin: 'fxm-eval://localhost',
    })
    expect(await evaluator.evaluate('return args.length', [1, 2, 3])).toBe(3)
    evaluator.dispose()
    expect(calls[0]).toBe('plugin:fxm-evaluator|open')
    expect(calls.at(-1)).toBe('plugin:fxm-evaluator|close')
    expect(calls.filter((call) => call === 'plugin:fxm-evaluator|eval').length).toBeGreaterThan(1)
  })
})

describe('the Android evaluator', () => {
  it('loads the document through the plugin and evaluates in it', async () => {
    const webview = fakeWebview('https://www.youtube.com/')
    const opened: string[] = []
    const evaluator = createCapacitorEvaluator({
      html: '<!doctype html><title>eval</title>',
      pollMs: 1,
      plugin: {
        async open({ html }) {
          opened.push(html)
          webview.start()
        },
        async eval({ script }) {
          return { result: await webview.run(script) }
        },
        async close() {
          webview.stop()
        },
      },
    })
    expect(await evaluator.evaluate('return "ok"')).toBe('ok')
    expect((await evaluator.ready()).origin).toBe('https://www.youtube.com')
    expect(opened).toEqual(['<!doctype html><title>eval</title>'])
  })
})
