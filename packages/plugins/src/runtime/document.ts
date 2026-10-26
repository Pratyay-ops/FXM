/**
 * The plugin runtime: what runs inside the isolated evaluator document next to a plugin's code.
 * It loads the plugin, runs its handlers, gives them `ctx.fetch`, and speaks the plugin protocol
 * of `protocol.ts` with the host. It reaches nothing itself: the document's policy allows no
 * network (`connect-src 'none'`), and every request a handler makes is handed to the host, which
 * decides.
 *
 * **Self-contained.** The host sends this function's source text to the document
 * ({@link pluginSource}), so it must not use anything from outside its own body: no imports, no
 * module constants, no helpers. Types are fine, since they are gone from the text. Keep its
 * syntax to what the evaluator's webviews run unchanged (ES2022). `document.test.ts` runs the
 * text in a fresh realm to keep it so.
 *
 * ## What a plugin sees
 *
 * The plugin's code is the body of a function of `fxm`, in strict mode. It calls
 * `fxm.register(handlers)` once (or returns the handlers), with one async function per
 * operation its manifest `provides`. Each handler gets the operation's parameters, then `ctx`:
 *
 * - `ctx.fetch(url, { method, headers, body })`: a `Response` once the host fetched it, from a
 *   host the manifest declares, within the plugin's request budget. Bodies are text only.
 * - `ctx.mode` (`music` or `all`), `ctx.platform`, `ctx.locale`, `ctx.region`.
 * - `ctx.signal`: aborts when FXM gives up on the call.
 *
 * `fxm.fail(code, message, { retryAfterMs })` throws an error that FXM reports with that
 * `FxmError` code, such as `NotFound`.
 *
 * @module
 */

/** A plugin's code, as the function of `fxm` that {@link pluginSource} wraps it in. */
export type PluginFactory = (fxm: unknown) => unknown

// The shapes the runtime works with. Types only: they vanish from the source text.

interface Failure {
  code: string
  message: string
  fxmCode?: string
  retryAfterMs?: number
}

interface Reply {
  fxmPluginReply: 1
  state: 'done' | 'failed' | 'fetch' | 'idle' | 'cancelled'
  value?: unknown
  error?: Failure
  requests?: unknown[]
}

interface Waiter {
  resolve(value: unknown): void
  reject(reason: unknown): void
}

interface Call {
  id: string
  outbox: unknown[]
  pending: Map<number, Waiter>
  nextFetch: number
  settled: Omit<Reply, 'fxmPluginReply'> | undefined
  wake: (() => void) | undefined
  controller: AbortController
}

interface PluginState {
  loaded: boolean
  handlers: Record<string, unknown> | undefined
  failure: Failure | undefined
  calls: Map<string, Call>
}

interface Message {
  fxmPlugin?: unknown
  op?: unknown
  call?: unknown
  method?: unknown
  params?: unknown
  context?: unknown
  responses?: unknown
  stepMs?: unknown
}

/**
 * Handles one message of the host, as `Evaluator.evaluate` passes it (`args`), for the plugin
 * whose code is `factory`. `key` names the plugin and its version; the runtime keeps its state
 * per key on the document's global object, so a new version starts afresh. A document runs at
 * most 32 calls at once, and answers `idle` after the message's `stepMs` (10 ms to 15 s, 10 s
 * when it names none).
 */
