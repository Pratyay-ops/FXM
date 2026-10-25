import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFetch, jsonResponse, testContext, textResponse } from '../recommend/testing'
import {
  COVER_ART_ARCHIVE_ORIGIN,
  type CoverArtOptions,
  coverArtUrl,
  createCoverArtClient,
  parseCoverArt,
} from './api'
import pabloHoney from './fixtures/release-pablo-honey.json'

const PABLO_HONEY = '07aab296-9a40-42a9-8d1f-6b06aa032e8a'

afterEach(() => {
  vi.useRealTimers()
})

/** A client in front of a fake archive, and the requests it made. */
function setup(route: (url: URL) => Response | Promise<Response>, options: CoverArtOptions = {}) {
  const { fetch, calls } = fakeFetch(route)
  return { client: createCoverArtClient(options), ctx: testContext({ fetch, tier: 'free' }), calls }
}

/** The error a promise rejects with. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('expected a rejection'),
    (error: unknown) => error,
  )
}

describe('coverArtUrl', () => {
  it('moves the archive’s own URLs to https', () => {
    expect(coverArtUrl('http://coverartarchive.org/release/x/1-250.jpg')).toBe(
      'https://coverartarchive.org/release/x/1-250.jpg',
    )
    expect(coverArtUrl('https://ia800505.us.archive.org/x.jpg')).toBe(
      'https://ia800505.us.archive.org/x.jpg',
    )
    expect(coverArtUrl('https://archive.org/download/x.jpg')).toBe(
      'https://archive.org/download/x.jpg',
    )
  })

  it('refuses anything else', () => {
    for (const url of [
      'https://evil.example/x.jpg',
      'https://coverartarchive.org.evil.example/x.jpg',
      'javascript:alert(1)',
      'https://user:pw@coverartarchive.org/x.jpg',
      'https://coverartarchive.org:8443/x.jpg',
      'not a url',
      42,
    ]) {
      expect(coverArtUrl(url)).toBeUndefined()
    }
  })
})

describe('parseCoverArt', () => {
  it('reads the front cover’s thumbnails from the recorded listing', () => {
    expect(parseCoverArt(pabloHoney)).toEqual([
      {
        url: `https://coverartarchive.org/release/${PABLO_HONEY}/4203359815-250.jpg`,
        width: 250,
      },
      {
        url: `https://coverartarchive.org/release/${PABLO_HONEY}/4203359815-500.jpg`,
        width: 500,
      },
      {
        url: `https://coverartarchive.org/release/${PABLO_HONEY}/4203359815-1200.jpg`,
        width: 1200,
      },
    ])
  })

  it('prefers an approved front, falls back to the size aliases, and finds none without one', () => {
    const image = (approved: boolean, thumbnails: Record<string, string>, types = ['Front']) => ({
      approved,
      types,
      thumbnails,
    })
    expect(
      parseCoverArt({
        images: [
          image(false, { '250': 'http://coverartarchive.org/a-250.jpg' }),
          image(true, {
            small: 'http://coverartarchive.org/b-250.jpg',
            large: 'https://evil.example/b.jpg',
          }),
        ],
      }),
    ).toEqual([{ url: 'https://coverartarchive.org/b-250.jpg', width: 250 }])
    expect(parseCoverArt({ images: [image(true, { '250': 'x' }, ['Back'])] })).toEqual([])
    expect(parseCoverArt({ images: [] })).toEqual([])
  })

  it('rejects a listing without images', () => {
    expect(() => parseCoverArt({ release: 'x' })).toThrowError(
      expect.objectContaining({ code: 'Parse' }),
    )
  })
})

describe('createCoverArtClient', () => {
  it('asks the archive for a release and caches what it found', async () => {
    const { client, ctx, calls } = setup(() => jsonResponse(pabloHoney))
    const artwork = await client.releaseArtwork(PABLO_HONEY, ctx)
    expect(artwork).toHaveLength(3)
    expect(await client.releaseArtwork(PABLO_HONEY, ctx)).toEqual(artwork)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.href).toBe(`${COVER_ART_ARCHIVE_ORIGIN}/release/${PABLO_HONEY}`)
    expect(calls[0]?.init?.credentials).toBe('omit')
  })

  it('finds nothing, without a request, for a value that is not an MBID', async () => {
    const { client, ctx, calls } = setup(() => jsonResponse(pabloHoney))
    expect(await client.releaseArtwork('../release/x', ctx)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('remembers a release without art for a while', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const { client, ctx, calls } = setup(
      () => textResponse('<p>No cover art found</p>', { status: 404 }),
      { missTtlMs: 60_000 },
    )
    expect(await client.releaseArtwork(PABLO_HONEY, ctx)).toEqual([])
    expect(await client.releaseArtwork(PABLO_HONEY, ctx)).toEqual([])
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await client.releaseArtwork(PABLO_HONEY, ctx)
    expect(calls).toHaveLength(2)
  })

  it('treats a 400 as no art', async () => {
    const { client, ctx } = setup(() => textResponse('invalid MBID', { status: 400 }))
    expect(await client.releaseArtwork(PABLO_HONEY, ctx)).toEqual([])
  })

  it('backs off on 429 and 503', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    for (const status of [429, 503]) {
      const { client, ctx, calls } = setup(() =>
        textResponse('slow down', { status, headers: { 'retry-after': '3' } }),
      )
      const error = await failure(client.releaseArtwork(PABLO_HONEY, ctx))
      expect(isFxmError(error, 'RateLimited')).toBe(true)
      expect(
        isFxmError(await failure(client.releaseArtwork(PABLO_HONEY, ctx)), 'RateLimited'),
      ).toBe(true)
      expect(calls).toHaveLength(1)
    }
  })

  it('reports other errors as Unavailable and broken JSON as Parse', async () => {
    const server = setup(() => textResponse('oops', { status: 500 }))
    expect(
      isFxmError(
        await failure(server.client.releaseArtwork(PABLO_HONEY, server.ctx)),
        'Unavailable',
      ),
    ).toBe(true)
    const broken = setup(() => textResponse('{"images":', { contentType: 'application/json' }))
    expect(
      isFxmError(await failure(broken.client.releaseArtwork(PABLO_HONEY, broken.ctx)), 'Parse'),
    ).toBe(true)
  })
})
