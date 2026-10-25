import { describe, expect, it, vi } from 'vitest'
import { startEvaluatorDocument } from './document'
import { createSandboxEvaluator, EVALUATOR_DOCUMENT_PATH } from './web'

const FXM = 'https://fxm-music.pages.dev'

/**
 * A page that frames the evaluator: a fake iframe whose "document" is the real evaluator
 * document, started on a fake frame window when its `src` is set. Messages cross with a
 * structured clone, a real macrotask apart, and the frame's messages carry `frameOrigin`
 * (`'null'` for a sandboxed frame).
 */
function fakePage(options: { frameOrigin?: string } = {}) {
  const frameOrigin = options.frameOrigin ?? 'null'
  const hostListeners = new Set<(event: MessageEvent) => void>()
  const frameListeners: Array<(event: MessageEvent) => void> = []
  const attributes = new Map<string, string>()
  const deliver = (listeners: Iterable<(event: MessageEvent) => void>, event: object) =>
    setTimeout(() => {
      for (const listener of [...listeners]) listener(event as MessageEvent)
    }, 0)
  const contentWindow = {
    postMessage(message: unknown) {
      deliver(frameListeners, { data: structuredClone(message), origin: FXM, source: parent })
    },
  }
  const parent = {
    postMessage(message: unknown, targetOrigin: string) {
      if (targetOrigin !== FXM) return
      deliver(hostListeners, {
        data: structuredClone(message),
        origin: frameOrigin,
        source: contentWindow,
      })
    },
  }
  let src: string | undefined
  const iframe = {
    hidden: false,
    style: { display: '' },
    contentWindow,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    remove: vi.fn(),
    get src() {
      return src ?? ''
    },
    set src(url: string) {
      src = url
      startEvaluatorDocument({
        parent,
        location: { href: url },
        addEventListener: (_type, listener) => frameListeners.push(listener),
      })
    },
  }
  const append = vi.fn()
  const window = {
    location: { origin: FXM },
    document: { createElement: () => iframe, body: { append } } as unknown as Document,
    addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
      hostListeners.add(listener),
    removeEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
      hostListeners.delete(listener),
  }
  return { window, iframe, attributes, append, hostListeners }
}

describe('the web evaluator', () => {
  it('frames eval.html in a sandboxed iframe and evaluates through postMessage', async () => {
    const page = fakePage()
    const evaluator = createSandboxEvaluator({ window: page.window })
    expect(await evaluator.evaluate('return args.join("-")', ['a', 'b'])).toBe('a-b')
    expect(page.iframe.src).toBe(`${FXM}${EVALUATOR_DOCUMENT_PATH}`)
    expect(Object.fromEntries(page.attributes)).toMatchObject({
      sandbox: 'allow-scripts',
      referrerpolicy: 'no-referrer',
    })
    expect(page.iframe.hidden).toBe(true)
    expect(page.append).toHaveBeenCalledOnce()
    expect((await evaluator.ready()).origin).toBe(FXM)
  })

  it('refuses a document that answers with a real origin: it is not sandboxed', async () => {
    const page = fakePage({ frameOrigin: FXM })
    const evaluator = createSandboxEvaluator({ window: page.window })
    await expect(evaluator.evaluate('return 1')).rejects.toMatchObject({
      code: 'Unsupported',
      evaluatorCode: 'unavailable',
      message: expect.stringContaining('not sandboxed'),
    })
    expect(page.iframe.remove).toHaveBeenCalled()
    expect(page.hostListeners.size).toBe(0)
  })

  it('removes the iframe and its listener when disposed', async () => {
    const page = fakePage()
    const evaluator = createSandboxEvaluator({ window: page.window, url: `${FXM}/custom.html` })
    await evaluator.ready()
    expect(page.iframe.src).toBe(`${FXM}/custom.html`)
    evaluator.dispose()
    expect(page.iframe.remove).toHaveBeenCalled()
    expect(page.hostListeners.size).toBe(0)
  })
})
