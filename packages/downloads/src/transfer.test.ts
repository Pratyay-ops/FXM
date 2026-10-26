import { describe, expect, it } from 'vitest'
import { createMemoryDownloadStorage, storageFullError } from './storage'
import { FakeMediaServer, testBytes } from './testing/fake-server'
import {
  DownloadHttpError,
  DownloadNetworkError,
  DownloadProtocolError,
  parseContentRange,
  parseRetryAfter,
  type TransferOptions,
  transfer,
} from './transfer'

const URL = 'https://media.test/a'

async function setup(size = 5000, pieceBytes = 300) {
  const server = new FakeMediaServer({ pieceBytes })
  const file = testBytes(size)
  server.add(URL, { bytes: file, lastModified: 'Sun, 25 Oct 2026 10:00:00 GMT' })
  const storage = createMemoryDownloadStorage()
  const writer = await storage.open('a')
  const progress: number[] = []
  const facts: unknown[] = []
  const options = (overrides: Partial<TransferOptions> = {}): TransferOptions => ({
    fetch: server.fetch,
    url: URL,
    writer,
    start: 0,
    chunkBytes: 2048,
    writeBytes: 512,
    signal: new AbortController().signal,
    onProgress: (bytes) => progress.push(bytes),
    onFacts: (learned) => facts.push(learned),
    ...overrides,
  })
  return { server, file, storage, writer, progress, facts, options }
}

