/**
 * A stand-in for the browser's `Worker`, for tests in Node: it runs a worker's script, given as a
 * `blob:` URL as the plugin relay creates it, in a fresh realm of the test process (`node:vm`),
 * with a worker-like global scope (`self`, `postMessage`, message events, timers, `Response` and
 * the like, but no `fetch`). Messages cross as structured clones, asynchronously, as they do
 * between threads.
 *
 * It isolates nothing (the realm shares the test's process) and can't stop a script that loops
 * forever: `browser.test.ts` checks those in a real browser.
 *
 * @module
 */

/** Node's `vm`, without Node's types. */
interface NodeVm {
  createContext(sandbox: object): object
  runInContext(code: string, context: object, options?: { filename?: string }): unknown
}

/** Node's `buffer`, for the `Blob` behind a `blob:` URL. */
interface NodeBuffer {
  resolveObjectURL(url: string): { text(): Promise<string> } | undefined
}

type Listener = (event: { readonly data: unknown }) => void

function builtin<T>(id: string): T {
  const process = (globalThis as { process?: { getBuiltinModule?(id: string): unknown } }).process
  const module = process?.getBuiltinModule?.(id)
  if (module === undefined) throw new Error(`TestWorker needs Node's ${id}`)
  return module as T
}

/** What a worker's uncaught error looks like to its owner: an `ErrorEvent`'s fields. */
function errorEvent(error: unknown) {
  const name = (error as { name?: unknown } | null)?.name
  const message = (error as { message?: unknown } | null)?.message
  return {
    message: `Uncaught ${typeof name === 'string' ? name : 'Error'}: ${typeof message === 'string' ? message : String(error)}`,
    error,
    preventDefault() {},
  }
}

/** A `Worker` whose script runs in a fresh realm of this process. */
export class TestWorker {
  onmessage: Listener | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessageerror: ((event: unknown) => void) | null = null
  #terminated = false
  #scope: Record<string, unknown> | undefined
  readonly #inbox: unknown[] = []
  readonly #listeners = new Set<Listener>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(url: string | URL) {
    const blob = builtin<NodeBuffer>('node:buffer').resolveObjectURL(String(url))
    if (blob === undefined) throw new TypeError(`TestWorker loads blob: URLs only, not ${url}`)
    void blob.text().then((script) => this.#start(script))
  }

  /** Sends the worker a message. */
  postMessage(data: unknown): void {
    if (this.#terminated) return
    const copy = structuredClone(data)
    if (this.#scope === undefined) this.#inbox.push(copy)
    else this.#deliver(copy)
  }

  /** Stops the worker: no more messages either way, and its timers are cleared. */
  terminate(): void {
    this.#terminated = true
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
  }

  /** Runs `work` soon, unless the worker is stopped by then; its errors are the worker's. */
  #later(work: () => void, ms = 0): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      if (this.#terminated) return
      try {
        work()
      } catch (error) {
        this.#fail(error)
      }
    }, ms)
    this.#timers.add(timer)
    return timer
  }

  #fail(error: unknown): void {
    const event = errorEvent(error)
    setTimeout(() => {
      if (!this.#terminated) this.onerror?.(event)
    }, 0)
  }

  #deliver(data: unknown): void {
    this.#later(() => {
      const scope = this.#scope
      const event = { data }
      const handler = scope?.onmessage
      if (typeof handler === 'function') (handler as Listener)(event)
      for (const listener of [...this.#listeners]) listener(event)
    })
  }

  #start(script: string): void {
    if (this.#terminated) return
    const listeners = this.#listeners
    const scope: Record<string, unknown> = {
      postMessage: (data: unknown) => {
        if (this.#terminated) return
        const copy = structuredClone(data)
        setTimeout(() => {
          if (!this.#terminated) this.onmessage?.({ data: copy })
        }, 0)
      },
      addEventListener: (type: string, listener: Listener) => {
        if (type === 'message') listeners.add(listener)
      },
      removeEventListener: (type: string, listener: Listener) => {
        if (type === 'message') listeners.delete(listener)
      },
      close: () => this.terminate(),
      onmessage: null,
      setTimeout: (callback: () => void, ms?: number) => this.#later(callback, ms ?? 0),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer)
        this.#timers.delete(timer)
      },
      queueMicrotask,
      structuredClone,
      Response,
      Headers,
      Request,
      URL,
      URLSearchParams,
      Blob,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      DOMException,
      atob,
      btoa,
      crypto,
    }
    scope.self = scope
    const vm = builtin<NodeVm>('node:vm')
    try {
      vm.runInContext(script, vm.createContext(scope), { filename: 'plugin-worker.js' })
    } catch (error) {
      // A script that doesn't compile or throws at once: the worker never starts.
      const event = errorEvent(error)
      this.terminate()
      setTimeout(() => this.onerror?.(event), 0)
      return
    }
    this.#scope = scope
    for (const data of this.#inbox.splice(0)) this.#deliver(data)
  }
}

/**
 * Makes {@link TestWorker} the global `Worker` where there is none (Node, happy-dom), for the
 * plugin relay running in a test's realm. Does nothing where a real `Worker` exists.
 */
export function installTestWorker(): void {
  const global = globalThis as { Worker?: unknown }
  if (typeof global.Worker === 'function') return
  global.Worker = TestWorker
}
