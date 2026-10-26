/**
 * The port for evaluator documents that a native webview hosts as a top-level page (desktop and
 * Android). Such a document exposes a mailbox, `window.__fxmEvaluator` (see `document.ts`), and
 * the host only needs one native primitive: run a short script in that webview and get its result
 * back as JSON text. Tauri's `eval_with_callback` and Android's `evaluateJavascript` both work
 * that way. Everything else (handing over requests, collecting answers, timeouts) happens here,
 * so the native code stays small and the protocol is tested once.
 *
 * The document needs no bridge object, no IPC and no network for this: the host reads from it,
 * it never calls out.
 *
 * Every read of the mailbox is a round trip through the native bridge, so the port reads only
 * while someone waits: a poll ends with its answer, when the evaluator stops waiting (its signal:
 * a timeout or the caller's cancellation), or when the document is stopped.
 *
 * @module
 */

import { type Clock, systemClock } from '../clock'
import { MAILBOX_GLOBAL } from './document'
import { EvaluatorError, type EvaluatorPort } from './evaluator'
import type { EvaluatorRequest } from './protocol'

/**
 * Runs `script` in the evaluator's webview and resolves with the script's value as JSON text,
 * e.g. `"\"accepted\""` for the string `accepted` and `null` for `null`.
 */
export type ScriptRunner = (script: string) => Promise<string>

/** Options for {@link createMailboxPort}. */
export interface MailboxPortOptions {
  /** Runs a script in the evaluator's webview. */
  run: ScriptRunner
  /**
   * Creates the webview, destroying any earlier one, and loads the document, before the first
   * read.
   */
  start?: () => Promise<void>
  /** Destroys the webview. */
  stop?: () => void
  /** The first delay between two reads of the mailbox, in milliseconds. Default 5. */
  pollMs?: number
  /** The longest delay between two reads, in milliseconds. Default 100. */
  maxPollMs?: number
  /** The clock for the delays, for tests. */
  clock?: Clock
}

/** A script that reads a mailbox property without ever throwing. */
function read(expression: string): string {
  return `(function(){try{var m=window[${JSON.stringify(MAILBOX_GLOBAL)}];return m?${expression}:null}catch(e){return null}})()`
}

/** The script that reads the document's hello. */
export const HELLO_SCRIPT = read('m.hello')

/** The script that hands a request to the document. */
export function receiveScript(request: EvaluatorRequest): string {
  return read(`m.receive(${JSON.stringify(JSON.stringify(request))})`)
}

/** The script that collects the answer to request `id`. */
export function takeScript(id: number): string {
  return read(`m.take(${Math.trunc(id)})`)
}

/** The script's value, from the runner's JSON text; `null` for text that is not JSON. */
function scriptValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** The message the mailbox handed out as JSON text, or `null` while there is none. */
function messageOf(text: string): unknown {
  const value = scriptValue(text)
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new EvaluatorError(
      'bad-request',
      'The evaluator document handed out something else than JSON',
    )
  }
}

/** Creates a mailbox port on a {@link ScriptRunner}. */
export function createMailboxPort(options: MailboxPortOptions): EvaluatorPort {
  const clock = options.clock ?? systemClock
  const firstDelay = options.pollMs ?? 5
  const longestDelay = options.maxPollMs ?? 100
  /** Counts the documents: a poll for an earlier one stops. */
  let generation = 0

  function closed(): EvaluatorError {
    return new EvaluatorError('closed', 'The evaluator was stopped')
  }

  /** Waits `ms`, or less when `signal` aborts. */
  function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const timer = clock.setTimeout(done, ms)
      function done() {
        clock.clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Reads with `script` until it gives something, while document `mine` runs and `signal` holds. */
  async function poll(
    script: string,
    mine: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    let delay = firstDelay
    for (;;) {
      signal?.throwIfAborted()
      if (mine !== generation) throw closed()
      const value = messageOf(await options.run(script))
      if (value !== null) return value
      await sleep(delay, signal)
      delay = Math.min(delay * 2, longestDelay)
    }
  }

  return {
    async open(signal) {
      generation += 1
      const mine = generation
      await options.start?.()
      return poll(HELLO_SCRIPT, mine, signal)
    },
    async send(request, signal) {
      const mine = generation
      signal?.throwIfAborted()
      const accepted = scriptValue(await options.run(receiveScript(request)))
      if (accepted !== 'accepted') {
        throw new EvaluatorError('unavailable', 'The evaluator document did not take the request')
      }
      return poll(takeScript(request.id), mine, signal)
    },
    close() {
      generation += 1
      options.stop?.()
    },
  }
}
