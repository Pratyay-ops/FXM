import { describe, expect, it } from 'vitest'
import { hotp, totp } from './totp'

/** The RFC 4226 and RFC 6238 test key for SHA-1: the ASCII bytes of "12345678901234567890". */
const KEY = new TextEncoder().encode('12345678901234567890')

describe('hotp (RFC 4226, Appendix D)', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ]

  for (const [counter, value] of expected.entries()) {
    it(`gives ${value} for counter ${counter}`, async () => {
      expect(await hotp(KEY, counter)).toBe(value)
    })
  }

  it('writes counters above 2^32 into the high word', async () => {
    expect(await hotp(KEY, 2 ** 32 + 1)).not.toBe(await hotp(KEY, 1))
  })

  it('refuses counters and digit counts outside the RFC', async () => {
    await expect(hotp(KEY, -1)).rejects.toThrow(RangeError)
    await expect(hotp(KEY, 1.5)).rejects.toThrow(RangeError)
    await expect(hotp(KEY, 0, 5)).rejects.toThrow(RangeError)
    await expect(hotp(KEY, 0, 9)).rejects.toThrow(RangeError)
  })
})

describe('totp (RFC 6238, Appendix B, SHA-1)', () => {
  const vectors: Array<[seconds: number, value: string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]

  for (const [seconds, value] of vectors) {
    it(`gives ${value} at T = ${seconds} s with 8 digits`, async () => {
      expect(await totp(KEY, seconds * 1000, { digits: 8 })).toBe(value)
    })

    it(`gives the last 6 digits at T = ${seconds} s by default`, async () => {
      expect(await totp(KEY, seconds * 1000)).toBe(value.slice(2))
    })
  }

  it('changes every 30 seconds and holds within a step', async () => {
    const start = 1_800_000_000_000
    expect(await totp(KEY, start + 29_999)).toBe(await totp(KEY, start))
    expect(await totp(KEY, start + 30_000)).not.toBe(await totp(KEY, start))
  })

  it('accepts another period', async () => {
    expect(await totp(KEY, 120_000, { periodSeconds: 60 })).toBe(await hotp(KEY, 2))
  })

  it('refuses a negative time or a bad period', async () => {
    await expect(totp(KEY, -1)).rejects.toThrow(RangeError)
    await expect(totp(KEY, Number.NaN)).rejects.toThrow(RangeError)
    await expect(totp(KEY, 0, { periodSeconds: 0 })).rejects.toThrow(RangeError)
  })
})
