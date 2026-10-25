import { describe, expect, it } from 'vitest'
import { contextFor, fakeService, hangingFetch } from '../shared/fake-fetch'
import { FLAC_HEADER_BYTES, parseFlacStreamInfo, probeFlac } from './flac'

/** Bytes from hex. */
function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16))
}

/** The first 42 bytes of two real files, recorded on 2026-10-25. */
const ARCHIVE_24BIT = bytes(
  '664c61430000002210001000000012004b460ac443700ea41f88f521ab47258d5bc7282502c456665d5b',
)
const JAMENDO_16BIT = bytes(
  '664c614300000022120012000003010039890ac442f000b70840f4d71a342b3d86c5d4672e7d4dea3633',
)

describe('parseFlacStreamInfo', () => {
  it('reads a 24-bit Internet Archive file', () => {
    expect(parseFlacStreamInfo(ARCHIVE_24BIT)).toEqual({
      sampleRateHz: 44100,
      channels: 2,
      bitDepth: 24,
      totalSamples: 245_637_000,
    })
  })

  it('reads a 16-bit Jamendo file', () => {
    const info = parseFlacStreamInfo(JAMENDO_16BIT)
    expect(info).toEqual({
      sampleRateHz: 44100,
      channels: 2,
      bitDepth: 16,
      totalSamples: 11_995_200,
    })
    expect((info?.totalSamples ?? 0) / (info?.sampleRateHz ?? 1)).toBeCloseTo(272, 0)
  })

  it('reads sample counts above 32 bits', () => {
    const big = Uint8Array.from(ARCHIVE_24BIT)
    big[21] = 0x71
    expect(parseFlacStreamInfo(big)?.totalSamples).toBe(2 ** 32 + 245_637_000)
  })

  it('refuses bytes that are not the start of a FLAC file', () => {
    const id3 = Uint8Array.from(ARCHIVE_24BIT)
    id3.set([0x49, 0x44, 0x33], 0)
    const otherBlock = Uint8Array.from(ARCHIVE_24BIT)
    otherBlock[4] = 0x04
    const zeroRate = Uint8Array.from(ARCHIVE_24BIT)
    zeroRate.fill(0, 18, 21)
    for (const input of [
      ARCHIVE_24BIT.slice(0, 41),
      id3,
      otherBlock,
      zeroRate,
      new Uint8Array(42),
    ]) {
      expect(parseFlacStreamInfo(input)).toBeNull()
    }
  })
})

describe('probeFlac', () => {
  it('asks for the first 42 bytes only and reads them', async () => {
    const service = fakeService(
      () =>
        new Response(ARCHIVE_24BIT, { status: 206, headers: { 'content-range': 'bytes 0-41/9' } }),
    )
    const info = await probeFlac(
      contextFor(service.fetch),
      'https://archive.org/download/x/a.flac',
      1000,
    )
    expect(info?.bitDepth).toBe(24)
    expect(service.calls[0]?.headers.get('range')).toBe(`bytes=0-${FLAC_HEADER_BYTES - 1}`)
    expect([...(service.calls[0]?.headers.keys() ?? [])]).toEqual(['range'])
    expect(service.calls[0]?.init?.credentials).toBe('omit')
  })

  it('cancels a whole file sent instead of the range, without reading it', async () => {
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const service = fakeService(() => new Response(body, { status: 200 }))
    await expect(
      probeFlac(contextFor(service.fetch), 'https://x.test/a.flac', 1000),
    ).resolves.toBeNull()
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThanOrEqual(1)
  })

  it('gives up quietly on errors and timeouts', async () => {
    const failing = fakeService(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(
      probeFlac(contextFor(failing.fetch), 'https://x.test/a.flac', 1000),
    ).resolves.toBeNull()
    const notFound = fakeService(() => new Response('gone', { status: 404 }))
    await expect(
      probeFlac(contextFor(notFound.fetch), 'https://x.test/a.flac', 1000),
    ).resolves.toBeNull()
    await expect(
      probeFlac(contextFor(hangingFetch), 'https://x.test/a.flac', 10),
    ).resolves.toBeNull()
  })

  it('passes on the caller’s cancellation', async () => {
    const controller = new AbortController()
    const probe = probeFlac(
      contextFor(hangingFetch, { signal: controller.signal }),
      'https://x.test/a.flac',
      1000,
    )
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(probe).rejects.toBe(reason)
  })
})
