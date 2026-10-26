import type { ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { context, FULL, fakeInnerTube } from '../fixtures/testing'
import {
  type FakeGoogleVideoOptions,
  fakeGoogleVideo,
  PLAYER_FIXTURES,
  PROBE_FIXTURES,
} from './fixtures/testing'
import { PROBE_BYTES, type ProbeOptions, probeEndOfFile } from './probe'

type Format = { itag: number; url: string; contentLength?: string }

/** The URL of a format in a recorded `/player` fixture, and the probe's options for it. */
function format(name: keyof typeof PLAYER_FIXTURES, itag: number) {
  const streaming = (
    PLAYER_FIXTURES[name] as unknown as { streamingData: Record<string, Format[]> }
  ).streamingData
  const found = [...(streaming.formats ?? []), ...(streaming.adaptiveFormats ?? [])].find(
    (entry) => entry.itag === itag,
  ) as Format
  const options: ProbeOptions =
    found.contentLength === undefined
      ? { timeoutMs: 1000 }
      : { timeoutMs: 1000, contentLength: Number(found.contentLength) }
  return { url: found.url, options }
}

function setup(options: FakeGoogleVideoOptions = {}) {
  const fake = fakeInnerTube(fakeGoogleVideo(options))
  return { ...fake, ctx: context(fake.fetch, { capabilities: FULL }) }
}

const ANSWERS = PROBE_FIXTURES.answers

describe('the end-of-file probe', () => {
  it('verifies a VISIONOS URL from its last 64 KiB, with one CORS-safelisted range', async () => {
    const { ctx, requests } = setup()
    const { url, options } = format('visionos-song', 251)
    const result = await probeEndOfFile(ctx, url, options)
    expect(result).toEqual({ fullLength: 'verified', contentLength: 4_034_850, detail: '206' })
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request?.method).toBe('GET')
    expect(request?.headers.get('range')).toBe(ANSWERS['visionos-251-end'].range)
    expect([...(request?.headers.keys() ?? [])]).toEqual(['range'])
    expect(request?.credentials).toBe('omit')
  })

  it('finds a capped IOS URL capped: googlevideo refuses its end with 403', async () => {
    const { ctx, requests } = setup()
    const { url, options } = format('ios-song', 140)
    const result = await probeEndOfFile(ctx, url, options)
    expect(result).toEqual({ fullLength: 'capped', contentLength: 3_865_089, detail: 'HTTP 403' })
    expect(requests[0]?.headers.get('range')).toBe(ANSWERS['ios-140-end'].range)
  })

  it('learns the length of an itag 18 file from its first byte, then probes its end', async () => {
    const { ctx, requests } = setup()
    const { url } = format('android-song', 18)
    const result = await probeEndOfFile(ctx, url, { timeoutMs: 1000 })
    expect(result).toEqual({ fullLength: 'verified', contentLength: 4_757_394, detail: '206' })
    expect(requests.map((request) => request.headers.get('range'))).toEqual([
      'bytes=0-0',
      ANSWERS['android-18-end'].range,
    ])
  })

  it('finds a URL capped when it refuses even its first byte', async () => {
    const { ctx } = setup({ answer: () => new Response(null, { status: 403 }) })
    const { url } = format('android-song', 18)
    expect(await probeEndOfFile(ctx, url, { timeoutMs: 1000 })).toEqual({
      fullLength: 'capped',
      detail: 'HTTP 403',
    })
  })

  it('reads a whole small file', async () => {
    const { ctx, requests } = setup()
    const { url } = format('visionos-song', 139)
    const small = new URL(url)
    small.searchParams.set('clen', '1000')
    const result = await probeEndOfFile(ctx, small.href, { timeoutMs: 1000, contentLength: 1000 })
    expect(result.fullLength).toBe('verified')
    expect(requests[0]?.headers.get('range')).toBe('bytes=0-999')
  })

  it('cannot tell when the answer is not the requested range in full', async () => {
    const { url, options } = format('visionos-song', 140)
    const cases: [NonNullable<FakeGoogleVideoOptions['answer']>, string][] = [
      [() => new Response(new Uint8Array(10), { status: 200 }), 'HTTP 200'],
      [() => new Response(null, { status: 416 }), 'HTTP 416'],
      [() => new Response(null, { status: 503 }), 'HTTP 503'],
      [
        ({ length }) =>
          new Response(new Uint8Array(PROBE_BYTES), {
            status: 206,
            headers: { 'content-range': `bytes 0-${PROBE_BYTES - 1}/${length}` },
          }),
        'another range',
      ],
      [() => new Response(new Uint8Array(100), { status: 206 }), '100 bytes'],
    ]
    for (const [answer, detail] of cases) {
      const { ctx } = setup({ answer })
      expect(await probeEndOfFile(ctx, url, options)).toEqual({
        fullLength: 'unverified',
        contentLength: 3_865_089,
        detail,
      })
    }
  })

  it('verifies the bytes when the range headers are not exposed', async () => {
    const { url, options } = format('visionos-song', 140)
    const { ctx } = setup({
      answer: ({ first, last }) => new Response(new Uint8Array(last - first + 1), { status: 206 }),
    })
    const result = await probeEndOfFile(ctx, url, options)
    expect(result.fullLength).toBe('verified')
  })

  it('cannot tell the length of an itag 18 file without a readable Content-Range', async () => {
    const { url } = format('android-song', 18)
    const { ctx } = setup({ answer: () => new Response(new Uint8Array(1), { status: 206 }) })
    expect(await probeEndOfFile(ctx, url, { timeoutMs: 1000 })).toEqual({
      fullLength: 'unverified',
      detail: 'HTTP 206 without a length',
    })
  })

  it('cannot tell after a network failure, such as CORS after a redirect, or a timeout', async () => {
    const { url, options } = format('visionos-song', 140)
    const refused: ProviderContext = context(
      () => Promise.reject(new TypeError('Failed to fetch')),
      { capabilities: FULL },
    )
    expect(await probeEndOfFile(refused, url, options)).toEqual({
      fullLength: 'unverified',
      contentLength: 3_865_089,
      detail: 'network error',
    })
    const slow: ProviderContext = context(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
      { capabilities: FULL },
    )
    expect(await probeEndOfFile(slow, url, { ...options, timeoutMs: 5 })).toMatchObject({
      fullLength: 'unverified',
      detail: 'timed out',
    })
  })

  it("passes on the caller's cancellation", async () => {
    const { url, options } = format('visionos-song', 140)
    const controller = new AbortController()
    const reason = new Error('skipped')
    const ctx = context(
      () => {
        controller.abort(reason)
        return Promise.reject(reason)
      },
      { capabilities: FULL, signal: controller.signal },
    )
    await expect(probeEndOfFile(ctx, url, options)).rejects.toBe(reason)
  })
})
