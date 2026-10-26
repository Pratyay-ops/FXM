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
 *   from then on. Requests that start meanwhile wait for it, so a device keeps one session. They
 *   wait at most one request timeout: when the first request seems stuck, the next one asks too.
 *
 * The value is cached in memory, and a {@link VisitorDataStore} can persist it, e.g. in
 * IndexedDB, so that a reload keeps the session. A bot check drops it, and the next request
 * gets a fresh one.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { fetchText, untilAborted, within } from './http'
import { at } from './json'

/** Where a visitorData can be kept between sessions, e.g. IndexedDB or app storage. */
export interface VisitorDataStore {
  /**
   * The visitorData saved earlier, if any. FXM waits for it at most
   * {@link STORE_LOAD_TIMEOUT_MS} and goes on without it after that.
   */
  load(): string | undefined | Promise<string | undefined>
  /** Keeps a newly issued visitorData. */
  save(visitorData: string): void | Promise<void>
  /** Forgets it, after a bot check. */
  clear(): void | Promise<void>
}

/** How long FXM waits for {@link VisitorDataStore.load}, in milliseconds. */
export const STORE_LOAD_TIMEOUT_MS = 1500

/**
 * A device's visitorData as its YouTube session shows it: the value in use, and a way to drop
 * it. Requests take it through the session; nothing else needs more.
 */
export interface YouTubeVisitorData {
  /** The visitorData in use, if there is one yet. */
  readonly current: string | undefined
  /**
   * Forgets it, so that the next request gets a fresh one, e.g. from a "Reset YouTube session"
   * setting. The session's own requests already do this after every bot check they meet.
   */
  invalidate(): void
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

/**
 * The visitorData for one request, and how to report back what its response issued. Every lease
 * must be ended, in a `finally`: until a lease without a visitorData ends, the requests that
 * start meanwhile wait for its answer (at most one request timeout).
 */
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

function held(visitorData: string): VisitorLease {
  return { visitorData, end: () => {} }
}

/** Holds one device's visitorData. See the module documentation. */
export class VisitorData implements YouTubeVisitorData {
  #value: string | undefined
  #loaded: Promise<void> | undefined
  #fromServiceWorker: Promise<string | undefined> | undefined
  #serviceWorkerFailed = false
  #firstAnswer: Gate | undefined
  readonly #store: VisitorDataStore | undefined
  readonly #swJsDataUrl: string
  readonly #timeoutMs: number
  readonly #storeTimeoutMs: number

  /**
   * @param swJsDataUrl Where to read one in the `full` tier.
   * @param store Where to persist it, if anywhere.
   * @param timeoutMs How long one request may take: the `sw.js_data` request, and the longest
   * wait for the first answer.
   * @param storeTimeoutMs How long to wait for the store's saved value.
   */
  constructor(
    swJsDataUrl: string,
    store?: VisitorDataStore,
    timeoutMs = 15_000,
    storeTimeoutMs = STORE_LOAD_TIMEOUT_MS,
  ) {
    this.#swJsDataUrl = swJsDataUrl
    this.#store = store
    this.#timeoutMs = timeoutMs
    this.#storeTimeoutMs = storeTimeoutMs
  }

  /** The visitorData in use, if there is one yet. */
  get current(): string | undefined {
    return this.#value
  }

  /**
   * The visitorData for a request: the cached or stored one; in the `full` tier one read from
   * `sw.js_data`; otherwise none, for the one request that asks YouTube for it, while other
   * requests wait for its answer. End the lease when the request is done (see
   * {@link VisitorLease}).
   */
  async lease(ctx: ProviderContext): Promise<VisitorLease> {
    await untilAborted(this.#load(), ctx.signal)
    if (this.#value !== undefined) return held(this.#value)
    if (ctx.capabilities.youtube === 'full' && !this.#serviceWorkerFailed) {
      const fetched = await untilAborted(this.#readServiceWorkerData(ctx), ctx.signal)
      if (fetched !== undefined) return held(fetched)
    }
    let waiting = this.#firstAnswer
    while (waiting !== undefined) {
      const opened = waiting.promise.then(() => true)
      const answered = await untilAborted(within(opened, this.#timeoutMs, false), ctx.signal)
      if (this.#value !== undefined) return held(this.#value)
      // The request that asks for one seems stuck, e.g. on a transport that ignores aborts:
      // this one asks as well.
      if (!answered) break
      waiting = this.#firstAnswer
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

  /**
   * Forgets the visitorData, e.g. after a bot check, so the next request gets a fresh one.
   *
   * @param sent The visitorData that the bot-checked request sent. When it is given and no
   * longer the one in use, a newer one has replaced it, which is kept.
   */
  invalidate(sent?: string): void {
    if (sent !== undefined && this.#value !== sent) return
    this.#value = undefined
    this.#serviceWorkerFailed = false
    void this.#quietly(() => this.#store?.clear())
  }

  #keep(value: string): void {
    this.#value = value
    void this.#quietly(() => this.#store?.save(value))
  }

  /** Reads the stored value once, waiting for the store at most its timeout. */
  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      const stored = await within(this.#loadStored(), this.#storeTimeoutMs, undefined)
      if (this.#value === undefined && isVisitorData(stored)) this.#value = stored
    })()
    return this.#loaded
  }

  async #loadStored(): Promise<unknown> {
    return this.#store === undefined ? undefined : await this.#store.load()
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
      const { response, text } = await fetchText(
        ctx.fetch,
        this.#swJsDataUrl,
        { method: 'GET', credentials: 'omit' },
        this.#timeoutMs,
      )
      if (!response.ok) throw new FxmError('Network', `sw.js_data: HTTP ${response.status}`)
      const visitorData = parseSwJsData(text)
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
