import { describe, expect, it } from 'vitest'
import { isMbid, normalizeMbid, requireMbid } from './mbid'

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'

describe('isMbid', () => {
  it('accepts canonical MusicBrainz IDs only', () => {
    expect(isMbid(RADIOHEAD)).toBe(true)
    expect(isMbid(RADIOHEAD.toUpperCase())).toBe(false)
    expect(isMbid(`${RADIOHEAD}x`)).toBe(false)
    expect(isMbid(42)).toBe(false)
  })
})

describe('normalizeMbid', () => {
  it('trims and lower-cases an MBID, and refuses anything else', () => {
    expect(normalizeMbid(` ${RADIOHEAD.toUpperCase()} `)).toBe(RADIOHEAD)
    expect(normalizeMbid('a74b1b7f71a540119441d0b5e4122711')).toBeUndefined()
    expect(normalizeMbid('../release/x')).toBeUndefined()
    expect(normalizeMbid(null)).toBeUndefined()
  })
})

describe('requireMbid', () => {
  it('returns the canonical MBID, or throws a RangeError', () => {
    expect(requireMbid(RADIOHEAD.toUpperCase())).toBe(RADIOHEAD)
    expect(() => requireMbid('radiohead')).toThrowError(RangeError)
    expect(() => requireMbid('x'.repeat(500))).toThrowError(/^Not a MusicBrainz ID: x{64}$/u)
  })
})
