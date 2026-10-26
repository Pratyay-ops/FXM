/**
 * The plugin relay: what runs in a plugin's evaluator document (stage 1.11's `eval.html`). It
 * never runs the plugin's code itself. It starts a worker from a `blob:` URL holding the worker's
 * runtime (`worker.ts`), hands it the plugin's code, as text, then each message of the host, and
 * gives the host the worker's answer as it came: JSON text.
 *
 * Why a worker: a document's own scripts can open WebRTC connections, which no content security
 * policy covers, and navigate their document, which carries data out in the URL. A worker can do
 * neither: it has no DOM and no `RTCPeerConnection`, and it inherits the document's policy, so its
 * `fetch`, sockets and imports reach nothing (`connect-src 'none'`). The document allows workers
 * from `blob:` URLs only (`worker-src blob:`). And a worker runs on a thread of its own, so the
 * relay can stop one that loops forever, and the document keeps answering.
 *
 * The relay answers for the worker when:
 *
 * - it has no answer within `waitMs`: it stops the worker and answers `hung` (the next call starts
 *   a new one), so a plugin that loops forever is stopped;
 * - the answer is longer than `maxReplyChars`, or not an answer of the protocol: it stops the
 *   worker and answers `too-large` or `bad-reply`;
 * - the worker can't start (it fails before it announces itself, which its own runtime never
 *   does): `unavailable`, remembered, so every later call gets it at once. Safari's engine, for
 *   one, refuses workers from the `blob:` URLs of an opaque origin.
 *
 * A plugin's code that doesn't compile is the worker's to report (`load-failed`): it compiles the
 * code it is handed itself.
 *
 * **Self-contained.** The host sends this function's source text to the document
 * ({@link pluginSource}), so it must not use anything from outside its own body. Keep its syntax
 * to what the evaluator's webviews run unchanged (ES2022).
 *
 * @module
 */

import { pluginWorkerScript } from './worker'

/** What the host decides about the relay of one plugin, when it builds its source. */
export interface RelayOptions {
  /** How long the relay waits for the worker to answer one message, in milliseconds. */
  readonly waitMs: number
  /** The longest answer it passes on, in characters of JSON text. */
  readonly maxReplyChars: number
  /**
   * How long a worker may sit without a message before the relay stops it, in milliseconds:
   * longer than any call takes, so it never cuts one off. A plugin that keeps working between
   * calls (a busy loop on a timer, say) stops then; the next call starts a new worker.
   */
  readonly idleMs: number
}

// The shapes the relay works with. Types only: they vanish from the source text.

interface WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessageerror: ((event: unknown) => void) | null
  postMessage(message: unknown): void
  terminate(): void
}

interface Waiting {
  resolve(reply: string): void
  timer: ReturnType<typeof setTimeout>
}

interface Relay {
  worker: WorkerLike | undefined
  url: string | undefined
  started: boolean
  seq: number
  waiting: Map<number, Waiting>
  idle: ReturnType<typeof setTimeout> | undefined
  /** The reply every call gets once no worker could start here. */
  broken: string | undefined
}

/**
 * Relays one message of the host (`input`, as `Evaluator.evaluate` passes its `args`) to the
 * worker of the plugin whose code is `code`, a worker started with `script` (the worker's
 * runtime), and resolves with the answer, as JSON text. `key` names the plugin's version and
 * runner: the relay keeps its worker per key on the document's global object, so a new version
 * starts afresh.
 */
