import { describe, expect, it } from 'vitest'
import {
  checkMediaRead,
  isLocalMediaUrl,
  isMediaReadable,
  type MediaReadabilityContext,
} from './readable'

const ORIGIN = 'https://fxmusic.pages.dev'
const CONNECT: MediaReadabilityContext = { platform: 'web', capabilities: { mediaBytes: true } }
const LITE: MediaReadabilityContext = { platform: 'web', capabilities: { mediaBytes: false } }
const DESKTOP: MediaReadabilityContext = { platform: 'desktop', capabilities: { mediaBytes: true } }
const ANDROID: MediaReadabilityContext = { platform: 'android', capabilities: { mediaBytes: true } }

const readable = (url: string, context: MediaReadabilityContext) =>
  isMediaReadable({ url }, context, ORIGIN)

describe('isLocalMediaUrl', () => {
  it('takes blob:, data: and same-origin URLs', () => {
    expect(isLocalMediaUrl('blob:https://fxmusic.pages.dev/1234', ORIGIN)).toBe(true)
    expect(isLocalMediaUrl('data:audio/wav;base64,UklGRg==', ORIGIN)).toBe(true)
    expect(isLocalMediaUrl('/app/sound.mp3', ORIGIN)).toBe(true)
    expect(isLocalMediaUrl('https://fxmusic.pages.dev/x.flac', ORIGIN)).toBe(true)
  })

  it('refuses other origins, and everything without an origin', () => {
    expect(isLocalMediaUrl('https://example.com/x.mp3', ORIGIN)).toBe(false)
    expect(isLocalMediaUrl('http://fxmusic.pages.dev/x.mp3', ORIGIN)).toBe(false)
    expect(isLocalMediaUrl('/x.mp3', 'null')).toBe(false)
    expect(isLocalMediaUrl('https://[::1', ORIGIN)).toBe(false)
  })

  it('reads the page origin by default', () => {
    expect(isLocalMediaUrl(`${globalThis.location.origin}/a.mp3`)).toBe(true)
  })
})

describe('isMediaReadable', () => {
  const googlevideo = 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=251'

  it('reads googlevideo only through FXM Connect in a browser', () => {
    expect(readable(googlevideo, CONNECT)).toBe(true)
    expect(readable(googlevideo, LITE)).toBe(false)
    expect(readable(googlevideo, DESKTOP)).toBe(false)
    expect(readable(googlevideo, ANDROID)).toBe(false)
  })

  it('reads Internet Archive and Jamendo everywhere', () => {
    for (const context of [CONNECT, LITE, DESKTOP]) {
      expect(readable('https://archive.org/download/item/01.flac', context)).toBe(true)
      expect(readable('https://ia800300.us.archive.org/1/items/item/01.flac', context)).toBe(true)
      expect(
        readable('https://prod-1.storage.jamendo.com/?trackid=1848357&format=flac', context),
      ).toBe(true)
    }
  })

  it('reads local URLs everywhere', () => {
    expect(readable('blob:https://fxmusic.pages.dev/5', LITE)).toBe(true)
    expect(readable('blob:tauri://localhost/5', DESKTOP)).toBe(true)
  })

  it('treats unknown hosts, plain HTTP and credentials as opaque', () => {
    expect(readable('https://invidious.example/latest_version?id=x', CONNECT)).toBe(false)
    expect(readable('http://archive.org/download/item/01.flac', CONNECT)).toBe(false)
    expect(readable('https://user:pw@archive.org/download/item/01.flac', CONNECT)).toBe(false)
    expect(readable('https://archive.org.evil.example/01.flac', CONNECT)).toBe(false)
    expect(readable('https://notjamendo.com/01.mp3', CONNECT)).toBe(false)
    expect(readable('ftp://archive.org/01.flac', CONNECT)).toBe(false)
    expect(readable('https://[::1', CONNECT)).toBe(false)
  })
})

describe('checkMediaRead', () => {
  const URL_ = 'https://rr1---sn-test.googlevideo.com/videoplayback?id=a'

  /** A fetch that answers each request with `answer(redirect mode)`, recording what it got. */
  function fakeFetch(answer: (redirect: RequestRedirect | undefined) => Promise<Response>) {
    const calls: RequestInit[] = []
    const fetch = (_url: string, init: RequestInit) => {
      calls.push(init)
      return answer(init.redirect)
    }
    return { fetch, calls }
  }

  /** What a browser gives for a redirect fetched with `redirect: 'manual'`. */
  function opaqueRedirect(): Response {
    const response = new Response(null, { status: 200 })
    Object.defineProperty(response, 'type', { value: 'opaqueredirect' })
    Object.defineProperty(response, 'status', { value: 0 })
    return response
  }

  const refused = () => Promise.reject(new TypeError('Failed to fetch'))

  it('says readable when the bytes come, with one ranged request and no credentials', async () => {
    const { fetch, calls } = fakeFetch(async () => new Response('x', { status: 206 }))
    expect(await checkMediaRead(URL_, { fetch })).toEqual({ verdict: 'readable', status: 206 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
    })
  })

  it('tells a refused read after a redirect from a refused read', async () => {
    const redirected = fakeFetch((redirect) =>
      redirect === 'manual' ? Promise.resolve(opaqueRedirect()) : refused(),
    )
    expect(await checkMediaRead(URL_, { fetch: redirected.fetch })).toEqual({
      verdict: 'redirected',
    })
    expect(redirected.calls.map((init) => init.redirect)).toEqual(['follow', 'manual'])

    const blocked = fakeFetch(refused)
    expect(await checkMediaRead(URL_, { fetch: blocked.fetch })).toEqual({ verdict: 'refused' })
  })

  it('says readable when only the second try reads it', async () => {
    const { fetch } = fakeFetch((redirect) =>
      redirect === 'manual' ? Promise.resolve(new Response('x', { status: 206 })) : refused(),
    )
    expect(await checkMediaRead(URL_, { fetch })).toEqual({ verdict: 'readable', status: 206 })
  })

  it('gives up on a request that never answers, and says so', async () => {
    const stalled = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    expect(await checkMediaRead(URL_, { fetch: stalled, timeoutMs: 20 })).toEqual({
      verdict: 'timed-out',
    })
  })

  it('says failed when the request could not be sent, and passes on a cancellation', async () => {
    const closed = fakeFetch(() => Promise.reject(new Error('No route to googlevideo here')))
    expect(await checkMediaRead(URL_, { fetch: closed.fetch })).toEqual({ verdict: 'failed' })

    const controller = new AbortController()
    const cancelled = fakeFetch(() => {
      controller.abort(new Error('stopped'))
      return refused()
    })
    await expect(
      checkMediaRead(URL_, { fetch: cancelled.fetch, signal: controller.signal }),
    ).rejects.toThrow('stopped')
  })
})
