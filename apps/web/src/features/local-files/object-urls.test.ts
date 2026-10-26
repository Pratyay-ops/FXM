import { describe, expect, it } from 'vitest'
import { fakeObjectUrls } from './testing'

const blob = new Blob(['x'])

describe('ObjectUrlCache', () => {
  it('makes one URL per key', () => {
    const { urls, created } = fakeObjectUrls()
    expect(urls.urlFor('a', blob)).toBe(urls.urlFor('a', blob))
    expect(urls.urlFor('b', blob)).not.toBe(urls.urlFor('a', blob))
    expect(created).toHaveLength(2)
  })

  it('revokes the least recently used URL past its capacity', () => {
    const { urls, revoked } = fakeObjectUrls(2)
    const a = urls.urlFor('a', blob)
    const b = urls.urlFor('b', blob)
    urls.urlFor('a', blob)
    urls.urlFor('c', blob)
    expect(revoked).toEqual([b])
    expect(urls.size).toBe(2)
    expect(urls.urlFor('a', blob)).toBe(a)
  })

  it('revokes every URL when cleared', () => {
    const { urls, revoked } = fakeObjectUrls()
    const a = urls.urlFor('a', blob)
    const b = urls.urlFor('b', blob)
    urls.clear()
    expect(revoked).toEqual([a, b])
    expect(urls.size).toBe(0)
  })
})
