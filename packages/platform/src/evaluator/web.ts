/**
 * The evaluator on the web: `/sandbox/eval.html` in a hidden iframe with
 * `sandbox="allow-scripts"` and no `allow-same-origin`, so the document runs with an opaque
 * origin and cannot reach the app's storage, cookies or DOM. The site also serves it with its own
 * policy, which starts with `sandbox allow-scripts` and allows no network (`connect-src 'none'`):
 * it is the only document of FXM's web deployment whose policy allows `'unsafe-eval'`. The app's
 * own policy never does.
 *
 * The host is tied to the one document it loaded:
 *
 * - it loads `eval.html#<nonce>`, with a new random nonce for every start, and takes only the
 *   hello that echoes it, from its iframe, with an opaque origin (`'null'`: a document that
 *   answers with a real origin was not sandboxed, and the host refuses it);
 * - that hello hands over the document's end of a `MessageChannel`, and every request and answer
 *   goes over that channel, never through the window: a document that replaces it, after a
 *   navigation of the frame, has neither the nonce nor the channel;
 * - the frame's `load` events are counted: a second one means its document was replaced (by a
 *   script in it or by an ancestor page), and the host stops it at once and starts a new one on
 *   the next call. A policy can't forbid a document to navigate itself; the host can only see it.
 *
 * @module
 */

import {
  type CreateEvaluatorOptions,
  createEvaluator,
  type Evaluator,
  EvaluatorError,
  type EvaluatorPort,
} from './evaluator'
import { Inbox } from './inbox'
import { parseEvaluatorHello } from './protocol'

/** Where the web app finds the evaluator document. */
export const EVALUATOR_DOCUMENT_PATH = '/sandbox/eval.html'

/** The parts of the page's `window` the web evaluator uses. */
export interface SandboxHostWindow {
  /** The page. */
  readonly document: Document
  /** The page's origin, which the evaluator document's URL defaults to. */
  readonly location: { readonly origin: string }
  /** Listens for the document's hello. */
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  /** Stops listening. */
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/** Options for {@link createSandboxEvaluator}. */
export interface SandboxEvaluatorOptions extends CreateEvaluatorOptions {
  /** The page. Default: the global `window`. */
  window?: SandboxHostWindow
  /** The document's URL. Default: {@link EVALUATOR_DOCUMENT_PATH} on the page's origin. */
  url?: string
}

/** A random nonce for the document's URL: 128 bits, as hexadecimal. */
function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/** A document the port started. */
interface FrameDocument {
  readonly frame: HTMLIFrameElement
  /** The document's end of its channel, once its hello came. */
  port?: MessagePort
  /** Removes the listeners. */
  release(): void
}

/** The document's URL for `options`, without a fragment. */
function documentUrl(options: Pick<SandboxEvaluatorOptions, 'window' | 'url'>): URL {
  const window = options.window ?? (globalThis as unknown as { window: SandboxHostWindow }).window
  const url = new URL(options.url ?? EVALUATOR_DOCUMENT_PATH, window.location.origin)
  url.hash = ''
  return url
}

/** The port of {@link createSandboxEvaluator}, for tests and other hosts. */
export function createSandboxPort(
  options: Pick<SandboxEvaluatorOptions, 'window' | 'url'> = {},
): EvaluatorPort {
  const window = options.window ?? (globalThis as unknown as { window: SandboxHostWindow }).window
  const url = documentUrl(options)
  const inbox = new Inbox()
  let current: FrameDocument | undefined

  /** Stops the running document, rejecting what waits for it with `reason`. */
  function stop(reason: unknown): void {
    const running = current
    current = undefined
    if (running !== undefined) {
      running.release()
      running.port?.close()
      running.frame.remove()
    }
    inbox.rejectAll(reason)
  }

  return {
    open(signal) {
      stop(new EvaluatorError('closed', 'The evaluator document was restarted'))
      return new Promise<unknown>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        const nonce = randomNonce()
        const src = new URL(url)
        src.hash = nonce
        const iframe = window.document.createElement('iframe')
        iframe.setAttribute('sandbox', 'allow-scripts')
        iframe.setAttribute('referrerpolicy', 'no-referrer')
        iframe.setAttribute('title', 'FXM evaluator')
        iframe.setAttribute('aria-hidden', 'true')
        iframe.setAttribute('tabindex', '-1')
        iframe.hidden = true
        iframe.style.display = 'none'
        let settled = false
        let loads = 0
        const loaded: FrameDocument = {
          frame: iframe,
          release() {
            window.removeEventListener('message', onMessage)
            iframe.removeEventListener('load', onLoad)
            signal?.removeEventListener('abort', onAbort)
          },
        }
        const fail = (error: unknown) => {
          if (current === loaded) stop(error)
          if (settled) return
          settled = true
          reject(error)
        }
        const onMessage = (event: MessageEvent) => {
          if (current !== loaded || event.source !== iframe.contentWindow) return
          // Once connected, the document speaks only through its channel: a channel anything
          // else in the frame offers is closed.
          if (loaded.port !== undefined) {
            for (const offered of event.ports) offered.close()
            return
          }
          if (event.origin !== 'null') {
            fail(
              new EvaluatorError(
                'unavailable',
                `The evaluator document runs with the origin ${event.origin}, not an opaque one: it is not sandboxed`,
              ),
            )
            return
          }
          const hello = parseEvaluatorHello(event.data)
          // Another document's hello, or no hello at all.
          if (hello === undefined || hello.nonce !== nonce) {
            for (const offered of event.ports) offered.close()
            return
          }
          const [port] = event.ports
          if (port === undefined || event.ports.length !== 1) {
            fail(new EvaluatorError('unavailable', 'The evaluator document opened no channel'))
            return
          }
          loaded.port = port
          port.onmessage = (message: MessageEvent) => inbox.deliver(message.data)
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve(event.data)
        }
        const onLoad = () => {
          loads += 1
          // The first load is the document's own; another one is a document that replaced it.
          if (loads > 1) {
            fail(
              new EvaluatorError(
                'closed',
                'The evaluator document was replaced: something navigated its frame',
              ),
            )
          }
        }
        const onAbort = () => fail(signal?.reason)
        window.addEventListener('message', onMessage)
        iframe.addEventListener('load', onLoad)
        signal?.addEventListener('abort', onAbort, { once: true })
        iframe.src = src.href
        current = loaded
        ;(window.document.body ?? window.document.documentElement).append(iframe)
      })
    },
    send(request, signal) {
      const port = current?.port
      if (port === undefined) {
        return Promise.reject(new EvaluatorError('closed', 'The evaluator document is not running'))
      }
      const answer = inbox.wait(request.id, signal)
      port.postMessage(request)
      return answer
    },
    close() {
      stop(new EvaluatorError('closed', 'The evaluator was stopped'))
    },
    alive() {
      return current?.port !== undefined
    },
  }
}

/**
 * Creates the web evaluator. Its iframe is added to the page on the first call, and removed by
 * `dispose`.
 *
 * ```ts
 * const evaluator = createSandboxEvaluator()
 * const result = await evaluator.evaluate('return args.a + args.b', { a: 1, b: 2 }) // 3
 * ```
 */
export function createSandboxEvaluator(options: SandboxEvaluatorOptions = {}): Evaluator {
  const { window, url, ...evaluatorOptions } = options
  const where = {
    ...(window === undefined ? {} : { window }),
    ...(url === undefined ? {} : { url }),
  }
  return createEvaluator('web', createSandboxPort(where), {
    ...evaluatorOptions,
    origin: documentUrl(where).origin,
  })
}
