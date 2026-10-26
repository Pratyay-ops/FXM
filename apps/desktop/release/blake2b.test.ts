import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { blake2b } from './blake2b.ts'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('blake2b', () => {
  it('gives the RFC 7693 test vector for "abc"', () => {
    expect(hex(blake2b(Buffer.from('abc'), 64))).toBe(
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
        '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    )
  })

  it('gives the known BLAKE2b-256 hashes, which minisign checks secret keys with', () => {
    expect(hex(blake2b(new Uint8Array(), 32))).toBe(
      '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8',
    )
    expect(hex(blake2b(Buffer.from('abc'), 32))).toBe(
      'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
    )
  })

  it('agrees with Node’s BLAKE2b-512 at every length around the block size', () => {
    for (let length = 0; length <= 300; length++) {
      const data = randomBytes(length)
      expect(hex(blake2b(data, 64)), `${length} bytes`).toBe(
        createHash('blake2b512').update(data).digest('hex'),
      )
    }
  })

  it('is no cut-off longer hash: the length is part of the parameters', () => {
    const data = Buffer.from('FXM')
    expect(hex(blake2b(data, 32))).not.toBe(hex(blake2b(data, 64).subarray(0, 32)))
  })

  it('refuses lengths BLAKE2b doesn’t have', () => {
    for (const length of [0, 65, 1.5]) {
      expect(() => blake2b(new Uint8Array(), length)).toThrow(RangeError)
    }
  })
})