export function pluginRuntime(input: unknown, factory: PluginFactory, key: string): Promise<Reply> {
  const global = globalThis as unknown as Record<symbol, unknown>
  const slot = Symbol.for('fxm.plugins.runtime')
  let plugins = global[slot] as Map<string, PluginState> | undefined
  if (!(plugins instanceof Map)) {
    plugins = new Map()
    Object.defineProperty(global, slot, { value: plugins, configurable: false, writable: false })
  }
  let state = plugins.get(key)
  if (state === undefined) {
    state = { loaded: false, handlers: undefined, failure: undefined, calls: new Map() }
    plugins.set(key, state)
  }
  const plugin: PluginState = state

  function reply(body: Omit<Reply, 'fxmPluginReply'>): Reply {
    return { fxmPluginReply: 1, ...body }
  }

  function text(value: unknown, max: number): string {
    return String(value).replace(/\s+/gu, ' ').trim().slice(0, max)
  }

  /** What a thrown value says, for the host. */
  function describe(error: unknown, code: string): Failure {
    const failure: Failure = { code, message: '' }
    if (typeof error === 'object' && error !== null) {
      const thrown = error as { name?: unknown; message?: unknown; fxmCode?: unknown }
      const name = typeof thrown.name === 'string' ? thrown.name : 'Error'
      failure.message = text(
        typeof thrown.message === 'string' ? `${name}: ${thrown.message}` : name,
        300,
      )
      if (typeof thrown.fxmCode === 'string') failure.fxmCode = text(thrown.fxmCode, 40)
      const retry = (error as { retryAfterMs?: unknown }).retryAfterMs
      if (typeof retry === 'number' && Number.isFinite(retry) && retry >= 0) {
        failure.retryAfterMs = retry
      }
    } else {
      failure.message = text(error, 300)
    }
    return failure
  }

  /** An error with an `FxmError` code, as `fxm.fail` and failed requests throw. */
  function codedError(
    message: string,
    fxmCode: string,
    extra: { code?: string; retryAfterMs?: number },
  ): Error {
    const error = new Error(message) as Error & Record<string, unknown>
    error.name = 'FxmPluginError'
    error.fxmCode = fxmCode
    if (extra.code !== undefined) error.code = extra.code
    if (extra.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs
    return error
  }

  function load(): void {
    if (plugin.loaded) return
    plugin.loaded = true
    let registered: Record<string, unknown> | undefined
    const fxm = Object.freeze({
      api: 1,
      register(handlers: unknown) {
        if (registered !== undefined) throw new Error('fxm.register was called twice')
        if (typeof handlers !== 'object' || handlers === null) {
          throw new TypeError('fxm.register needs an object of handlers')
        }
        registered = handlers as Record<string, unknown>
      },
      fail(code: unknown, message?: unknown, options?: { retryAfterMs?: unknown }): never {
        const retry = options?.retryAfterMs
        throw codedError(text(message ?? code, 300), text(code, 40), {
          ...(typeof retry === 'number' && Number.isFinite(retry) && retry >= 0
            ? { retryAfterMs: retry }
            : {}),
        })
      },
    })
    try {
      const returned = factory.call(undefined, fxm)
      if (registered === undefined && typeof returned === 'object' && returned !== null) {
        registered = returned as Record<string, unknown>
      }
      if (registered === undefined) throw new Error('The plugin registered no handlers')
      plugin.handlers = registered
    } catch (error) {
      plugin.failure = describe(error, 'load-failed')
    }
  }

  function wake(call: Call): void {
    const waiting = call.wake
    call.wake = undefined
    waiting?.()
  }

  function settle(call: Call, outcome: Omit<Reply, 'fxmPluginReply'>): void {
    if (call.settled !== undefined) return
    call.settled = outcome
    wake(call)
  }

  /** The value as JSON data, or a `not-json` failure. */
  function asJson(value: unknown): Omit<Reply, 'fxmPluginReply'> {
    try {
      const json = JSON.stringify(value === undefined ? null : value)
      return { state: 'done', value: json === undefined ? null : JSON.parse(json) }
    } catch (error) {
      return { state: 'failed', error: describe(error, 'not-json') }
    }
  }

  /** Request headers as pairs, from a plain object, a list of pairs or a `Headers`. */
  function headerPairs(headers: unknown): [string, string][] {
    const pairs: [string, string][] = []
    if (headers === undefined || headers === null) return pairs
    const asHeaders = headers as { forEach?: unknown; get?: unknown }
    if (typeof asHeaders.forEach === 'function' && typeof asHeaders.get === 'function') {
      ;(headers as Headers).forEach((value, name) => {
        pairs.push([String(name), String(value)])
      })
      return pairs
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) pairs.push([String(pair?.[0]), String(pair?.[1])])
      return pairs
    }
    if (typeof headers === 'object') {
      for (const name of Object.keys(headers)) {
        pairs.push([name, String((headers as Record<string, unknown>)[name])])
      }
    }
    return pairs
  }

  function pluginFetch(call: Call, input: unknown, init: unknown): Promise<unknown> {
    if (call.settled !== undefined || call.controller.signal.aborted) {
      return Promise.reject(codedError('The call has ended', 'Unavailable', {}))
    }
    const options = (typeof init === 'object' && init !== null ? init : {}) as {
      method?: unknown
      headers?: unknown
      body?: unknown
    }
    if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') {
      return Promise.reject(new TypeError('ctx.fetch sends text bodies only'))
    }
    const link = input as { href?: unknown; url?: unknown } | null
    const url =
      typeof input === 'string'
        ? input
        : typeof link?.href === 'string'
          ? link.href
          : typeof link?.url === 'string'
            ? link.url
            : String(input)
    const id = call.nextFetch
    call.nextFetch += 1
    const request: Record<string, unknown> = {
      id,
      url,
      method: typeof options.method === 'string' ? options.method.toUpperCase() : 'GET',
      headers: headerPairs(options.headers),
    }
    if (typeof options.body === 'string') request.body = options.body
    return new Promise((resolve, reject) => {
      call.pending.set(id, { resolve, reject })
      call.outbox.push(request)
      wake(call)
    })
  }

  /**
   * Waits until the call settles, asks for requests (collecting every request made in the same
   * turn), or `stepMs` passes, and answers accordingly.
   */
  function step(call: Call, stepMs: number): Promise<Reply> {
    return new Promise((resolve) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (body: Omit<Reply, 'fxmPluginReply'>) => {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        call.wake = undefined
        if (call.settled !== undefined) plugin.calls.delete(call.id)
        resolve(reply(body))
      }
      const check = () => {
        if (call.settled !== undefined) {
          finish(call.settled)
          return
        }
        if (call.outbox.length > 0) {
          // Requests made in the same turn, such as those of a Promise.all, go together.
          setTimeout(() => {
            if (call.settled !== undefined) finish(call.settled)
            else finish({ state: 'fetch', requests: call.outbox.splice(0) })
          }, 0)
          return
        }
        call.wake = check
      }
      timer = setTimeout(() => finish({ state: 'idle' }), stepMs)
      check()
    })
  }

  function stepTime(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(15_000, Math.max(10, value))
      : 10_000
  }

  function start(message: Message): Promise<Reply> {
    if (typeof message.call !== 'string' || typeof message.method !== 'string') {
      return Promise.resolve(
        reply({ state: 'failed', error: { code: 'bad-request', message: 'Malformed call' } }),
      )
    }
    load()
    if (plugin.failure !== undefined) {
      return Promise.resolve(reply({ state: 'failed', error: plugin.failure }))
    }
    const handlers = plugin.handlers ?? {}
    // The host asks only for the operations of PLUGIN_OPERATIONS, none of which is a name that
    // every object inherits, so a class instance's methods count as well as an object's own.
    const handler = handlers[message.method]
    if (typeof handler !== 'function') {
      return Promise.resolve(
        reply({
          state: 'failed',
          error: {
            code: 'not-implemented',
            message: `The plugin has no handler for ${text(message.method, 40)}`,
          },
        }),
      )
    }
    if (plugin.calls.size >= 32) {
      return Promise.resolve(
        reply({ state: 'failed', error: { code: 'busy', message: 'Too many calls at once' } }),
      )
    }
    const call: Call = {
      id: message.call,
      outbox: [],
      pending: new Map(),
      nextFetch: 1,
      settled: undefined,
      wake: undefined,
      controller: new AbortController(),
    }
    plugin.calls.set(call.id, call)
    const context = (
      typeof message.context === 'object' && message.context !== null ? message.context : {}
    ) as Record<string, unknown>
    const ctx = Object.freeze({
      mode: context.mode,
      platform: context.platform,
      ...(typeof context.locale === 'string' ? { locale: context.locale } : {}),
      ...(typeof context.region === 'string' ? { region: context.region } : {}),
      signal: call.controller.signal,
      fetch: (input: unknown, init?: unknown) => pluginFetch(call, input, init),
    })
    const params = Array.isArray(message.params) ? message.params : []
    Promise.resolve()
      .then(() => (handler as (...args: unknown[]) => unknown).apply(handlers, [...params, ctx]))
      .then(
        (value) => settle(call, asJson(value)),
        (error: unknown) =>
          settle(call, { state: 'failed', error: describe(error, 'plugin-failed') }),
      )
    return step(call, stepTime(message.stepMs))
  }

  function resume(message: Message): Promise<Reply> {
    const call = typeof message.call === 'string' ? plugin.calls.get(message.call) : undefined
    if (call === undefined) {
      return Promise.resolve(
        reply({ state: 'failed', error: { code: 'unknown-call', message: 'The call is gone' } }),
      )
    }
    const responses = Array.isArray(message.responses) ? message.responses : []
    for (const raw of responses) {
      const response = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
        string,
        unknown
      >
      const id = typeof response.id === 'number' ? response.id : -1
      const waiter = call.pending.get(id)
      if (waiter === undefined) continue
      call.pending.delete(id)
      if (response.ok === true) {
        const status = typeof response.status === 'number' ? response.status : 200
        const empty = status === 204 || status === 205 || status === 304
        try {
          const made = new Response(empty ? null : String(response.body ?? ''), {
            status,
            statusText: typeof response.statusText === 'string' ? response.statusText : '',
            headers: Array.isArray(response.headers)
              ? (response.headers as [string, string][])
              : [],
          })
          Object.defineProperty(made, 'url', {
            value: typeof response.url === 'string' ? response.url : '',
          })
          waiter.resolve(made)
        } catch (error) {
          waiter.reject(error)
        }
      } else {
        const failure = (
          typeof response.error === 'object' && response.error !== null ? response.error : {}
        ) as Record<string, unknown>
        const retry = failure.retryAfterMs
        waiter.reject(
          codedError(
            text(failure.message ?? 'The request failed', 300),
            typeof failure.fxmCode === 'string' ? failure.fxmCode : 'Network',
            {
              code: typeof failure.code === 'string' ? failure.code : 'Network',
              ...(typeof retry === 'number' ? { retryAfterMs: retry } : {}),
            },
          ),
        )
      }
    }
    return step(call, stepTime(message.stepMs))
  }

  function cancel(message: Message): Promise<Reply> {
    const call = typeof message.call === 'string' ? plugin.calls.get(message.call) : undefined
    if (call !== undefined) {
      plugin.calls.delete(call.id)
      settle(call, { state: 'cancelled' })
      call.controller.abort()
      for (const waiter of call.pending.values()) {
        waiter.reject(codedError('The call was cancelled', 'Unavailable', {}))
      }
      call.pending.clear()
    }
    return Promise.resolve(reply({ state: 'cancelled' }))
  }

  const message = (typeof input === 'object' && input !== null ? input : {}) as Message
  if (message.fxmPlugin !== 1) {
    return Promise.resolve(
      reply({ state: 'failed', error: { code: 'bad-request', message: 'Not a plugin message' } }),
    )
  }
  switch (message.op) {
    case 'call':
      return start(message)
    case 'resume':
      return resume(message)
    case 'cancel':
      return cancel(message)
    default:
      return Promise.resolve(
        reply({ state: 'failed', error: { code: 'bad-request', message: 'Unknown operation' } }),
      )
  }
}

/** The runtime's source text, sent to every document. */
const RUNTIME_SOURCE = String(pluginRuntime)

/**
 * The script the host hands `Evaluator.evaluate` for a plugin: the runtime, applied to the
 * evaluator's `args` (the host's message) and to the plugin's code wrapped in a function of
 * `fxm`. The whole script is strict. `key` names the plugin and its version (see
 * {@link pluginRuntime}).
 */
export function pluginSource(code: string, key: string): string {
  return [
    "'use strict';",
    `return (${RUNTIME_SOURCE})(args, function (fxm) {`,
    code,
    `}, ${JSON.stringify(key)});`,
  ].join('\n')
}
