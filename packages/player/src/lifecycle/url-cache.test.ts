import { describe, expect, it } from 'vitest'
import { testStream } from '../testing/fixtures'
import { resolutionKey, UrlCache } from './url-cache'

const options = [testStream('a')]

describe('resolutionKey', () => {
  it('keys by network, channel, audio and rung, with one key per YouTube video', () => {
    const key = resolutionKey('net', 'ytm', { source: 'ytm', ref: 'x' }, 'top')
    expect(key).toBe(resolutionKey('net', 'ytm', { source: 'yt', ref: 'x' }, 'top'))
    expect(key).not.toBe(resolutionKey('other', 'ytm', { source: 'ytm', ref: 'x' }, 'top'))
    expect(key).not.toBe(resolutionKey('net', 'invidious', { source: 'ytm', ref: 'x' }, 'top'))
    expect(key).not.toBe(resolutionKey('net', 'ytm', { source: 'ytm', ref: 'x' }, 'fallback'))
  })
})

describe('UrlCache', () => {
  it('hands an entry out until its usable time, then drops it', () => {
    const cache = new UrlCache()
    cache.set('k', { options, resolvedAt: 0, usableUntil: 100 })
    expect(cache.get('k', 99)?.options).toBe(options)
    expect(cache.size).toBe(1)
    expect(cache.get('k', 100)).toBeUndefined()
    expect(cache.size).toBe(0)
    expect(cache.get('missing', 0)).toBeUndefined()
  })

  it('refuses empty and already unusable resolutions', () => {
    const cache = new UrlCache()
    cache.set('empty', { options: [], resolvedAt: 0, usableUntil: 100 })
    cache.set('stale', { options, resolvedAt: 100, usableUntil: 100 })
    expect(cache.size).toBe(0)
  })

  it('pushes out stale entries, then the oldest, past its size', () => {
    const cache = new UrlCache(2)
    cache.set('stale', { options, resolvedAt: 0, usableUntil: 10 })
    cache.set('old', { options, resolvedAt: 0, usableUntil: 100 })
    cache.set('new', { options, resolvedAt: 20, usableUntil: 100 })
    expect(cache.size).toBe(2)
    expect(cache.get('old', 20)).toBeDefined()
    cache.set('newer', { options, resolvedAt: 30, usableUntil: 100 })
    expect(cache.get('old', 30)).toBeUndefined()
    expect(cache.get('new', 30)).toBeDefined()
    expect(cache.get('newer', 30)).toBeDefined()
    expect(new UrlCache(0).size).toBe(0)
  })

  it('deletes one entry or all of them', () => {
    const cache = new UrlCache()
    cache.set('a', { options, resolvedAt: 0, usableUntil: 100 })
    cache.set('b', { options, resolvedAt: 0, usableUntil: 100 })
    expect(cache.delete('a')).toBe(true)
    expect(cache.delete('a')).toBe(false)
    expect(cache.clear()).toBe(1)
    expect(cache.clear()).toBe(0)
  })
})