export function pluginRelay(
  input: unknown,
  script: string,
  code: string,
  key: string,
  options: RelayOptions,
): Promise<string> {
  const global = globalThis as unknown as Record<symbol, unknown> & Record<string, unknown>
  const slot = Symbol.for('fxm.plugins.relay')
  let relays = global[slot] as Map<string, Relay> | undefined
  if (!(relays instanceof Map)) {
    relays = new Map()
    Object.defineProperty(global, slot, { value: relays, configurable: false, writable: false })
  }
  let found = relays.get(key)
  if (found === undefined) {
    found = {
      worker: undefined,
      url: undefined,
      started: false,
      seq: 0,
      waiting: new Map(),
      idle: undefined,
      broken: undefined,
    }
    relays.set(key, found)
  }
  const relay: Relay = found
  const stringify = JSON.stringify

  function failed(code: string, message: string): string {
    return stringify({
      fxmPluginReply: 1,
      state: 'failed',
      error: { code, message: String(message).replace(/\s+/gu, ' ').trim().slice(0, 300) },
    })
  }

  /** Stops the worker and answers every message still waiting for it with `reply`. */
  function stop(reply: string): void {
    const { worker, url } = relay
    relay.worker = undefined
    relay.url = undefined
    relay.started = false
    if (relay.idle !== undefined) clearTimeout(relay.idle)
    relay.idle = undefined
    if (worker !== undefined) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      try {
        worker.terminate()
      } catch {
        // Already gone.
      }
    }
    if (url !== undefined) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Nothing to free.
      }
    }
    const waiting = [...relay.waiting.values()]
    relay.waiting.clear()
    for (const entry of waiting) {
      clearTimeout(entry.timer)
      entry.resolve(reply)
    }
  }

  function onMessage(event: { data: unknown }): void {
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as {
      fxmPluginWorker?: unknown
      hello?: unknown
      seq?: unknown
      reply?: unknown
    }
    if (data.fxmPluginWorker === 1 && data.hello === true && !relay.started) {
      relay.started = true
      return
    }
    const entry = typeof data.seq === 'number' ? relay.waiting.get(data.seq) : undefined
    if (data.fxmPluginWorker !== 1 || entry === undefined || typeof data.reply !== 'string') {
      stop(failed('bad-reply', 'The plugin answered outside the plugin protocol'))
      return
    }
    if (data.reply.length > options.maxReplyChars) {
      stop(
        failed(
          'too-large',
          `The plugin answered ${data.reply.length} characters; FXM takes at most ${options.maxReplyChars}`,
        ),
      )
      return
    }
    relay.waiting.delete(data.seq as number)
    clearTimeout(entry.timer)
    if (relay.waiting.size === 0) {
      relay.idle = setTimeout(() => stop(failed('hung', 'The plugin was idle')), options.idleMs)
    }
    entry.resolve(data.reply)
  }

  function onError(event: unknown): void {
    ;(event as { preventDefault?: () => void } | null)?.preventDefault?.()
    // After it started, an error is the plugin's own (a timer's callback threw, say): the worker
    // goes on, and so do its calls.
    if (relay.started) return
    // Before: the worker's own runtime, which always compiles, didn't get to run here.
    relay.broken = failed('unavailable', 'The plugin’s worker did not start here')
    stop(relay.broken)
  }

  function spawn(): string | undefined {
    const WorkerClass = global.Worker as (new (url: string) => WorkerLike) | undefined
    const BlobClass = global.Blob as (new (parts: string[], options: object) => object) | undefined
    if (
      typeof WorkerClass !== 'function' ||
      typeof BlobClass !== 'function' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return failed('unavailable', 'Plugins need workers, which this document can’t start')
    }
    let url: string | undefined
    try {
      url = URL.createObjectURL(new BlobClass([script], { type: 'text/javascript' }) as Blob)
      const worker = new WorkerClass(url)
      worker.onmessage = onMessage
      worker.onerror = onError
      worker.onmessageerror = () =>
        stop(failed('bad-reply', 'The plugin answered something that can’t be read'))
      relay.worker = worker
      relay.url = url
      relay.started = false
      // Its code first, which it compiles on its first call: every later message follows it.
      worker.postMessage({ fxmPluginWorker: 1, code })
      return undefined
    } catch (error) {
      if (url !== undefined) URL.revokeObjectURL(url)
      const name = (error as { name?: unknown } | null)?.name
      return failed(
        'unavailable',
        `Plugins need workers, which this document can’t start (${typeof name === 'string' ? name : 'Error'})`,
      )
    }
  }

  const message = (typeof input === 'object' && input !== null ? input : {}) as {
    fxmPlugin?: unknown
    op?: unknown
  }
  if (message.fxmPlugin !== 1) {
    return Promise.resolve(failed('bad-request', 'Not a plugin message'))
  }
  if (relay.broken !== undefined) return Promise.resolve(relay.broken)
  if (relay.worker === undefined) {
    // A call that was stopped is gone with its worker: only a new call starts one.
    if (message.op === 'cancel') {
      return Promise.resolve(stringify({ fxmPluginReply: 1, state: 'cancelled' }))
    }
    if (message.op !== 'call') {
      return Promise.resolve(failed('unknown-call', 'The call is gone'))
    }
    const refused = spawn()
    if (refused !== undefined) return Promise.resolve(refused)
  }
  const worker = relay.worker as WorkerLike
  if (relay.idle !== undefined) clearTimeout(relay.idle)
  relay.idle = undefined
  relay.seq += 1
  const seq = relay.seq
  return new Promise<string>((resolve) => {
    const timer = setTimeout(
      () => stop(failed('hung', `The plugin did not answer within ${options.waitMs} ms`)),
      options.waitMs,
    )
    relay.waiting.set(seq, { resolve, timer })
    try {
      worker.postMessage({
        fxmPluginWorker: 1,
        seq,
        message: input,
        maxChars: options.maxReplyChars,
      })
    } catch {
      stop(failed('bad-request', 'The message could not be handed to the plugin'))
    }
  })
}

/** The relay's source text, sent to every plugin's document. */
const RELAY_SOURCE = String(pluginRelay)

/** The worker's script, the same for every plugin. */
const WORKER_SCRIPT = JSON.stringify(pluginWorkerScript())

/**
 * The script the host hands `Evaluator.evaluate` for a plugin: the relay, applied to the
 * evaluator's `args` (the host's message), to the worker's script, to the plugin's code, to `key`
 * and to `options`. The plugin's code is only text here, never compiled in the document. `key`
 * names the plugin's version and runner (see {@link pluginRelay}).
 */
export function pluginSource(code: string, key: string, options: RelayOptions): string {
  const values = [JSON.stringify(code), JSON.stringify(key), JSON.stringify(options)]
  return [
    "'use strict';",
    `return (${RELAY_SOURCE})(args, ${WORKER_SCRIPT}, ${values.join(', ')});`,
  ].join('\n')
}
