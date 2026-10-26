import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeClock } from '../testing/fake-clock'
import { startEvaluatorDocument } from './document'
import { EVALUATOR_CHANNEL } from './protocol'
import { createSandboxEvaluator, EVALUATOR_DOCUMENT_PATH } from './web'

const FXM = 'https://fxmusic.pages.dev'

/** Waits for the fake page's messages and loads, which travel a real macrotask apart. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** Every channel the documents opened, closed after each test so none keeps Node running. */
const ports: MessagePort[] = []

afterEach(() => {
  for (const port of ports.splice(0)) port.close()
})

/** What a fake frame's next document does. */
interface FakeDocumentPlan {
  /** Rewrites the URL the document sees, e.g. to drop the nonce or move it elsewhere. */
  url?: (src: string) => string
  /** Never starts: no hello. */
  silent?: boolean
}

/**
 * One iframe of the fake page. Setting `src` starts the real evaluator document on a fake frame
 * window, then fires `load`, as a browser would. The document's messages to its parent reach the
 * page a real macrotask later, with `origin` (`'null'` for a sandboxed frame) and its ports.
 */
class FakeFrame {
  readonly attributes = new Map<string, string>()
  readonly style = { display: '' }
  readonly contentWindow = { postMessage: vi.fn() }
  hidden = false
  removed = false
  #src = ''
  readonly #loads = new Set<() => void>()

  constructor(
    readonly page: FakePage,
    readonly plan: FakeDocumentPlan,
  ) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'load') this.#loads.add(listener)
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'load') this.#loads.delete(listener)
  }

  remove(): void {
    this.removed = true
  }

  get src(): string {
    return this.#src
  }

  set src(url: string) {
    this.#src = url
    setTimeout(() => {
      if (!this.plan.silent) {
        startEvaluatorDocument({
          parent: this.#parent(),
          location: { href: this.plan.url?.(url) ?? url },
        })
      }
      setTimeout(() => this.#fireLoad(), 0)
    }, 0)
  }

  /**
   * Another document replaces the evaluator in this frame (a navigation by a script in it, or by
   * an ancestor page): it loads, and runs `forge` with a way to post to the page as the frame.
   */
  navigate(forge?: (post: (message: unknown, transfer?: MessagePort[]) => void) => void): void {
    setTimeout(() => {
      forge?.((message, transfer = []) => this.page.deliver(this, message, transfer))
      this.#fireLoad()
    }, 0)
  }

  #fireLoad(): void {
    for (const listener of [...this.#loads]) listener()
  }

  #parent() {
    return {
      postMessage: (message: unknown, targetOrigin: string, transfer: MessagePort[] = []) => {
        ports.push(...transfer)
        if (targetOrigin === FXM) this.page.deliver(this, message, transfer)
      },
    }
  }
}

/** A page at the FXM origin that frames the evaluator. */
class FakePage {
  readonly listeners = new Set<(event: MessageEvent) => void>()
  readonly frames: FakeFrame[] = []
  readonly append = vi.fn()
  readonly plans: FakeDocumentPlan[]

  constructor(
    readonly frameOrigin = 'null',
    plans: FakeDocumentPlan[] = [],
  ) {
    this.plans = [...plans]
  }

  readonly window = {
    location: { origin: FXM },
    document: {
      createElement: () => {
        const frame = new FakeFrame(this, this.plans.shift() ?? {})
        this.frames.push(frame)
        return frame
      },
      body: { append: this.append },
    } as unknown as Document,
    addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) => {
      this.listeners.add(listener)
    },
    removeEventListener: (_type: 'message', listener: (event: MessageEvent) => void) => {
      this.listeners.delete(listener)
    },
  }

  deliver(frame: FakeFrame, message: unknown, transfer: MessagePort[]): void {
    setTimeout(() => {
      const event = {
        data: structuredClone(message),
        origin: this.frameOrigin,
        source: frame.contentWindow,
        ports: transfer,
      }
      for (const listener of [...this.listeners]) listener(event as unknown as MessageEvent)
    }, 0)
  }
}

