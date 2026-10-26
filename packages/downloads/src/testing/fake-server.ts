/**
 * A media server that lives in memory: a `fetch` that answers single-range GETs the way
 * googlevideo, Internet Archive and other file hosts do, and misbehaves on request.
 *
 * @module
 */

/** One file the server holds. */
export interface FakeMediaFile {
  /** The file's bytes. */
  bytes: Uint8Array<ArrayBuffer>
  /** Its `Content-Type`. Default: `audio/webm`. */
  contentType?: string
  /** Its `Last-Modified` header, if any. */
  lastModified?: string
}

/** How the server misbehaves for one URL. Every rule is off by default. */
export interface FakeMediaRules {
  /** Answer 403 to every range that reaches this byte or beyond: a capped YouTube URL. */
  capAt?: number
  /** Answer this status to every request, e.g. 403, 410, 500 or 429. */
  status?: number
  /** With `status`: answer it to this many requests only, then serve the file again. */
  statusTimes?: number
  /** With `status` 429 or 503: the `Retry-After` header, in seconds. */
  retryAfterSeconds?: number
  /**
   * Reject this many of the next requests without an answer: a dropped connection or, on the
   * web, the CORS failure a googlevideo redirect to another host causes.
   */
  dropRequests?: number
  /** Ignore `Range` and answer 200 with the whole file. */
  ignoreRange?: boolean
  /** Leave `Content-Range` out of the answers, like a server that doesn't expose it to pages. */
  hideContentRange?: boolean
  /** Leave `Content-Length` out of the answers too. */
  hideContentLength?: boolean
  /** Break the next answer's body off once this many bytes of the file have been sent. */
  breakAt?: number
  /** Break every answer's body off after this many of its bytes: a flaky connection. */
  breakEvery?: number
  /**
   * Say the file has this many bytes in `Content-Range` (of `206` and `416` answers) whatever it
   * holds: a server that announces a far larger file.
   */
  claimSize?: number
  /**
   * Hold the next answer's body once this many bytes of the file have been sent, until
   * {@link FakeMediaServer.release} (or an abort).
   */
  holdAt?: number
  /** Answer a page (`text/html`) instead of the file. */
  page?: boolean
}

/** One request the server received. */
export interface FakeMediaRequest {
  /** The URL. */
  url: string
  /** The `Range` header, if any. */
  range: string | null
  /** The status it answered, or `undefined` when it dropped the request. */
  status?: number
}

/** Options for {@link FakeMediaServer}. */
export interface FakeMediaServerOptions {
  /** The size of the pieces each body arrives in. Default: 64 KiB. */
  pieceBytes?: number
}

