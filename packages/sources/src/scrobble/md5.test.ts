import { describe, expect, it } from 'vitest'
import { md5, md5Hex } from './md5'

describe('md5Hex', () => {
  it('passes the test suite of RFC 1321 (appendix A.5)', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex('a')).toBe('0cc175b9c0f1b6a831c399e269772661')
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0')
    expect(md5Hex('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b')
    expect(md5Hex('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'd174ab98d277d9f5a5611c2c9f419d9f',
    )
    expect(md5Hex('1234567890'.repeat(8))).toBe('57edf4a22be3c955ac49da2e2107b67a')
  })

  it('pads correctly around the block boundaries', () => {
    // Computed with macOS's md5(1). 55 bytes fit one block with the length; 56 need two.
    const cases: [number, string][] = [
      [55, '04364420e25c512fd958a70738aa8f72'],
      [56, '668a72d5ba17f08e62dabcafad6db14b'],
      [63, '7dc2ca208106a2f703567bdff99d8981'],
      [64, 'c1bb4f81d892b2d57947682aeb252456'],
      [65, '1bc932052302d074bdec39795fe00cf6'],
      [119, 'ab347a5f68c8a443cfcddc633f12c24f'],
      [120, 'fb98667f98096de92620b64f46e1c5b5'],
    ]
    for (const [length, digest] of cases) expect(md5Hex('x'.repeat(length))).toBe(digest)
  })

  it('hashes the UTF-8 bytes of text in any script', () => {
    expect(md5Hex('Björk – Jóga 日本語 🎵')).toBe('bc4067f51fa3912da7a730567ba60ee8')
  })

  it("gives the signature of the example in Last.fm's authentication spec", () => {
    expect(md5Hex('api_keyxxxxxxxxxxmethodauth.getSessiontokenyyyyyyilovecher')).toBe(
      'b87d61da3cda91a8b6746c4aef55d6f8',
    )
  })
})

describe('md5', () => {
  it('returns the 16 raw bytes of the digest', () => {
    const digest = md5(new Uint8Array([0x61, 0x62, 0x63]))
    expect(digest).toHaveLength(16)
    expect(Array.from(digest.slice(0, 4))).toEqual([0x90, 0x01, 0x50, 0x98])
  })
})
