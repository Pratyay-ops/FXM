import { describe, expect, it, vi } from 'vitest'
import { cookieSafeFetch } from './youtube-music.ts'

describe('cookieSafeFetch', () => {
  it('strips the raw Cookie header, omits ambient credentials and keeps derived auth headers', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
    )
    const safeFetch = cookieSafeFetch(fetcher)
    await safeFetch('https://music.youtube.com/youtubei/v1/browse', {
      method: 'POST',
      headers: {
        Cookie: 'SAPISID=secret-cookie',
        Authorization: 'SAPISIDHASH 123_abcd',
        'Content-Type': 'application/json',
      },
      credentials: 'include',
    })
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://music.youtube.com/youtubei/v1/browse')
    expect(init?.credentials).toBe('omit')
    const headers = new Headers(init?.headers)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.get('authorization')).toBe('SAPISIDHASH 123_abcd')
  })
})