describe('transfer', () => {
  it('fetches a file in single ranges and stores every byte', async () => {
    const { server, file, storage, progress, facts, options } = await setup()
    const result = await transfer(options())
    expect(result).toEqual({
      total: 5000,
      validator: 'last-modified:Sun, 25 Oct 2026 10:00:00 GMT',
    })
    expect(storage.bytes('a')).toEqual(file)
    expect(server.rangesFor(URL)).toEqual(['bytes=0-2047', 'bytes=2048-4095', 'bytes=4096-4999'])
    expect(progress.at(-1)).toBe(5000)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(facts).toEqual([
      { validator: 'last-modified:Sun, 25 Oct 2026 10:00:00 GMT' },
      { total: 5000 },
    ])
  })

  it('continues from the bytes already stored', async () => {
    const { server, file, storage, writer, options } = await setup()
    await writer.write(0, file.slice(0, 3000))
    await transfer(options({ start: 3000, total: 5000 }))
    expect(storage.bytes('a')).toEqual(file)
    expect(server.rangesFor(URL)).toEqual(['bytes=3000-4999'])
  })

  it('returns at once when the stored file is complete', async () => {
    const { server, options } = await setup()
    expect(await transfer(options({ start: 5000, total: 5000 }))).toEqual({ total: 5000 })
    expect(server.requests).toHaveLength(0)
  })

  it('finds the end without Content-Range: the 416 after a short chunk', async () => {
    const { server, file, storage, options } = await setup()
    server.rule(URL, { hideContentRange: true, hideContentLength: true })
    const result = await transfer(options())
    expect(result.total).toBe(5000)
    expect(storage.bytes('a')).toEqual(file)
    expect(server.rangesFor(URL)).toEqual([
      'bytes=0-2047',
      'bytes=2048-4095',
      'bytes=4096-6143',
      'bytes=5000-7047',
    ])
  })

  it('gets the rest from a server that caps its answers and hides Content-Range', async () => {
    const { server, file, storage, options } = await setup()
    // Every answer stops after 700 bytes, and says only how long it is.
    const capped: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init)
      if (response.status !== 206) return response
      const bytes = new Uint8Array(await response.arrayBuffer()).slice(0, 700)
      return new Response(bytes, {
        status: 206,
        headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'audio/webm' },
      })
    }
    const result = await transfer(options({ fetch: capped }))
    expect(result.total).toBe(5000)
    expect(storage.bytes('a')).toEqual(file)
    expect(server.requests).toHaveLength(9)
  })

  it('takes an empty answer to the range after the last byte for the end', async () => {
    const { file, storage, options } = await setup(1000)
    const quiet: typeof fetch = async (_input, init) => {
      const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')
      const from = Number(range?.[1] ?? 0)
      const body = file.slice(from, Math.min(file.length, Number(range?.[2] ?? 0) + 1))
      return new Response(body, { status: 206, headers: { 'Content-Length': String(body.length) } })
    }
    expect((await transfer(options({ fetch: quiet }))).total).toBe(1000)
    expect(storage.bytes('a')).toEqual(file)
  })

  it('finds the end without Content-Range: a 416 right after the last byte', async () => {
    const { server, storage, options } = await setup(4096)
    server.rule(URL, { hideContentRange: true })
    const result = await transfer(options())
    expect(result.total).toBe(4096)
    expect(storage.bytes('a')).toHaveLength(4096)
    expect(server.rangesFor(URL)).toEqual(['bytes=0-2047', 'bytes=2048-4095', 'bytes=4096-6143'])
  })

  it('takes the whole file from a server that ignores the range, skipping stored bytes', async () => {
    const { server, file, storage, writer, options } = await setup()
    server.rule(URL, { ignoreRange: true })
    await writer.write(0, file.slice(0, 1000))
    const result = await transfer(options({ start: 1000 }))
    expect(result.total).toBe(5000)
    expect(storage.bytes('a')).toEqual(file)
    expect(server.requests).toHaveLength(1)
  })

  it('rejects with the storage error when a write fails', async () => {
    const { storage, options } = await setup(1000)
    storage.failNext('write', storageFullError())
    await expect(transfer(options())).rejects.toMatchObject({ name: 'QuotaExceededError' })
    // Also for a body that arrives without a stream.
    const plain = (async () =>
      Object.defineProperty(
        new Response(testBytes(10), { status: 206, headers: { 'Content-Range': 'bytes 0-9/10' } }),
        'body',
        { value: null },
      )) as typeof fetch
    storage.failNext('write', storageFullError())
    await expect(transfer(options({ fetch: plain }))).rejects.toMatchObject({
      name: 'QuotaExceededError',
    })
  })

  it('rejects an HTTP error with its status and Retry-After', async () => {
    const { server, options } = await setup()
    server.rule(URL, { status: 403 })
    await expect(transfer(options())).rejects.toMatchObject({
      name: 'DownloadHttpError',
      status: 403,
    })
    server.rule(URL, { status: 429, retryAfterSeconds: 7 })
    const error = await transfer(options()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DownloadHttpError)
    expect(error).toMatchObject({ status: 429, retryAfterMs: 7000 })
  })

  it('rejects a capped URL when its range reaches the cap', async () => {
    const { server, storage, options } = await setup()
    server.rule(URL, { capAt: 3000 })
    await expect(transfer(options())).rejects.toMatchObject({ status: 403 })
    // The first chunk ended before the cap.
    expect(storage.bytes('a')).toHaveLength(2048)
  })

  it('rejects a request without an answer as a network error of the request', async () => {
    const { server, options } = await setup()
    server.rule(URL, { dropRequests: 1 })
    const error = await transfer(options()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DownloadNetworkError)
    expect(error).toMatchObject({ phase: 'request' })
  })

  it('keeps the bytes of an answer that broke off, a network error of the body', async () => {
    const { server, file, storage, options } = await setup()
    server.rule(URL, { breakAt: 1500 })
    const error = await transfer(options()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DownloadNetworkError)
    expect(error).toMatchObject({ phase: 'body' })
    expect(storage.bytes('a')).toEqual(file.slice(0, 1500))
  })

  it('notices an answer that ends early without an error', async () => {
    const { options } = await setup()
    const short: typeof fetch = async () =>
      new Response(new Uint8Array(100), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-2047/5000', 'Content-Length': '2048' },
      })
    const error = await transfer(options({ fetch: short })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ message: expect.stringMatching(/broke off after 100 of 2048/) })
    expect(error).toMatchObject({ name: 'DownloadNetworkError', phase: 'body' })
  })

  it.each<[string, () => Response]>([
    [
      'a 416 that says the file is empty',
      () =>
        new Response(null, {
          status: 416,
          headers: { 'Content-Range': 'bytes */0' },
        }),
    ],
    [
      'an empty 200',
      () =>
        new Response(new Uint8Array(0), {
          status: 200,
          headers: { 'Content-Length': '0', 'Content-Type': 'audio/webm' },
        }),
    ],
    ['an empty 206 without a size', () => new Response(new Uint8Array(0), { status: 206 })],
  ])('refuses an empty file: %s', async (_label, answer) => {
    const { facts, options } = await setup()
    const empty: typeof fetch = async () => answer()
    await expect(transfer(options({ fetch: empty }))).rejects.toMatchObject({
      name: 'DownloadProtocolError',
      problem: 'not-media',
    })
    // An empty answer teaches nothing about the file.
    expect(facts).toEqual([])
  })

  it('never trusts a size of zero from an earlier answer', async () => {
    const { server, file, storage, options } = await setup(1000)
    expect((await transfer(options({ total: 0 }))).total).toBe(1000)
    expect(storage.bytes('a')).toEqual(file)
    expect(server.requests).toHaveLength(1)
  })

  it('refuses a file announced over the limit before reading it', async () => {
    const { server, storage, options } = await setup()
    await expect(transfer(options({ maxBytes: 4999 }))).rejects.toMatchObject({
      name: 'DownloadProtocolError',
      problem: 'too-large',
    })
    expect(storage.bytes('a')).toHaveLength(0)
    // Also when the server ignores the range and says the size with Content-Length.
    server.rule(URL, { ignoreRange: true })
    await expect(transfer(options({ maxBytes: 4999 }))).rejects.toMatchObject({
      problem: 'too-large',
    })
    expect(storage.bytes('a')).toHaveLength(0)
    // And a size an earlier answer told.
    await expect(transfer(options({ total: 5000, maxBytes: 4999 }))).rejects.toMatchObject({
      problem: 'too-large',
    })
    expect((await transfer(options({ maxBytes: 5000 }))).total).toBe(5000)
  })

  it.each<[string, Parameters<FakeMediaServer['rule']>[1]]>([
    ['in ranges', { hideContentRange: true, hideContentLength: true }],
    ['in one answer that ignores the range', { ignoreRange: true, hideContentLength: true }],
  ])('keeps nothing past the limit of a file whose size is hidden, %s', async (_label, rules) => {
    const { server, file, storage, options } = await setup()
    server.rule(URL, rules)
    await expect(transfer(options({ maxBytes: 3000 }))).rejects.toMatchObject({
      problem: 'too-large',
    })
    const stored = storage.bytes('a') ?? new Uint8Array(0)
    expect(stored.length).toBeLessThanOrEqual(3000)
    expect(stored).toEqual(file.slice(0, stored.length))
  })

  it("learns nothing from an error page's headers", async () => {
    const { facts, options } = await setup()
    const refused: typeof fetch = async () =>
      new Response('<html>Forbidden</html>', {
        status: 403,
        headers: { 'Content-Type': 'text/html', 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      })
    await expect(transfer(options({ fetch: refused }))).rejects.toMatchObject({ status: 403 })
    const page: typeof fetch = async () =>
      new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      })
    await expect(transfer(options({ fetch: page }))).rejects.toMatchObject({ problem: 'not-media' })
    expect(facts).toEqual([])
  })

  it('notices a file that changed on the server', async () => {
    const { options } = await setup()
    await expect(
      transfer(options({ validator: 'last-modified:Mon, 01 Jan 2024 00:00:00 GMT' })),
    ).rejects.toMatchObject({ problem: 'validator-changed' })
    // An ETag doesn't compare with a Last-Modified date.
    await transfer(options({ validator: 'etag:"abc"' }))
  })

  it('notices a file whose size changed', async () => {
    const { options } = await setup()
    await expect(transfer(options({ total: 6000 }))).rejects.toMatchObject({
      problem: 'size-changed',
    })
  })

  it('notices stored bytes beyond the end of the file', async () => {
    const { server, writer, options } = await setup()
    await writer.write(0, testBytes(6000))
    await expect(transfer(options({ start: 6000 }))).rejects.toMatchObject({
      problem: 'beyond-end',
    })
    await expect(transfer(options({ start: 6000, total: 5000 }))).rejects.toBeInstanceOf(
      DownloadProtocolError,
    )
    expect(server.requests).toHaveLength(1)
  })

  it('refuses a page instead of the file', async () => {
    const { server, options } = await setup()
    server.rule(URL, { page: true })
    await expect(transfer(options())).rejects.toMatchObject({ problem: 'not-media' })
  })

  it.each([
    'application/xml',
    'application/xhtml+xml',
    'text/xml; charset=utf-8',
    'application/problem+json',
    'application/json',
  ])('refuses an error body served as %s', async (type) => {
    const { options } = await setup()
    const answer: typeof fetch = async () =>
      new Response('<Error><Code>AccessDenied</Code></Error>', {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Range': 'bytes 0-39/40' },
      })
    await expect(transfer(options({ fetch: answer }))).rejects.toMatchObject({
      problem: 'not-media',
    })
  })

  it('refuses an answer with other bytes than asked for', async () => {
    const { options } = await setup()
    const wrong: typeof fetch = async () =>
      new Response(new Uint8Array(10), {
        status: 206,
        headers: { 'Content-Range': 'bytes 10-19/5000' },
      })
    await expect(transfer(options({ fetch: wrong }))).rejects.toMatchObject({
      problem: 'range-mismatch',
    })
  })

  it('stops when aborted, keeping what arrived', async () => {
    const { server, file, storage, options } = await setup()
    server.rule(URL, { holdAt: 1200 })
    const controller = new AbortController()
    const done = transfer(options({ signal: controller.signal }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort(new Error('paused'))
    await expect(done).rejects.toThrow('paused')
    expect(storage.bytes('a')).toEqual(file.slice(0, 1200))
    await expect(
      transfer(options({ signal: AbortSignal.abort(new Error('stopped')) })),
    ).rejects.toThrow('stopped')
  })

  it('reads a body without a stream', async () => {
    const { file, storage, options } = await setup(1000)
    const plain = (async () => {
      const response = new Response(file, {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-999/1000' },
      })
      return Object.defineProperty(response, 'body', { value: null })
    }) as typeof fetch
    expect((await transfer(options({ fetch: plain }))).total).toBe(1000)
    expect(storage.bytes('a')).toEqual(file)
  })

  it('needs a positive chunk size', async () => {
    const { options } = await setup()
    await expect(transfer(options({ chunkBytes: 0 }))).rejects.toBeInstanceOf(RangeError)
  })
})

describe('parseContentRange', () => {
  it.each([
    ['bytes 0-99/1000', { start: 0, end: 99, total: 1000 }],
    ['bytes 100-199/*', { start: 100, end: 199 }],
    ['bytes */1000', { total: 1000 }],
    ['  BYTES 5-5/6 ', { start: 5, end: 5, total: 6 }],
  ])('reads %s', (header, range) => {
    expect(parseContentRange(header)).toEqual(range)
  })

  it.each([null, '', 'bytes 9-1/10', 'bytes 0-10/10', 'items 0-1/2', 'bytes 0-1'])(
    'refuses %s',
    (header) => {
      expect(parseContentRange(header)).toBeUndefined()
    },
  )
})

describe('parseRetryAfter', () => {
  it('reads seconds and dates', () => {
    expect(parseRetryAfter('120')).toBe(120_000)
    const now = Date.UTC(2026, 9, 26)
    expect(parseRetryAfter('Mon, 26 Oct 2026 00:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('Sun, 25 Oct 2026 00:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
  })
})
