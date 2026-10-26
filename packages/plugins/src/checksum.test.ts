import { describe, expect, it } from 'vitest'
import { codeText, sha256Hex, utf8, verifyChecksum } from './checksum'
import { cleanText, isPluginError, PluginError } from './errors'

describe('checksums', () => {
  it('compute SHA-256 in lower-case hexadecimal', () => {
    // The SHA-256 of "abc" (FIPS 180-2, appendix B.1).
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('accept matching code as text or bytes, in any case, and refuse anything else', () => {
    const hash = sha256Hex(utf8('fxm.register({})'))
    expect(() => verifyChecksum('fxm.register({})', hash.toUpperCase())).not.toThrow()
    expect(() => verifyChecksum(utf8('fxm.register({})'), hash)).not.toThrow()
    let error: unknown
    try {
      verifyChecksum('fxm.register({ })', hash)
    } catch (caught) {
      error = caught
    }
    expect(isPluginError(error, 'checksum-mismatch')).toBe(true)
    expect(error).toMatchObject({ code: 'Parse' })
  })

  it('read code as UTF-8, keeping a byte order mark, and refuse other bytes', () => {
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
    expect(codeText(withMark)).toBe('\ufeffa')
    expect(utf8(codeText(withMark))).toEqual(withMark)
    expect(() => codeText(new Uint8Array([0xff, 0xfe]))).toThrow(PluginError)
  })
})

describe('plugin errors', () => {
  it('carry the FxmError code of their failure, or the one they are given', () => {
    expect(new PluginError('timeout', 'slow')).toMatchObject({
      code: 'Network',
      pluginCode: 'timeout',
    })
    expect(
      new PluginError('plugin-failed', 'gone', { code: 'NotFound', retryAfterMs: 5 }),
    ).toMatchObject({ code: 'NotFound', retryAfterMs: 5 })
    expect(isPluginError(new Error('x'))).toBe(false)
  })

  it('clean text from plugins for showing', () => {
    expect(cleanText('  a\u0000b\n\tc  ')).toBe('a b c')
    expect(cleanText('x'.repeat(10), 5)).toBe('xxxx…')
  })
})
