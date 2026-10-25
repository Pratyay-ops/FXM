import { describe, expect, it } from 'vitest'
import { createFakeClock } from '../testing/fake-clock'
import { createCapacitorEvaluator } from './capacitor'
import { startEvaluatorDocument } from './document'
import { createMailboxPort, HELLO_SCRIPT, receiveScript, takeScript } from './mailbox'
import { EVALUATOR_CHANNEL } from './protocol'
import { createTauriEvaluator } from './tauri'

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
      version: 1,
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
