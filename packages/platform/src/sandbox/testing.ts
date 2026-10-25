/**
 * Test helpers for the sandbox transport: a fake page whose iframes run the real document script
 * ({@link startSandboxDocument}) in-process. Window messages follow the browser's rules: one from
 * the page reaches a frame's document only with the target origin `'*'` (the document's origin is
 * opaque) and arrives with the page's origin and window as `origin` and `source`; one from a
 * document reaches the page only when addressed to the page's origin (or `'*'`), with `origin`
 * `'null'` and the frame's window as `source`. Ports are Node's real `MessageChannel` ports.
 *
 * Never imported by app code; the browser tests in `e2e/` cover the real thing.
 *
 * @module
 */

import {
  INNERTUBE_DOCUMENT_POLICY,
  type SandboxDocumentHandle,
  type SandboxScope,
  startSandboxDocument,
  USER_HOST_DOCUMENT_POLICY,
} from './document'
import type { SandboxHostWindow } from './transport'

/** The FXM origin the fake page is on by default. */
export const FAKE_FXM_ORIGIN = 'https://fxm-music.pages.dev'

/** A request a fake document sent. */
export interface FakeNetworkRequest {
  readonly url: string
  readonly init: RequestInit
}

/** What a frame's document does once it loads. */
export type FakeDocumentBehaviour =
  | 'innertube'
  | 'userhost'
  /** Loads, but never says hello (a blocked or broken document). */
  | 'silent'
  /** Runs custom code in the document's scope. */
  | ((scope: SandboxScope, frame: FakeFrame) => void)

/** Options for {@link createFakePage}. */
export interface FakePageOptions {
  /** The page's origin. Default {@link FAKE_FXM_ORIGIN}. */
  readonly origin?: string
  /** Answers the documents' requests. Default: 200 with `{"responseContext":{}}`. */
  readonly network?: (url: string, init: RequestInit) => Response | Promise<Response>
  /**
   * What the document at a URL does. Default: the InnerTube document at
   * `/sandbox/innertube.html`, the user-host document at `/sandbox/userhost.html`, and a silent
   * one anywhere else.
   */
  readonly documents?: (url: URL) => FakeDocumentBehaviour
  /** The documents' timers. Default: the real ones. */
  readonly timers?: Pick<SandboxScope, 'setTimeout' | 'clearTimeout'>
}

/** Who a hand-made window message comes from. */
export interface FakeSender {
  /** `event.origin`. */
  readonly origin: string
  /** `event.source`. */
  readonly source: unknown
  /** `event.ports`. */
  readonly ports?: readonly MessagePort[]
}

/** An iframe of the fake page. */
export interface FakeFrame {
  /** Its attributes. */
  readonly attributes: ReadonlyMap<string, string>
  /** Its `src`. */
  readonly src: string
  /** Its `hidden` property. */
  readonly hidden: boolean
  /** Whether it is in the page. */
  readonly connected: boolean
  /** Its window, as the page sees it (`contentWindow`), while it is in the page. */
  readonly window: object | null
  /** The page's window as the document sees it (`parent`), the `source` of the page's messages. */
  readonly parent: object
  /** The running document, once it loaded and runs the real script. */
  readonly document: SandboxDocumentHandle | undefined
  /** Delivers a window message to the document, as `sender` would post it. */
  deliver(data: unknown, sender: FakeSender): void
}

/** The fake page. */
export interface FakePage {
  /** The page's `window`, for `createSandboxTransport({ window })`. */
  readonly window: SandboxHostWindow
  /** Every iframe the page created, in order. */
  readonly frames: readonly FakeFrame[]
  /** Every request the documents sent, in order. */
  readonly requests: readonly FakeNetworkRequest[]
  /** Delivers a window message to the page, as `sender` would post it. */
  deliver(data: unknown, sender: FakeSender): void
  /** Waits until every message and load queued so far has been handled. */
  settle(): Promise<void>
}

type Listener = (event: MessageEvent) => void

/** Runs `callback` on a later macrotask, as browsers deliver messages and loads. */
function later(callback: () => void): void {
  setTimeout(callback, 0)
}

function dispatch(listeners: ReadonlySet<Listener>, data: unknown, sender: FakeSender): void {
  const event = {
    data,
    origin: sender.origin,
    source: sender.source,
    ports: [...(sender.ports ?? [])],
  } as unknown as MessageEvent
  for (const listener of [...listeners]) listener(event)
}

function isPort(value: unknown): value is MessagePort {
  return typeof MessagePort === 'function' && value instanceof MessagePort
}

function defaultDocuments(url: URL): FakeDocumentBehaviour {
  if (url.pathname === '/sandbox/innertube.html') return 'innertube'
  if (url.pathname === '/sandbox/userhost.html') return 'userhost'
  return 'silent'
}