/** `count` predictable bytes: byte `i` is `(i * 7 + seed) % 251`. */
export function testBytes(count: number, seed = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(count)
  for (let index = 0; index < count; index += 1) bytes[index] = (index * 7 + seed) % 251
  return bytes
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * A scriptable media server. `server.fetch` is the `fetch` to inject (as `ProviderContext.fetch`):
 * it answers the files added with {@link add}, honours single ranges (`bytes=a-b`, `bytes=a-`)
 * with `206`, `Content-Range` and `Content-Length`, answers `416` to a range past the end, `404`
 * for unknown URLs, and follows the {@link FakeMediaRules} set per URL. Bodies stream in pieces
 * and stop when the request's signal aborts.
 */
export class FakeMediaServer {
  /** The files, by URL. */
  readonly files = new Map<string, FakeMediaFile>()
  /** The rules, by URL. */
  readonly rules = new Map<string, FakeMediaRules>()
  /** Every request, in order. */
  readonly requests: FakeMediaRequest[] = []
  readonly #pieceBytes: number
  readonly #held = new Map<string, () => void>()

  constructor(options: FakeMediaServerOptions = {}) {
    this.#pieceBytes = options.pieceBytes ?? 64 * 1024
  }

  /** Serves `file` (or its bytes) at `url`. */
  add(url: string, file: FakeMediaFile | Uint8Array<ArrayBuffer>): void {
    this.files.set(url, file instanceof Uint8Array ? { bytes: file } : file)
  }

  /** Adds rules for `url`, on top of its others. */
  rule(url: string, rules: FakeMediaRules): void {
    this.rules.set(url, { ...this.rules.get(url), ...rules })
  }

  /** Removes every rule for `url`. */
  clearRules(url: string): void {
    this.rules.delete(url)
  }

  /** Lets a body held by `holdAt` go on. */
  release(url: string): void {
    this.#held.get(url)?.()
    this.#held.delete(url)
  }

  /** The `Range` headers of the requests for `url`, in order. */
  rangesFor(url: string): (string | null)[] {
    return this.requests.filter((request) => request.url === url).map((request) => request.range)
  }

  /** The `fetch` to inject. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = urlOf(input)
    const signal = init?.signal ?? undefined
    signal?.throwIfAborted()
    const range = header(init, 'range')
    const request: FakeMediaRequest = { url, range }
    this.requests.push(request)
    const rules = this.rules.get(url) ?? {}
    if (rules.dropRequests !== undefined && rules.dropRequests > 0) {
      this.rule(url, { dropRequests: rules.dropRequests - 1 })
      throw new TypeError('Failed to fetch')
    }
    const answer = (status: number, body: BodyInit | null, headers: Record<string, string>) => {
      request.status = status
      return new Response(body, { status, headers })
    }
    if (rules.status !== undefined) {
      if (rules.statusTimes !== undefined) {
        const { status: _status, statusTimes: _times, ...rest } = rules
        this.rules.set(
          url,
          rules.statusTimes > 1 ? { ...rules, statusTimes: rules.statusTimes - 1 } : rest,
        )
      }
      const headers: Record<string, string> = {}
      if (rules.retryAfterSeconds !== undefined) {
        headers['Retry-After'] = String(rules.retryAfterSeconds)
      }
      return answer(rules.status, null, headers)
    }
    const file = this.files.get(url)
    if (file === undefined) return answer(404, null, {})
    if (rules.page === true) return answer(200, '<html></html>', { 'Content-Type': 'text/html' })
    const size = file.bytes.length
    let start = 0
    let end = size - 1
    let partial = false
    const match = range === null ? null : /^bytes=(\d+)-(\d*)$/.exec(range)
    if (match !== null && rules.ignoreRange !== true) {
      start = Number(match[1])
      end =
        match[2] === '' || match[2] === undefined ? size - 1 : Math.min(Number(match[2]), size - 1)
      partial = true
      if (start >= size) {
        const hidden = rules.hideContentRange === true
        const claimed = rules.claimSize ?? size
        return answer(416, null, hidden ? {} : { 'Content-Range': `bytes */${claimed}` })
      }
    }
    if (rules.capAt !== undefined && end >= rules.capAt) return answer(403, null, {})
    const headers: Record<string, string> = { 'Content-Type': file.contentType ?? 'audio/webm' }
    if (file.lastModified !== undefined) headers['Last-Modified'] = file.lastModified
    if (rules.hideContentLength !== true) headers['Content-Length'] = String(end - start + 1)
    if (partial && rules.hideContentRange !== true) {
      headers['Content-Range'] = `bytes ${start}-${end}/${rules.claimSize ?? size}`
    }
    const body = this.#body(url, file.bytes, start, end + 1, rules, signal)
    return answer(partial ? 206 : 200, body, headers)
  }

  /** Drops a one-time rule once it took effect. */
  #consume(url: string, rule: 'breakAt' | 'holdAt'): void {
    const rules = this.rules.get(url)
    if (rules === undefined) return
    const { [rule]: _used, ...rest } = rules
    this.rules.set(url, rest)
  }

  #body(
    url: string,
    bytes: Uint8Array,
    from: number,
    to: number,
    rules: FakeMediaRules,
    signal: AbortSignal | undefined,
  ): ReadableStream<Uint8Array> {
    const within = (position: number | undefined) =>
      position !== undefined && position >= from && position < to ? position : undefined
    // One-time rules apply to the answer whose bytes reach their position.
    const once = within(rules.breakAt)
    const every = rules.breakEvery === undefined ? undefined : within(from + rules.breakEvery)
    const breakAt = once === undefined ? every : every === undefined ? once : Math.min(once, every)
    let holdAt = within(rules.holdAt)
    let hold: Promise<void> | undefined
    if (holdAt !== undefined) {
      hold = new Promise((resolve) => this.#held.set(url, resolve))
      this.#consume(url, 'holdAt')
    }
    if (once !== undefined) this.#consume(url, 'breakAt')
    const pieceBytes = this.#pieceBytes
    let at = from
    let stopped = false
    return new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          'abort',
          () => {
            if (stopped) return
            stopped = true
            controller.error(signal.reason)
          },
          { once: true },
        )
      },
      async pull(controller) {
        if (stopped) return
        if (hold !== undefined && holdAt !== undefined && at >= holdAt) {
          await hold
          hold = undefined
          holdAt = undefined
          if (stopped) return
        }
        if (breakAt !== undefined && at >= breakAt) {
          stopped = true
          controller.error(new TypeError('The connection was reset'))
          return
        }
        if (at >= to) {
          stopped = true
          controller.close()
          return
        }
        let end = Math.min(at + pieceBytes, to)
        if (breakAt !== undefined && breakAt > at) end = Math.min(end, breakAt)
        if (holdAt !== undefined && holdAt > at) end = Math.min(end, holdAt)
        controller.enqueue(bytes.slice(at, end))
        at = end
      },
      cancel() {
        stopped = true
      },
    })
  }
}
