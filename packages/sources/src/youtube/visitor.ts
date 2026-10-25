/**
 * visitorData, YouTube's guest session ID, which InnerTube requests carry in
 * `context.client.visitorData`. FXM only ever uses one that YouTube issued: locally generated
 * sessions hit bot checks in 3 of 4 tries (research memo, section 4.1), server-issued ones in
 * none.
 *
 * - **`full` tier:** read from `https://www.youtube.com/sw.js_data`, which only a platform that
 *   reads any YouTube response can do (FXM Connect, the desktop and Android apps, Node).
 * - **`simple` tier,** or when `sw.js_data` cannot be read: the first InnerTube request goes
 *   without one, and the `responseContext.visitorData` that YouTube issues in its answer is used
 *   from then on. Requests that start meanwhile wait for it, so a device keeps one session.
 *
 * The value is cached in memory, and a {@link VisitorDataStore} can persist it, e.g. in
 * IndexedDB, so that a reload keeps the session. A bot check drops it, and the next request
 * gets a fresh one.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from '../shared'
import { at } from './json'

/** Where a visitorData can be kept between sessions, e.g. IndexedDB or app storage. */
export interface VisitorDataStore {
  /** The visitorData saved earlier, if any. */
  load(): string | undefined | Promise<string | undefined>
  /** Keeps a newly issued visitorData. */
  save(visitorData: string): void | Promise<void>
  /** Forgets it, after a bot check. */
  clear(): void | Promise<void>
}

/** What a visitorData looks like: URL-safe base64, possibly percent-encoded. */
const VISITOR_DATA = /^[A-Za-z0-9_%=+/-]{16,1024}$/u

/** Whether `value` looks like a visitorData. */
export function isVisitorData(value: unknown): value is string {
  return typeof value === 'string' && VISITOR_DATA.test(value)
}

/** The prefix that guards YouTube's JSPB responses against being run as script. */
const JSPB_GUARD = ")]}'"

/**
 * The visitorData in a `sw.js_data` response: YouTube's JSPB array, behind its `)]}'` guard, with
 * the device info at `[0][2][0][0]` and the visitorData at index 13 of it.
 *
 * @throws FxmError `Parse` when the text does not have that shape.
 */
export function parseSwJsData(text: string): string {
  if (!text.startsWith(JSPB_GUARD)) throw new FxmError('Parse', 'sw.js_data lacks its JSPB guard')
  let data: unknown
  try {
    data = JSON.parse(text.slice(JSPB_GUARD.length))
  } catch (error) {
    throw new FxmError('Parse', 'sw.js_data is not JSON', { cause: error })
  }
  const visitorData = at(data, 0, 2, 0, 0, 13)
  if (!isVisitorData(visitorData)) throw new FxmError('Parse', 'sw.js_data has no visitorData')
  return visitorData
}

/** The visitorData for one request, and how to report back what its response issued. */
export interface VisitorLease {
  /** The visitorData to send, or `undefined` for the request that asks YouTube for one. */
  readonly visitorData: string | undefined
  /**
   * Called once the request finished, with the `responseContext.visitorData` YouTube sent, if
   * any. Required for a lease without a visitorData, so that waiting requests go on.
   */
  end(issued?: unknown): void
}

/** A promise with its resolve function, for requests that wait for the first answer. */
interface Gate {
  readonly promise: Promise<void>
  readonly open: () => void
}

