import { afterEach, describe, expect, it, vi } from 'vitest'
import { SPLIT_PAGE_TTL_MS, SPLIT_PAGES_KEPT, SplitPages, slicePage } from './catalog'

describe('slicing a YouTube page by a limit', () => {
  const items = ['a', 'b', 'c', 'd', 'e']

  it('goes on in the same page, then with the next one, and loses nothing', () => {
    expect(slicePage(items, 0, 2, 'next', undefined)).toEqual({
      items: ['a', 'b'],
      next: { offset: 2 },
    })
    expect(slicePage(items, 2, 2, 'next', 'this')).toEqual({
      items: ['c', 'd'],
      next: { offset: 4, continuation: 'this' },
    })
    expect(slicePage(items, 4, 2, 'next', 'this')).toEqual({
      items: ['e'],
      next: { continuation: 'next' },
    })
    expect(slicePage(items, 0, undefined, undefined, undefined)).toEqual({ items })
  })
})

describe('split pages', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keep the most recently used pages', () => {
    const pages = new SplitPages<number>()
    for (let page = 0; page <= SPLIT_PAGES_KEPT; page++) pages.set(`page ${page}`, page)
    expect(pages.get('page 0')).toBeUndefined()
    expect(pages.get('page 1')).toBe(1)
    pages.set('one more', -1)
    expect(pages.get('page 1')).toBe(1)
    expect(pages.get('page 2')).toBeUndefined()
  })

  it('keep a page for a while after it was read', () => {
    vi.useFakeTimers()
    const pages = new SplitPages<string>()
    pages.set('page', 'kept')
    vi.setSystemTime(Date.now() + SPLIT_PAGE_TTL_MS)
    expect(pages.get('page')).toBe('kept')
    vi.setSystemTime(Date.now() + 1)
    expect(pages.get('page')).toBeUndefined()
  })
})
