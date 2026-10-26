/**
 * The evaluator document's channels: how `eval.html` receives requests and answers them. The
 * document picks one when it starts:
 *
 * - **Framed** (the web): the app frames `/sandbox/eval.html#<nonce>` in a sandboxed iframe. The
 *   document creates a `MessageChannel` and sends its hello, with the nonce of its URL and one
 *   end of the channel, to its parent at the FXM origin only (`messages.ts`). From then on it
 *   hears requests only on its end of that channel and answers there: whatever else reaches its
 *   window is ignored, and a document that replaces it (a navigation of the frame) has neither
 *   the channel nor the nonce.
 * - **Mailbox** (a top-level document: desktop and Android): a native webview loads the document
 *   by itself. The document exposes `window.__fxmEvaluator`, and the host drives it through the
 *   webview's own script evaluation (Tauri's `eval_with_callback`, Android's
 *   `evaluateJavascript`): it reads `hello`, passes each request to `receive`, and collects the
 *   answer with `take`. The document needs no bridge object, no IPC and no network for this.
 *
 * @module
 */

import { type FramedWindow, trustedParentOrigin } from './messages'
import {
  EVALUATOR_CHANNEL,
  EVALUATOR_NONCE,
  EVALUATOR_PROTOCOL_VERSION,
  type EvaluatorHello,
  requestIdOf,
} from './protocol'
import { createEvaluatorRuntime, type EvaluatorRuntime } from './runtime'

/** The name of the mailbox global on a top-level document. */
export const MAILBOX_GLOBAL = '__fxmEvaluator'

/** How many answers the mailbox holds before it drops the oldest one nobody took. */
export const MAX_MAILBOX_ANSWERS = 256

/**
 * The mailbox a top-level evaluator document exposes as `window.__fxmEvaluator`. Every value
 * crosses the native bridge as text, so requests and answers are JSON strings.
 */
export interface EvaluatorMailbox {
  /** The document's {@link EvaluatorHello}, as JSON. */
  readonly hello: string
  /**
   * Starts working on a request, given as JSON. `accepted` means its answer will come through
   * {@link take}; `refused` means the text was no evaluator request with an id.
   */
  receive(request: string): 'accepted' | 'refused'
  /** The answer to request `id`, as JSON, once it is ready, else `null`. Each answer is given once. */
  take(id: number): string | null
}

/**
 * The parts of the document's `window` the channels use: its parent, and its URL, whose fragment
 * carries the web host's nonce.
 */
export type EvaluatorDocumentWindow = FramedWindow

/** Which channel the document chose. */
export type EvaluatorDocumentChannel = 'framed' | 'mailbox'

/**
 * The origin a document reports in its hello: `protocol//host` of its URL, which also names
 * custom schemes such as `fxm-eval://localhost` (whose URL origin is opaque), or the protocol
 * alone for a URL without a host (`about:`).
 */
export function documentOrigin(href: string): string {
  const url = new URL(href)
  return url.host === '' ? url.protocol : `${url.protocol}//${url.host}`
}

/** The nonce in the fragment of `href`, if it is one. */
function nonceOf(href: string): string | undefined {
  const nonce = new URL(href).hash.slice(1)
  return EVALUATOR_NONCE.test(nonce) ? nonce : undefined
}

/** A parent window that takes messages with transferred ports. */
interface ParentWindow {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void
}

/**
 * Starts the evaluator in a document: chooses the channel (framed when the window has a parent,
 * else the mailbox), installs it, and announces the document. Returns the channel it chose.
 */
export function startEvaluatorDocument(
  window: EvaluatorDocumentWindow,
  runtime: EvaluatorRuntime = createEvaluatorRuntime(),
): EvaluatorDocumentChannel {
  const stringify = JSON.stringify
  const parse = JSON.parse
  const hello: EvaluatorHello = {
    channel: EVALUATOR_CHANNEL,
    type: 'ready',
    version: EVALUATOR_PROTOCOL_VERSION,
    origin: documentOrigin(window.location.href),
  }

  if (window.parent !== window && typeof window.parent === 'object' && window.parent !== null) {
    const parent = window.parent as ParentWindow
    const post = parent.postMessage.bind(parent)
    const channel = new MessageChannel()
    const port = channel.port1
    const answer = port.postMessage.bind(port)
    // Only the parent that got the other end can reach this one: requests come from nowhere else.
    port.onmessage = (event: MessageEvent) => {
      void runtime.handle(event.data).then((response) => {
        if (response !== undefined) answer(response)
      })
    }
    const nonce = nonceOf(window.location.href)
    post({ ...hello, ...(nonce === undefined ? {} : { nonce }) }, trustedParentOrigin(window), [
      channel.port2,
    ])
    return 'framed'
  }

  const answers = new Map<number, string>()
  const mailbox: EvaluatorMailbox = {
    hello: stringify(hello),
    receive(text) {
      let message: unknown
      try {
        message = parse(String(text))
      } catch {
        return 'refused'
      }
      const id = requestIdOf(message)
      if (id === undefined) return 'refused'
      void runtime.handle(message).then((response) => {
        if (response === undefined) return
        answers.delete(id)
        answers.set(id, stringify(response))
        while (answers.size > MAX_MAILBOX_ANSWERS) {
          const oldest = answers.keys().next().value
          if (oldest === undefined) break
          answers.delete(oldest)
        }
      })
      return 'accepted'
    },
    take(id) {
      const answer = answers.get(id)
      if (answer === undefined) return null
      answers.delete(id)
      return answer
    },
  }
  Object.defineProperty(window, MAILBOX_GLOBAL, {
    value: Object.freeze(mailbox),
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return 'mailbox'
}