function gate(): Gate {
  let open = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const NO_END = (): void => {}

/**
 * Waits for `promise`, unless `signal` aborts first, in which case it rejects with the signal's
 * reason. The promise itself goes on, for the other requests that share it.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Holds one device's visitorData. See the module documentation. */
export class VisitorData {
  #value: string | undefined
  #loaded: Promise<void> | undefined
  #fromServiceWorker: Promise<string | undefined> | undefined
  #serviceWorkerFailed = false
  #firstAnswer: Gate | undefined
  readonly #store: VisitorDataStore | undefined
  readonly #swJsDataUrl: string
  readonly #timeoutMs: number

  /**
   * @param swJsDataUrl Where to read one in the `full` tier.
   * @param store Where to persist it, if anywhere.
   * @param timeoutMs How long the `sw.js_data` request may take.
   */
  constructor(swJsDataUrl: string, store?: VisitorDataStore, timeoutMs = 15_000) {
    this.#swJsDataUrl = swJsDataUrl
    this.#store = store
    this.#timeoutMs = timeoutMs
  }

  /** The visitorData in use, if there is one yet. */
  get current(): string | undefined {
    return this.#value
  }

  /**
   * The visitorData for a request: the cached or stored one; in the `full` tier one read from
   * `sw.js_data`; otherwise none, for the one request that asks YouTube for it, while other
   * requests wait for its answer.
   */
  async lease(ctx: ProviderContext): Promise<VisitorLease> {
    await abortable(this.#load(), ctx.signal)
    if (this.#value !== undefined) return { visitorData: this.#value, end: NO_END }
    if (ctx.capabilities.youtube === 'full' && !this.#serviceWorkerFailed) {
      const fetched = await abortable(this.#readServiceWorkerData(ctx), ctx.signal)
      if (fetched !== undefined) return { visitorData: fetched, end: NO_END }
    }
    while (this.#firstAnswer !== undefined) {
      await abortable(this.#firstAnswer.promise, ctx.signal)
      if (this.#value !== undefined) return { visitorData: this.#value, end: NO_END }
    }
    const first = gate()
    this.#firstAnswer = first
    let ended = false
    return {
      visitorData: undefined,
      end: (issued) => {
        if (ended) return
        ended = true
        if (this.#value === undefined && isVisitorData(issued)) this.#keep(issued)
        if (this.#firstAnswer === first) this.#firstAnswer = undefined
        first.open()
      },
    }
  }

  /** Forgets the visitorData, e.g. after a bot check, so the next request gets a fresh one. */
  invalidate(): void {
    this.#value = undefined
    this.#serviceWorkerFailed = false
    void this.#quietly(() => this.#store?.clear())
  }

  #keep(value: string): void {
    this.#value = value
    void this.#quietly(() => this.#store?.save(value))
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#quietly(async () => {
      const stored = await this.#store?.load()
      if (this.#value === undefined && isVisitorData(stored)) this.#value = stored
    })
    return this.#loaded
  }

  /**
   * One `sw.js_data` request at a time, shared by every request that needs it, so it runs
   * without any one caller's signal, only with a timeout. `undefined` when it cannot be read or
   * parsed: FXM then asks InnerTube instead, and stops trying `sw.js_data` until `invalidate`.
   */
  #readServiceWorkerData(ctx: ProviderContext): Promise<string | undefined> {
    if (this.#fromServiceWorker === undefined) {
      const pending = this.#fetchServiceWorkerData(ctx).finally(() => {
        if (this.#fromServiceWorker === pending) this.#fromServiceWorker = undefined
      })
      this.#fromServiceWorker = pending
    }
    return this.#fromServiceWorker
  }

  async #fetchServiceWorkerData(ctx: ProviderContext): Promise<string | undefined> {
    try {
      const response = await fetchWithTimeout(ctx.fetch, this.#swJsDataUrl, {
        method: 'GET',
        credentials: 'omit',
        timeoutMs: this.#timeoutMs,
      })
      if (!response.ok) throw new FxmError('Network', `sw.js_data: HTTP ${response.status}`)
      const visitorData = parseSwJsData(await response.text())
      if (this.#value === undefined) this.#keep(visitorData)
      return this.#value
    } catch {
      this.#serviceWorkerFailed = true
      return undefined
    }
  }

  /** Runs a store operation; a store that fails only costs the persistence. */
  async #quietly(action: () => unknown): Promise<void> {
    try {
      await action()
    } catch {
      // The value stays in memory.
    }
  }
}
