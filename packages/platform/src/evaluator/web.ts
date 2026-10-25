/**
 * The evaluator on the web: `/sandbox/eval.html` in a hidden iframe with
 * `sandbox="allow-scripts"` and no `allow-same-origin`, so the document runs with an opaque
 * origin and cannot reach the app's storage, cookies or DOM. The site also serves it with its own
 * policy, which starts with `sandbox allow-scripts` and allows no network (`connect-src 'none'`):
 * it is the only document of FXM's web deployment whose policy allows `'unsafe-eval'`. The app's
 * own policy never does.
 *
 * The app talks to it with `postMessage`. It accepts answers only from that iframe, and only while
 * the iframe's origin really is opaque (`'null'`): a document that answers with a real origin was
 * not sandboxed, and the evaluator refuses to use it.
 *
 * @module
 */

import type { Clock } from '../clock'
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
  /** Listens for the document's messages. */
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

/** The port of {@link createSandboxEvaluator}, for tests and other hosts. */
export function createSandboxPort(
  options: Pick<SandboxEvaluatorOptions, 'window' | 'url'> & { clock?: Clock } = {},
): EvaluatorPort {
  const window = options.window ?? (globalThis as unknown as { window: SandboxHostWindow }).window
  const url = options.url ?? new URL(EVALUATOR_DOCUMENT_PATH, window.location.origin).href
  const inbox = new Inbox(options.clock === undefined ? Date.now : () => options.clock?.now() ?? 0)
  let frame: HTMLIFrameElement | undefined
  let listener: ((event: MessageEvent) => void) | undefined
  let started: Promise<unknown> | undefined

  function close(): void {
    if (listener !== undefined) window.removeEventListener('message', listener)
    listener = undefined
    frame?.remove()
    frame = undefined
    started = undefined
    inbox.rejectAll(new EvaluatorError('closed', 'The evaluator was stopped'))
  }

  return {
    open() {
      if (started !== undefined) return started
      close()
      started = new Promise<unknown>((resolve, reject) => {
        const iframe = window.document.createElement('iframe')
        iframe.setAttribute('sandbox', 'allow-scripts')
        iframe.setAttribute('referrerpolicy', 'no-referrer')
        iframe.setAttribute('title', 'FXM evaluator')
        iframe.setAttribute('aria-hidden', 'true')
        iframe.setAttribute('tabindex', '-1')
        iframe.hidden = true
        iframe.style.display = 'none'
        let ready = false
        listener = (event: MessageEvent) => {
          if (frame === undefined || event.source !== frame.contentWindow) return
          if (event.origin !== 'null') {
            const error = new EvaluatorError(
              'unavailable',
              `The evaluator document runs with the origin ${event.origin}, not an opaque one: it is not sandboxed`,
            )
            close()
            reject(error)
            return
          }
          if (!ready) {
            if (parseEvaluatorHello(event.data) === undefined) return
            ready = true
            resolve(event.data)
            return
          }
          inbox.deliver(event.data)
        }
        window.addEventListener('message', listener)
        iframe.src = url
        frame = iframe
        ;(window.document.body ?? window.document.documentElement).append(iframe)
      })
      started.catch(() => {})
      return started
    },
    send(request) {
      const target = frame?.contentWindow
      if (target === undefined || target === null) {
        return Promise.reject(new EvaluatorError('closed', 'The evaluator document is not running'))
      }
      const answer = inbox.wait(request.id)
      // The document's origin is opaque, so no other target origin can be named.
      target.postMessage(request, '*')
      return answer
    },
    close,
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
  return createEvaluator(
    'web',
    createSandboxPort({
      ...(options.window === undefined ? {} : { window: options.window }),
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
    options,
  )
}
