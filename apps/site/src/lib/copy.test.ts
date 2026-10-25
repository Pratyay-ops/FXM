import { describe, expect, it } from 'vitest'
import { comingSoon, joinList, unreleased } from './copy'

describe('joinList', () => {
  it('joins with commas and a final "and"', () => {
    expect(joinList([])).toBe('')
    expect(joinList(['a'])).toBe('a')
    expect(joinList(['a', 'b'])).toBe('a and b')
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c')
  })
})

describe('unreleased', () => {
  it('keeps the labels of features that are not out, in order', () => {
    expect(
      unreleased([
        [false, 'home feed'],
        [true, 'lyrics'],
        [false, 'downloads'],
      ]),
    ).toEqual(['home feed', 'downloads'])
    expect(unreleased([[true, 'lyrics']])).toEqual([])
  })
})

describe('comingSoon', () => {
  it('writes one sentence that agrees with the number of features', () => {
    expect(comingSoon(['a home feed'])).toBe('A home feed is coming soon.')
    expect(comingSoon(['a home feed', 'downloads'])).toBe(
      'A home feed and downloads are coming soon.',
    )
  })

  it('says nothing when everything is out', () => {
    expect(comingSoon([])).toBe('')
  })
})
