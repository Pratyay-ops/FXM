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
  /** Creates the webview and loads the document, before the first read. */
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
  let generation = 0
  let started: Promise<unknown> | undefined

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      clock.setTimeout(resolve, ms)
    })
  }

  /** Reads with `script` until it gives something, while this generation lasts. */
  async function poll(script: string, signal: AbortSignal | undefined): Promise<unknown> {
    const mine = generation
    let delay = firstDelay
    for (;;) {
      signal?.throwIfAborted()
      if (mine !== generation) throw new EvaluatorError('closed', 'The evaluator was stopped')
      const value = messageOf(await options.run(script))
      if (value !== null) return value
      await sleep(delay)
      delay = Math.min(delay * 2, longestDelay)
    }
  }

  return {
    open(signal) {
      if (started !== undefined) return started
      generation += 1
      const attempt = (async () => {
        await options.start?.()
        return poll(HELLO_SCRIPT, signal)
      })()
      started = attempt
      attempt.catch(() => {
        if (started === attempt) started = undefined
      })
      return attempt
    },
    async send(request, signal) {
      const accepted = scriptValue(await options.run(receiveScript(request)))
      if (accepted !== 'accepted') {
        throw new EvaluatorError('unavailable', 'The evaluator document did not take the request')
      }
      return poll(takeScript(request.id), signal)
    },
    close() {
      generation += 1
      started = undefined
      options.stop?.()
    },
  }
}
