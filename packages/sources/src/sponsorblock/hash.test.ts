import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HASH_PREFIX_LENGTH, hashPrefix, isVideoId, webCryptoSha256 } from './hash'

describe('hashPrefix', () => {
  it('is the first four hex characters of the SHA-256 of the videoId', async () => {
    // Checked with `printf %s <id> | shasum -a 256`.
    expect(await hashPrefix('sOnqjkJTMaA')).toBe('6db9')
    expect(await hashPrefix('dQw4w9WgXcQ')).toBe('5f6b')
    expect(HASH_PREFIX_LENGTH).toBe(4)
  })

  it('pads bytes below 16 with a zero', async () => {
    const digest = async () => new Uint8Array([0x0a, 0x03, 0xff, 0xff]).buffer
    expect(await hashPrefix('anything', digest)).toBe('0a03')
  })

  it('hashes the videoId as UTF-8 and nothing else', async () => {
    const seen: string[] = []
    const digest = async (data: Uint8Array<ArrayBuffer>) => {
      seen.push(new TextDecoder().decode(data))
      return new ArrayBuffer(32)
    }
    await hashPrefix('fxmVideoAAA', digest)
    expect(seen).toEqual(['fxmVideoAAA'])
  })
})

describe('webCryptoSha256', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses with Unsupported where Web Crypto is missing, as outside secure contexts', async () => {
    vi.stubGlobal('crypto', {})
    const error = await webCryptoSha256(new Uint8Array(1)).catch((reason: unknown) => reason)
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })
})

describe('isVideoId', () => {
  it('accepts 11 characters of the URL-safe base64 alphabet', () => {
    expect(isVideoId('dQw4w9WgXcQ')).toBe(true)
    expect(isVideoId('iJgP-XiUaa_')).toBe(true)
  })

  it('refuses anything else', () => {
    for (const value of [
      '',
      'dQw4w9WgXc',
      'dQw4w9WgXcQQ',
      'dQw4w9WgXc!',
      'dQw4w9 gXcQ',
      42,
      null,
    ]) {
      expect(isVideoId(value)).toBe(false)
    }
  })
})
