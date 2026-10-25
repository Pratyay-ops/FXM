import { describe, expect, it } from 'vitest'
import { artistAffinityKey, tagAffinityKey } from './keys'

describe('artistAffinityKey', () => {
  it.each([
    ['Radiohead', 'radiohead'],
    ['  The   Beatles ', 'the beatles'],
    ['Beyoncé', 'beyonce'],
    ['BEYONCE', 'beyonce'],
    ['Mø', 'mo'],
    ['宇多田ヒカル', '宇多田ヒカル'],
    ['AC/DC', 'ac/dc'],
  ])('keys %j as %j', (name, key) => {
    expect(artistAffinityKey(name)).toBe(key)
  })

  it.each([
    '',
    '   ',
    'Various Artists',
    'VARIOUS ARTISTS',
    'Unknown Artist',
    'unknown',
    '[unknown]',
    '<Unknown>',
    'x'.repeat(201),
  ])('gives no key for %j', (name) => {
    expect(artistAffinityKey(name)).toBeUndefined()
  })

  it('gives no key for a value that is not a string', () => {
    expect(artistAffinityKey(42 as unknown as string)).toBeUndefined()
    expect(artistAffinityKey(undefined as unknown as string)).toBeUndefined()
  })
})

describe('tagAffinityKey', () => {
  it.each(['Hip-Hop', 'hip hop', 'HIP_HOP', 'hip/hop', ' hip -  hop '])(
    'keys %j as "hip hop"',
    (tag) => {
      expect(tagAffinityKey(tag)).toBe('hip hop')
    },
  )

  it('keeps other punctuation and other scripts', () => {
    expect(tagAffinityKey('R&B')).toBe('r&b')
    expect(tagAffinityKey('Électro')).toBe('electro')
    expect(tagAffinityKey('ボカロ')).toBe('ボカロ')
  })

  it.each(['', ' - ', 'x'.repeat(65)])('gives no key for %j', (tag) => {
    expect(tagAffinityKey(tag)).toBeUndefined()
  })

  it('gives no key for a value that is not a string', () => {
    expect(tagAffinityKey(null as unknown as string)).toBeUndefined()
  })
})