describe('the web evaluator', () => {
  it('frames eval.html#nonce in a sandboxed iframe and talks to it through its channel', async () => {
    const page = new FakePage()
    const evaluator = createSandboxEvaluator({ window: page.window })
    expect(evaluator.origin).toBe(FXM)
    expect(await evaluator.evaluate('return args.join("-")', ['a', 'b'])).toBe('a-b')
    const [frame] = page.frames
    expect(frame?.src).toMatch(new RegExp(`^${FXM}${EVALUATOR_DOCUMENT_PATH}#[0-9a-f]{32}$`, 'u'))
    expect(Object.fromEntries(frame?.attributes ?? [])).toMatchObject({
      sandbox: 'allow-scripts',
      referrerpolicy: 'no-referrer',
    })
    expect(frame?.hidden).toBe(true)
    expect(page.append).toHaveBeenCalledOnce()
    expect((await evaluator.ready()).origin).toBe(FXM)
    // Requests go through the document's channel, never to the frame's window.
    expect(frame?.contentWindow.postMessage).not.toHaveBeenCalled()
    evaluator.dispose()
  })

  it('refuses a document that answers with a real origin: it is not sandboxed', async () => {
    const page = new FakePage(FXM)
    const evaluator = createSandboxEvaluator({ window: page.window })
    await expect(evaluator.evaluate('return 1')).rejects.toMatchObject({
      code: 'Unsupported',
      evaluatorCode: 'unavailable',
      message: expect.stringContaining('not sandboxed'),
    })
    expect(page.frames[0]?.removed).toBe(true)
    expect(page.listeners.size).toBe(0)
  })

  it('never hears from a document served from another origin, e.g. after a redirect', async () => {
    const clock = createFakeClock()
    const page = new FakePage('null', [
      { url: (src) => src.replace(FXM, 'https://elsewhere.example') },
    ])
    const evaluator = createSandboxEvaluator({ window: page.window, clock, openTimeoutMs: 1_000 })
    const ready = evaluator.ready()
    await tick()
    await clock.advanceAsync(1_000)
    // It sends its hello to the origin it was served from, so the app's page never gets it.
    await expect(ready).rejects.toMatchObject({ evaluatorCode: 'unavailable' })
    expect(page.frames[0]?.removed).toBe(true)
  })

  it('takes only the hello that echoes its nonce, and starts afresh after a failed start', async () => {
    const clock = createFakeClock()
    // The first document doesn't know the nonce (a page that replaced the evaluator early);
    // the second is the real one.
    const page = new FakePage('null', [{ url: (src) => src.replace(/#.*$/u, '#') }])
    const evaluator = createSandboxEvaluator({ window: page.window, clock, openTimeoutMs: 1_000 })
    const first = evaluator.ready()
    await tick()
    await clock.advanceAsync(1_000)
    await expect(first).rejects.toMatchObject({ evaluatorCode: 'unavailable' })
    expect(page.frames[0]?.removed).toBe(true)
    expect(page.listeners.size).toBe(0)
    const second = evaluator.evaluate('return "fresh"')
    await tick()
    expect(await second).toBe('fresh')
    expect(page.frames).toHaveLength(2)
    evaluator.dispose()
  })

  it('stops a document that something navigated, ignores the new one, and starts afresh', async () => {
    const page = new FakePage()
    const evaluator = createSandboxEvaluator({ window: page.window })
    expect(await evaluator.evaluate('return 1')).toBe(1)
    const pending = evaluator.evaluate('await new Promise(() => {})')
    await tick()
    const [frame] = page.frames
    frame?.navigate((post) => {
      // The new document forges a hello (it can't know the nonce) and an answer.
      post({ channel: EVALUATOR_CHANNEL, type: 'ready', version: 2, origin: FXM })
      for (let id = 0; id < 4; id += 1) {
        post({ channel: EVALUATOR_CHANNEL, id, ok: true, result: 'forged' })
      }
    })
    await expect(pending).rejects.toMatchObject({
      evaluatorCode: 'closed',
      message: expect.stringContaining('replaced'),
    })
    expect(frame?.removed).toBe(true)
    expect(await evaluator.evaluate('return "genuine"')).toBe('genuine')
    expect(page.frames).toHaveLength(2)
    evaluator.dispose()
  })

  it('starts a new document for the next call when its frame was navigated while idle', async () => {
    const page = new FakePage()
    const evaluator = createSandboxEvaluator({ window: page.window })
    await evaluator.ready()
    page.frames[0]?.navigate()
    await tick()
    expect(page.frames[0]?.removed).toBe(true)
    expect(await evaluator.evaluate('return "next"')).toBe('next')
    expect(page.frames).toHaveLength(2)
    evaluator.dispose()
  })

  it('removes the iframe and its listener when disposed', async () => {
    const page = new FakePage()
    const evaluator = createSandboxEvaluator({ window: page.window, url: `${FXM}/custom.html` })
    await evaluator.ready()
    expect(page.frames[0]?.src).toMatch(new RegExp(`^${FXM}/custom\\.html#`, 'u'))
    evaluator.dispose()
    expect(page.frames[0]?.removed).toBe(true)
    expect(page.listeners.size).toBe(0)
    await expect(evaluator.evaluate('return 1')).rejects.toMatchObject({ evaluatorCode: 'closed' })
  })
})
