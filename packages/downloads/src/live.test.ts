/**
 * Live checks of the ranged transfer against Internet Archive: a 198,658-byte public-domain test
 * file, fetched twice in 64 KiB ranges (9 requests, each redirected once to a storage host).
 * They run only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/downloads/src/live.test.ts
 * ```
 *
 * The second run hides the headers a browser hides from a page when the server doesn't expose
 * them (`Content-Range`, `ETag`; measured 2026-10-26, see CLEAN-ROOM.md), so it finds the end
 * of the file from the server's `416` to the range after it, as it must in a browser.
 */

import { describe, expect, it } from 'vitest'
import { createMemoryDownloadStorage } from './storage'
import { transfer } from './transfer'

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

const URL = 'https://archive.org/download/testmp3testfile/mpthreetest.mp3'
const SIZE = 198_658

/** Node's `fetch`, hiding the response headers a browser hides from a page without CORS exposure. */
const browserLike: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  const headers = new Headers()
  for (const name of ['content-length', 'content-type', 'last-modified']) {
    const value = response.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(response.body, { status: response.status, headers })
}

describe.skipIf(!live)('ranged transfer, live', { timeout: 60_000 }, () => {
  it('downloads an Internet Archive file in single ranges, with or without Content-Range', async () => {
    const storage = createMemoryDownloadStorage()
    const results = []
    for (const [file, fetcher] of [
      ['plain', fetch],
      ['browser-like', browserLike],
    ] as const) {
      const writer = await storage.open(file)
      results.push(
        await transfer({
          fetch: fetcher,
          url: URL,
          writer,
          start: 0,
          chunkBytes: 64 * 1024,
          signal: AbortSignal.timeout(50_000),
        }),
      )
      await writer.close()
    }
    expect(results.map((result) => result.total)).toEqual([SIZE, SIZE])
    expect(results[0]?.validator).toMatch(/^last-modified:/)
    const plain = storage.bytes('plain')
    expect(plain).toHaveLength(SIZE)
    expect(storage.bytes('browser-like')).toEqual(plain)
    // An MP3 file: an ID3 tag or a frame sync at the start.
    const head = plain?.slice(0, 3) ?? new Uint8Array(0)
    expect(
      String.fromCharCode(...head) === 'ID3' ||
        (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0),
    ).toBe(true)
  })
})
