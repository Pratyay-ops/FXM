import { describe, expect, it } from 'vitest'
import { decodePng, encodePng } from './png.ts'

describe('png', () => {
  const image = {
    width: 2,
    height: 2,
    rgba: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255]),
  }

  it('decodes what it encodes', () => {
    const png = encodePng(image)
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(decodePng(png)).toEqual(image)
  })

  it('refuses mismatched sizes and other files', () => {
    expect(() => encodePng({ ...image, width: 3 })).toThrow('does not match')
    expect(() => decodePng(Buffer.from('not a png'))).toThrow('not a PNG')
  })
})