/** Creates a fake page. */
export function createFakePage(options: FakePageOptions = {}): FakePage {
  const origin = options.origin ?? FAKE_FXM_ORIGIN
  const network =
    options.network ?? (async () => Response.json({ responseContext: { visitorData: 'v' } }))
  const documents = options.documents ?? defaultDocuments
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const pageListeners = new Set<Listener>()
  const frames: FakeFrame[] = []
  const requests: FakeNetworkRequest[] = []
  let queued = 0

  const enqueue = (callback: () => void) => {
    queued += 1
    later(() => {
      queued -= 1
      callback()
    })
  }

  const pageWindow = {
    location: { origin, href: `${origin}/app/` },
    document: {} as Record<string, unknown>,
    addEventListener(type: string, listener: Listener) {
      if (type === 'message') pageListeners.add(listener)
    },
    removeEventListener(type: string, listener: Listener) {
      if (type === 'message') pageListeners.delete(listener)
    },
  }

  function createFrame(): FakeFrame & Record<string, unknown> {
    const attributes = new Map<string, string>()
    const documentListeners = new Set<Listener>()
    let src = ''
    let connected = false
    let document: SandboxDocumentHandle | undefined

    // The page's window as the document sees it (its `parent`): posting to it reaches the page,
    // from an opaque origin. As in a browser, it is also the `source` of the page's messages.
    const parent = {
      postMessage(data: unknown, targetOrigin: string) {
        if (!connected || (targetOrigin !== '*' && targetOrigin !== origin)) return
        const copy = structuredClone(data)
        enqueue(() => dispatch(pageListeners, copy, { origin: 'null', source: contentWindow }))
      },
    }

    // The frame's window as the page sees it: posting to it reaches the document.
    const contentWindow = {
      postMessage(data: unknown, targetOrigin: string, transfer: unknown[] = []) {
        // The document's origin is opaque: no named origin matches it.
        if (!connected || targetOrigin !== '*') return
        const ports = transfer.filter(isPort)
        const copy = structuredClone(data)
        enqueue(() => dispatch(documentListeners, copy, { origin, source: parent, ports }))
      },
    }

    const frame = {
      attributes,
      get src() {
        return src
      },
      set src(value: string) {
        src = value
      },
      hidden: false,
      get connected() {
        return connected
      },
      get window() {
        return connected ? contentWindow : null
      },
      get contentWindow() {
        return connected ? contentWindow : null
      },
      parent,
      get document() {
        return document
      },
      setAttribute(name: string, value: string) {
        attributes.set(name, value)
      },
      remove() {
        connected = false
        document?.stop()
      },
      deliver(data: unknown, sender: FakeSender) {
        enqueue(() => dispatch(documentListeners, structuredClone(data), sender))
      },
      /** Called when the page appends the frame: the document loads. */
      load() {
        connected = true
        const url = new URL(src, origin)
        const scope: SandboxScope = {
          location: { href: url.href },
          parent,
          addEventListener(type, listener) {
            if (type === 'message') documentListeners.add(listener)
          },
          removeEventListener(type, listener) {
            if (type === 'message') documentListeners.delete(listener)
          },
          fetch: async (input, init) => {
            requests.push({ url: input, init })
            return network(input, init)
          },
          setTimeout: timers.setTimeout,
          clearTimeout: timers.clearTimeout,
        }
        enqueue(() => {
          if (!connected) return
          const behaviour = documents(url)
          if (behaviour === 'innertube') {
            document = startSandboxDocument(scope, INNERTUBE_DOCUMENT_POLICY)
          } else if (behaviour === 'userhost') {
            document = startSandboxDocument(scope, USER_HOST_DOCUMENT_POLICY)
          } else if (typeof behaviour === 'function') {
            behaviour(scope, frame)
          }
        })
      },
    }
    return frame
  }

  const element = {
    appendChild(node: { load?: () => void }) {
      node.load?.()
      return node
    },
  }
  pageWindow.document = {
    createElement(tag: string) {
      if (tag !== 'iframe') throw new Error(`The fake page creates only iframes, not ${tag}`)
      const frame = createFrame()
      frames.push(frame)
      return frame
    },
    body: element,
    documentElement: element,
  }

  return {
    window: pageWindow as unknown as SandboxHostWindow,
    frames,
    requests,
    deliver(data, sender) {
      enqueue(() => dispatch(pageListeners, structuredClone(data), sender))
    },
    async settle() {
      // Messages and loads queue further ones; wait until a round queues nothing new.
      for (let round = 0; round < 50; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (queued === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          if (queued === 0) return
        }
      }
    },
  }
}
